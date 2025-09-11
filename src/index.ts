/**
 * VLMM proxy on Cloudflare Workers — OpenRouter + BigModel (GLM-4.5V)
 * Minimal update: add **our own progress SSE** when `stream=true` while keeping
 * passthrough of provider SSE intact. This is designed for the use‑case
 * "one image per request" where upstream gives few/no internal phases.
 *
 * Routes
 *  - POST /v1/vision/analyze  (JSON or multipart/form-data)
 *    • with body.stream=true or ?stream=1 -> SSE with early progress events
 *  - POST /v1/vision/stream   (alias of analyze with stream=true)
 *  - GET  /healthz
 */

export interface Env {
  // API keys
  OPENROUTER_API_KEY?: string;           // optional if using only BigModel
  BIGMODEL_API_KEY?: string;             // optional if using only OpenRouter

  // Defaults & attribution
  DEFAULT_MODEL?: string;                // e.g. "glm-4.5v" or any OpenRouter model
  APP_URL?: string;                      // Referer for OpenRouter attribution
  APP_TITLE?: string;                    // X-Title for OpenRouter attribution

  // CORS
  ALLOWED_ORIGINS?: string;              // comma-separated list

  // Progress tuning (all optional)
  PROGRESS_TTFB_P50_MS?: string;         // median time to first byte (headers) from upstream
  PROGRESS_TOTAL_P50_MS?: string;        // median total time for one-image request
  PROGRESS_TAIL_MAX?: string;            // e.g. "0.99" — progress ceiling before real completion
  STREAM_HEARTBEAT_MS?: string;          // heartbeat frequency in ms
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3333",
  "http://localhost:5173",
];

function corsHeadersFor(req: Request, env: Env, extra: Record<string, string> = {}) {
  const origin = req.headers.get("Origin") || "";
  const allowed = new Set<string>([
    ...DEFAULT_ALLOWED_ORIGINS,
    ...(env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean) : []),
    ...(env.APP_URL ? [env.APP_URL] : []),
  ]);
  const headers: Record<string,string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Content-Security-Policy": "default-src 'none'",
    ...extra,
  };
  if (origin && allowed.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function jsonResponse(req: Request, env: Env, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeadersFor(req, env),
    },
  });
}

function getQueryFlag(url: URL, name: string) {
  const v = url.searchParams.get(name);
  if (v == null) return undefined;
  if (v === "" || v === "1" || v.toLowerCase() === "true") return true;
  if (v === "0" || v.toLowerCase() === "false") return false;
  return undefined;
}

function pickProvider(provider?: string) {
  if (!provider) return "bigmodel"; // default
  return provider === "openrouter" ? "openrouter" : "bigmodel";
}

function defaultModelFor(env: Env, provider: "openrouter" | "bigmodel") {
  if (env.DEFAULT_MODEL && env.DEFAULT_MODEL.trim()) return env.DEFAULT_MODEL.trim();
  return provider === "openrouter" ? "qwen/qwen2.5-vl-72b-instruct" : "glm-4.5v";
}

// ---------------------------------------------------------------------------
// Input parsing for /v1/vision/analyze
// ---------------------------------------------------------------------------

type AnalyzeInput = {
  provider?: "bigmodel" | "openrouter";
  model?: string;
  prompt?: string;
  image_url?: string;             // http(s) or data URL
  image_base64?: string;          // raw base64 (without data: prefix)
  detail?: "low" | "high" | "auto";
  stream?: boolean;
  thinking?: "enabled" | "disabled" | { type: "enabled" | "disabled" }; // BigModel-specific
  images?: string[];              // optional multiple images
};

async function parseAnalyzePayload(req: Request): Promise<AnalyzeInput> {
  const ctype = req.headers.get("content-type") || "";
  if (ctype.includes("application/json")) {
    return (await req.json()) as AnalyzeInput;
  }
  if (ctype.includes("multipart/form-data")) {
    const fd = await req.formData();
    const out: any = {};
    for (const [k, v] of fd.entries()) {
      if (typeof v === "string") out[k] = v;
    }
    // normalize types
    if (out.stream != null) out.stream = String(out.stream).toLowerCase() !== "false";
    if (out.images && typeof out.images === "string") {
      try { out.images = JSON.parse(out.images); } catch {}
    }
    return out as AnalyzeInput;
  }
  // default
  try { return (await req.json()) as AnalyzeInput; } catch { return {}; }
}

