/**
 * VLMM proxy on Cloudflare Workers — OpenRouter + BigModel (GLM-4.5V)
 *  - POST /v1/vision/analyze  (JSON or multipart/form-data)
 *  - POST /v1/vision/stream   (SSE passthrough)
 *  - GET  /healthz
 *
 * Changes in this version:
 *  - Added provider "bigmodel" with model "glm-4.5v" via https://open.bigmodel.cn/api/paas/v4/chat/completions
 *  - Unified payload builder for vision (text + image_url / data URL)
 *  - Provider switch: body.provider | URL ?provider= | default → "bigmodel"
 */

export interface Env {
  OPENROUTER_API_KEY?: string;  // optional if you use only BigModel
  BIGMODEL_API_KEY: string;      // wrangler secret put BIGMODEL_API_KEY
  DEFAULT_MODEL?: string;        // e.g. "glm-4.5v" (BigModel) or any OpenRouter model
  ALLOWED_ORIGINS?: string;      // comma-separated list
  APP_URL?: string;              // (OpenRouter attribution) Referer
  APP_TITLE?: string;            // (OpenRouter attribution) X-Title
}

// ---- Utilities -------------------------------------------------------------

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
];

function corsHeadersFor(req: Request, env: Env, extra: Record<string, string> = {}) {
  const origin = req.headers.get("Origin") || "";
  const allowed = new Set<string>(
    (env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(/,\s*/) : DEFAULT_ALLOWED_ORIGINS)
  );
  const headers: Record<string, string> = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    ...extra,
  };
  if (origin && allowed.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function jsonResponse(req: Request, env: Env, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeadersFor(req, env) },
  });
}

async function fileToDataURL(file: File): Promise<{url: string; mime: string}> {
  const mime = file.type || "image/jpeg";
  const buf = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  const b64 = btoa(binary);
  return { url: `data:${mime};base64,${b64}` , mime };
}

function getQueryFlag(url: URL, name: string): boolean | undefined {
  const v = url.searchParams.get(name);
  if (v === null) return undefined;
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return undefined;
}

// ---- Input parsing ---------------------------------------------------------

type AnalyzeInput = {
  provider?: "bigmodel" | "openrouter";
  model?: string;
  prompt?: string;
  image_url?: string;           // http(s) or data URL
  image_base64?: string;        // raw base64 without data: prefix
  detail?: "low" | "high" | "auto";
  stream?: boolean;
  thinking?: "enabled" | "disabled"; // BigModel-specific switch
  images?: string[];            // optional multiple images (urls or data URLs)
};

async function parseAnalyzePayload(req: Request): Promise<AnalyzeInput> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    const prompt = (form.get("prompt") || "") as string;
    const model = (form.get("model") || "") as string;
    const provider = (form.get("provider") || "") as string;
    const detail = (form.get("detail") || "auto") as AnalyzeInput["detail"];
    const thinking = (form.get("thinking") || "") as AnalyzeInput["thinking"];

    let image_url = (form.get("image_url") || "") as string;
    let image_base64 = (form.get("image_base64") || "") as string;

    if (!image_url && !image_base64 && file instanceof File) {
      const { url } = await fileToDataURL(file);
      image_url = url;
    }

    return { provider: provider as any, model, prompt, image_url, image_base64, detail, thinking };
  }

  // JSON
  const body = (await req.json().catch(() => ({}))) as AnalyzeInput;
  return body;
}

// Build OpenAI-style multi-modal message for both providers
function buildMessages(input: AnalyzeInput) {
  const content: any[] = [];

  const pushImage = (url: string) => {
    if (!url) return;
    content.push({ type: "image_url", image_url: { url, ...(input.detail ? { detail: input.detail } : {}) } });
  };

  if (Array.isArray(input.images) && input.images.length) {
    input.images.forEach(pushImage);
  } else {
    if (input.image_url) pushImage(input.image_url);
    else if (input.image_base64) pushImage(`data:image/jpeg;base64,${input.image_base64}`);
  }

  if (input.prompt && input.prompt.trim()) {
    content.push({ type: "text", text: input.prompt });
  }

  // If no content, enforce at least a default text
  if (!content.length) content.push({ type: "text", text: "Describe the image briefly." });

  return [{ role: "user", content }];
}

// ---- Providers -------------------------------------------------------------

async function callBigModel(env: Env, payload: any, stream = false) {
  const url = new URL("https://open.bigmodel.cn/api/paas/v4/chat/completions");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.BIGMODEL_API_KEY}`,
    "Content-Type": "application/json",
  };
  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify({ ...payload, stream }),
  };
  return fetch(url.toString(), init);
}

async function callOpenRouter(env: Env, payload: any, stream = false) {
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");
  const url = new URL("https://openrouter.ai/api/v1/chat/completions");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (env.APP_URL) headers["HTTP-Referer"] = env.APP_URL;
  if (env.APP_TITLE) headers["X-Title"] = env.APP_TITLE;

  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify({ ...payload, stream }),
  };
  return fetch(url.toString(), init);
}

function providerFrom(input: AnalyzeInput, url: URL): "bigmodel" | "openrouter" {
  const p = input.provider || (url.searchParams.get("provider") as any);
  return p === "openrouter" ? "openrouter" : "bigmodel"; // default BigModel
}

function modelFrom(input: AnalyzeInput, env: Env, provider: string): string {
  if (input.model && input.model.trim()) return input.model;
  if (env.DEFAULT_MODEL && env.DEFAULT_MODEL.trim()) return env.DEFAULT_MODEL;
  return provider === "openrouter" ? "qwen/qwen2.5-vl-72b-instruct" : "glm-4.5v";
}

// ---- Worker routes ---------------------------------------------------------

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeadersFor(req, env) });
    }

    if (url.pathname === "/healthz") {
      return new Response("ok", { headers: corsHeadersFor(req, env) });
    }

    if ((url.pathname === "/v1/vision/analyze" || url.pathname === "/v1/vision/stream") && req.method === "POST") {
      try {
        const input = await parseAnalyzePayload(req);
        const provider = providerFrom(input, url);
        const model = modelFrom(input, env, provider);
        const stream = url.pathname.endsWith("/stream") || !!input.stream || getQueryFlag(url, "stream") === true;

        const messages = buildMessages(input);
        const payload: any = { model, messages };

        // BigModel-specific: thinking switch
        if (provider === "bigmodel") {
          if (input.thinking === "enabled") payload.thinking = { type: "enabled" };
          if (input.thinking === "disabled") payload.thinking = { type: "disabled" };
        }

        const upstream = provider === "openrouter"
          ? await callOpenRouter(env, payload, stream)
          : await callBigModel(env, payload, stream);

        if (stream) {
          // SSE passthrough
          // Ensure CORS + proper content-type
          const headers = new Headers(upstream.headers);
          headers.set("content-type", "text/event-stream; charset=utf-8");
          for (const [k, v] of Object.entries(corsHeadersFor(req, env))) headers.set(k, v);
          return new Response(upstream.body, { status: upstream.status, headers });
        }

        // Non-stream JSON
        const data = await upstream.json();
        const headers = corsHeadersFor(req, env);
        return new Response(JSON.stringify(data), { status: upstream.status, headers: { "content-type": "application/json", ...headers } });
      } catch (e: any) {
        return jsonResponse(req, env, { error: e?.message || "Bad Request" }, 400);
      }
    }

    return jsonResponse(req, env, { error: "Not Found" }, 404);
  },
};