// ---------------------------------------------------------------------------
// Payload builder (OpenAI Chat API compatible messages)
// ---------------------------------------------------------------------------

function buildVisionPayload(input: AnalyzeInput, provider: "openrouter" | "bigmodel", env: Env) {
  const model = input.model?.trim() || defaultModelFor(env, provider);
  const content: any[] = [];
  if (input.prompt) content.push({ type: "text", text: input.prompt });

  const images: string[] = [];
  if (input.image_url) images.push(input.image_url);
  if (input.image_base64) images.push(`data:image/png;base64,${input.image_base64}`);
  if (Array.isArray(input.images)) images.push(...input.images);

  for (const url of images) {
    content.push({ type: "image_url", image_url: { url } });
  }

  const messages = [{ role: "user", content }];
  const payload: any = { model, messages };
  // BigModel требует объект { type: "enabled" | "disabled" } в поле thinking
  if (provider === "bigmodel") {
    const t: any = (input as any).thinking;
    if (t === "enabled" || t === "disabled") {
      payload.thinking = { type: t };
    } else if (t && typeof t === "object" && typeof t.type === "string") {
      payload.thinking = { type: t.type };
    }
    // если thinking невалидный или отсутствует — просто не добавляем поле
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Upstream callers
// ---------------------------------------------------------------------------

async function callBigModel(env: Env, payload: any, stream = false) {
  const url = new URL("https://open.bigmodel.cn/api/paas/v4/chat/completions");
  const headers: Record<string,string> = {
    "content-type": "application/json",
  };
  const token = env.BIGMODEL_API_KEY?.trim();
  if (token) headers["authorization"] = `Bearer ${token}`;

  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify({ ...payload, stream }),
  };
  return fetch(url.toString(), init);
}

async function callOpenRouter(env: Env, payload: any, stream = false) {
  const url = new URL("https://openrouter.ai/api/v1/chat/completions");
  const headers: Record<string,string> = {
    "content-type": "application/json",
  };
  const token = env.OPENROUTER_API_KEY?.trim();
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (env.APP_URL) headers["HTTP-Referer"] = env.APP_URL;
  if (env.APP_TITLE) headers["X-Title"] = env.APP_TITLE;

  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify({ ...payload, stream }),
  };
  return fetch(url.toString(), init);
}

// ---------------------------------------------------------------------------
// SSE helpers (our progress + passthrough upstream)
// ---------------------------------------------------------------------------

function sseLine(type: string | null, data: any, id?: string) {
  let out = "";
  if (id) out += `id: ${id}\n`;
  if (type) out += `event: ${type}\n`;
  out += `data: ${JSON.stringify(data)}\n\n`;
  return out;
}

function nowMs() { return Date.now(); }

function parseNumber(v: string | undefined, fallback: number) {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// Create a Response that emits our progress events, then pipes the upstream SSE as-is.
async function progressWrappedSSE(req: Request, env: Env, upstreamPromise: Promise<Response>) {
  const started = nowMs();
  const TTFB = parseNumber(env.PROGRESS_TTFB_P50_MS, 600);
  const TOTAL = parseNumber(env.PROGRESS_TOTAL_P50_MS, 3500);
  const TAIL_MAX = Math.max(0.9, Math.min(0.999, parseNumber(env.PROGRESS_TAIL_MAX, 0.99)));
  const HEARTBEAT_MS = Math.max(3000, parseNumber(env.STREAM_HEARTBEAT_MS, 7000));

  let progress = 0; // 0..1
  let lastEmit = 0;
  let hbTimer: number | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Emit early phases we control entirely
      controller.enqueue(new TextEncoder().encode(sseLine("progress", { percent: 5, phase: "queued" })));
      controller.enqueue(new TextEncoder().encode(sseLine("progress", { percent: 10, phase: "selecting_provider" })));

      // Start upstream fetch
      const up = await upstreamPromise;
      const headersReceivedAt = nowMs();
      progress = Math.max(progress, 0.35); // headers -> jump to ~35%
      controller.enqueue(new TextEncoder().encode(sseLine("progress", {
        percent: Math.round(progress * 1000)/10,
        phase: "headers_received",
        ttfbMs: headersReceivedAt - started,
        status: up.status,
      })));

      // Heartbeat (keeps connection alive)
      hbTimer = (setInterval as any)(() => {
        controller.enqueue(new TextEncoder().encode(sseLine("heartbeat", { ts: nowMs() })));
      }, HEARTBEAT_MS);

      // While we are waiting for upstream body end, push a gentle time-based growth up to tail
      const softTicker = (setInterval as any)(() => {
        const elapsed = nowMs() - started;
        const est = Math.max(TOTAL, 1200);
        const target = Math.min(TAIL_MAX, elapsed / est);
        if (target > progress + 0.02 && target <= TAIL_MAX) {
          progress = target;
          const pct = Math.round(progress * 1000)/10;
          // throttle emits to ~200ms min interval
          if (nowMs() - lastEmit > 200) {
            lastEmit = nowMs();
            controller.enqueue(new TextEncoder().encode(sseLine("progress", { percent: pct, phase: "upstream_wait" })));
          }
        }
      }, 250);

      // Passthrough upstream SSE bytes as-is (to keep compatibility with clients parsing provider format)
      if (!up.body) {
        clearInterval(softTicker); if (hbTimer) clearInterval(hbTimer);
        controller.enqueue(new TextEncoder().encode(sseLine("error", { code: "NO_UPSTREAM_BODY" })));
        controller.close();
        return;
      }

      const reader = up.body.getReader();
      const encoder = new TextEncoder();
      const pushDone = async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value);
          }
        } catch (e) {
          controller.enqueue(encoder.encode(sseLine("error", { code: "UPSTREAM_READ", message: (e as Error).message })));
        }
      };

      await pushDone();

      // Finish with our tail & complete
      clearInterval(softTicker); if (hbTimer) clearInterval(hbTimer);
      progress = 1;
      controller.enqueue(encoder.encode(sseLine("progress", { percent: 99, phase: "finalize" })));
      controller.enqueue(encoder.encode(sseLine("complete", { finishedAt: nowMs(), elapsedMs: nowMs() - started })));
      controller.close();
    },
  });

  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
    ...corsHeadersFor(req, env),
  });
  return new Response(stream, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Worker routes
// ---------------------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeadersFor(req, env) });
    }

    if (url.pathname === "/healthz") {
      return jsonResponse(req, env, { ok: true, ts: Date.now() });
    }

    if ((url.pathname === "/v1/vision/analyze" || url.pathname === "/v1/vision/stream") && req.method === "POST") {
      try {
        const input = await parseAnalyzePayload(req);
        const provider = pickProvider(input.provider);
        const streamFlag = url.pathname.endsWith("/stream") || !!input.stream || getQueryFlag(url, "stream") === true;
        const payload = buildVisionPayload(input, provider, env);

        const upstreamPromise = provider === "openrouter"
          ? callOpenRouter(env, payload, streamFlag)
          : callBigModel(env, payload, streamFlag);

        if (streamFlag) {
          // Our SSE with early progress, then passthrough upstream SSE
          return progressWrappedSSE(req, env, upstreamPromise);
        }

        // Non-stream JSON
        const upstream = await upstreamPromise;
        const json = await upstream.json().catch(() => null);
        const headers = corsHeadersFor(req, env);
        return new Response(JSON.stringify(json ?? { error: "bad upstream json" }), {
          status: upstream.status,
          headers: { "content-type": "application/json; charset=utf-8", ...headers },
        });
      } catch (e: any) {
        return jsonResponse(req, env, { error: e?.message || "Bad Request" }, 400);
      }
    }

    return jsonResponse(req, env, { error: "Not Found" }, 404);
  },
};
