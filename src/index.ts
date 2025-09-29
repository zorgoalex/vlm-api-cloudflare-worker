import { OPENAPI_YAML } from './openapi';

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

  // Prompts storage (D1 + KV)
  vlm_api_db: D1Database;                // D1 binding name from wrangler.jsonc
  PROMPT_CACHE: KVNamespace;             // KV cache for prompts
  ADMIN_TOKEN?: string;                  // admin token for write operations
  ENABLE_SCHEMA_BOOTSTRAP?: string;      // '1' to allow auto-DDL in dev/test
  // Optional read auth (disabled by default)
  REQUIRE_READ_AUTH?: string;            // '1' to require read auth
  READ_BEARER_TOKEN?: string;            // Bearer token for GET endpoints
  // Rate limiting & anti-replay (disabled by default)
  WRITE_RL_LIMIT?: string;               // e.g. '20' requests
  WRITE_RL_WINDOW_SEC?: string;          // e.g. '60' seconds window
  ENABLE_NONCE_REQUIRED_FOR_WRITE?: string; // '1' to require X-Nonce on writes
  NONCE_TTL_SEC?: string;                // e.g. '300'
  // R2 backups
  BACKUPS?: R2Bucket;                    // R2 bucket binding for backups
  BACKUP_PREFIX?: string;                // e.g. 'd1-backups/'

  // Regex cleanup config (tiny tweak)
  VLM_CONFIG?: KVNamespace;              // optional KV for config
  ENABLE_REGEX_CONFIG?: string;          // '1' to expose config via /about
  REGEX_CLEANUP_PATTERN?: string;        // optional secret/env fallback
  REGEX_CLEANUP_FLAGS?: string;          // optional secret/env fallback
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Token, X-Nonce",
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

function generateRequestId() {
  // lightweight request id
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${Date.now().toString(36)}-${rnd}`;
}

function errorResponse(req: Request, env: Env, opts: { code: string; message: string; status?: number; details?: any }, requestId?: string) {
  const rid = requestId || generateRequestId();
  const body = { error: opts.message, code: opts.code, request_id: rid, ...(opts.details ? { details: opts.details } : {}) };
  return new Response(JSON.stringify(body), {
    status: opts.status ?? 400,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": rid,
      ...corsHeadersFor(req, env),
    },
  });
}

function logInfo(fields: Record<string, unknown>) {
  try { console.log(JSON.stringify({ level: 'info', ts: Date.now(), ...fields })); } catch { /* noop */ }
}
function logWarn(fields: Record<string, unknown>) {
  try { console.warn(JSON.stringify({ level: 'warn', ts: Date.now(), ...fields })); } catch { /* noop */ }
}
function logError(fields: Record<string, unknown>) {
  try { console.error(JSON.stringify({ level: 'error', ts: Date.now(), ...fields })); } catch { /* noop */ }
}

// ---------------------------------------------------------------------------
// Regex cleanup config helpers (KV -> Secrets -> Default) with in‑memory cache
// ---------------------------------------------------------------------------

type RegexConfig = { pattern: string; flags: string; source: 'kv' | 'secret' | 'default'; updated_at: string };
const REGEX_KV_PATTERN_KEY = 'vision:regex:pattern';
const REGEX_KV_FLAGS_KEY = 'vision:regex:flags';
let regexConfigCache: { value: RegexConfig; exp: number } | null = null;

async function readRegexConfig(env: Env, ttlSec = 180): Promise<RegexConfig> {
  const now = Date.now();
  if (regexConfigCache && regexConfigCache.exp > now) return regexConfigCache.value;

  let pattern: string | null = null;
  let flags: string | null = null;
  let source: 'kv' | 'secret' | 'default' = 'default';

  try {
    if (env.VLM_CONFIG) {
      const [p, f] = await Promise.all([
        env.VLM_CONFIG.get(REGEX_KV_PATTERN_KEY),
        env.VLM_CONFIG.get(REGEX_KV_FLAGS_KEY),
      ]);
      if (p || f) {
        pattern = p ?? null;
        flags = f ?? null;
        source = 'kv';
      }
    }
  } catch { /* ignore KV read errors */ }

  if (source === 'default') {
    if (env.REGEX_CLEANUP_PATTERN || env.REGEX_CLEANUP_FLAGS) {
      pattern = env.REGEX_CLEANUP_PATTERN ?? pattern;
      flags = env.REGEX_CLEANUP_FLAGS ?? flags;
      source = 'secret';
    }
  } else {
    // If KV provided only one of values, try to fill from secrets
    if (!pattern && env.REGEX_CLEANUP_PATTERN) pattern = env.REGEX_CLEANUP_PATTERN;
    if (!flags && env.REGEX_CLEANUP_FLAGS) flags = env.REGEX_CLEANUP_FLAGS;
  }

  if (!pattern) pattern = "^(?:System|Meta|Debug|SSE|Event|Disclaimer)\\s*:.*$";
  if (!flags) flags = "gmi";
  if (source === 'default' && (env.REGEX_CLEANUP_PATTERN || env.REGEX_CLEANUP_FLAGS)) source = 'secret';

  // Validate quietly
  try { /* eslint-disable no-new */ new RegExp(pattern, flags); } catch { /* return as-is */ }

  const value: RegexConfig = { pattern, flags, source, updated_at: new Date().toISOString() };
  regexConfigCache = { value, exp: now + Math.max(60, ttlSec) * 1000 };
  return value;
}

// ---------------------------------------------------------------------------
// D1 + KV (Prompts) helpers
// ---------------------------------------------------------------------------

const promptsKVKeyList    = (ns: string, lang?: string, act?: string) => `list:${ns}:${lang ?? "*"}:${act ?? "*"}`;
const promptsKVKeyById    = (id: number) => `id:${id}`;
const promptsKVKeyDefault = (ns: string, lang: string) => `default:${ns}:${lang}`;

const mapPromptRow = (r: any) => ({
  id: r.prompt_id,
  namespace: r.prompt_namespace,
  name: r.prompt_name,
  version: r.prompt_version,
  lang: r.prompt_lang,
  text: r.prompt_text,
  tags: (() => { try { return JSON.parse(r.prompt_tags || "[]"); } catch { return []; } })(),
  priority: typeof r.prompt_priority === 'number' ? r.prompt_priority : 0,
  is_active: r.prompt_is_active,
  is_default: r.prompt_is_default,
  created_at: r.prompt_created_at,
  updated_at: r.prompt_updated_at,
});

let schemaReady = false;
async function ensurePromptsSchema(env: Env) {
  if (env.ENABLE_SCHEMA_BOOTSTRAP !== '1') return; // only in dev/test
  if (schemaReady) return;
  // Best‑effort create schema for ephemeral test/dev environments
  // Ensure core table first (no swallow)
  await env.vlm_api_db.prepare(`CREATE TABLE IF NOT EXISTS prompts (
      prompt_id          INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt_namespace   TEXT NOT NULL DEFAULT 'default',
      prompt_name        TEXT NOT NULL,
      prompt_version     INTEGER NOT NULL DEFAULT 1,
      prompt_lang        TEXT NOT NULL DEFAULT 'ru',
      prompt_text        TEXT NOT NULL,
      prompt_tags        TEXT NOT NULL DEFAULT '[]',
      prompt_priority    INTEGER NOT NULL DEFAULT 0,
      prompt_is_active   INTEGER NOT NULL DEFAULT 1,
      prompt_is_default  INTEGER NOT NULL DEFAULT 0,
      prompt_created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      prompt_updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );`).run();
  const stmts = [
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_prompts_ns_name_ver
       ON prompts(prompt_namespace, prompt_name, prompt_version);`,
    `CREATE INDEX IF NOT EXISTS ix_prompts_ns               ON prompts(prompt_namespace);`,
    `CREATE INDEX IF NOT EXISTS ix_prompts_lang             ON prompts(prompt_lang);`,
    `CREATE INDEX IF NOT EXISTS ix_prompts_active           ON prompts(prompt_is_active);`,
    `CREATE INDEX IF NOT EXISTS ix_prompts_ns_lang_active   ON prompts(prompt_namespace, prompt_lang, prompt_is_active);`,
    `CREATE INDEX IF NOT EXISTS ix_prompts_default          ON prompts(prompt_namespace, prompt_lang, prompt_is_default);`,
    `CREATE TRIGGER IF NOT EXISTS trg_prompts_updated_at
       AFTER UPDATE ON prompts
       FOR EACH ROW BEGIN
         UPDATE prompts SET prompt_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE prompt_id = NEW.prompt_id;
       END;`
  ];
  for (const sql of stmts) {
    await env.vlm_api_db.prepare(sql).run().catch(() => undefined);
  }
  // Best-effort add new columns for forward-compat
  await env.vlm_api_db.prepare(`ALTER TABLE prompts ADD COLUMN prompt_priority INTEGER NOT NULL DEFAULT 0`).run().catch(() => undefined);
  schemaReady = true;
}

// ---------------------------------------------------------------------------
// Security helpers (optional)
// ---------------------------------------------------------------------------

function requireReadAuth(env: Env): boolean {
  return env.REQUIRE_READ_AUTH === '1' && !!(env.READ_BEARER_TOKEN && env.READ_BEARER_TOKEN.trim());
}

function verifyReadAuth(req: Request, env: Env): Response | null {
  if (!requireReadAuth(env)) return null;
  const auth = req.headers.get('authorization') || req.headers.get('Authorization') || '';
  const ok = auth.startsWith('Bearer ') && auth.slice(7).trim() === (env.READ_BEARER_TOKEN || '').trim();
  if (!ok) return errorResponse(req, env, { code: 'UNAUTHORIZED', message: 'unauthorized', status: 401 });
  return null;
}

function parseIntEnv(v: string | undefined, d: number) {
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : d;
}

async function rateLimitWrite(req: Request, env: Env, routeKey: string): Promise<Response | null> {
  const limit = parseIntEnv(env.WRITE_RL_LIMIT, 0);
  const windowSec = Math.max(1, parseIntEnv(env.WRITE_RL_WINDOW_SEC, 60));
  if (!limit || limit <= 0) return null; // disabled

  const ip = req.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const admin = req.headers.get('X-Admin-Token') || 'no-admin';
  const key = `rl:${routeKey}:${admin}:${ip}`;
  const now = Math.floor(Date.now() / 1000);

  const recStr = await env.PROMPT_CACHE.get(key);
  if (!recStr) {
    await env.PROMPT_CACHE.put(key, JSON.stringify({ c: 1, s: now }), { expirationTtl: windowSec });
    return null;
  }
  try {
    const rec = JSON.parse(recStr || '{}') as { c: number; s: number };
    if (rec.c >= limit) {
      const resetIn = windowSec - (now - (rec.s || now));
      return new Response(JSON.stringify({ error: 'rate_limited', code: 'RATE_LIMITED', request_id: generateRequestId() }), {
        status: 429,
        headers: { 'content-type': 'application/json; charset=utf-8', 'x-ratelimit-limit': String(limit), 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.max(0, resetIn)), ...corsHeadersFor(req, env) },
      });
    }
    rec.c += 1;
    await env.PROMPT_CACHE.put(key, JSON.stringify(rec), { expirationTtl: windowSec });
    return null;
  } catch {
    await env.PROMPT_CACHE.put(key, JSON.stringify({ c: 1, s: now }), { expirationTtl: windowSec });
    return null;
  }
}

async function verifyNonce(req: Request, env: Env): Promise<Response | null> {
  if (env.ENABLE_NONCE_REQUIRED_FOR_WRITE !== '1') return null;
  const nonce = req.headers.get('X-Nonce');
  if (!nonce) return errorResponse(req, env, { code: 'NONCE_REQUIRED', message: 'nonce required', status: 400 });
  const key = `nonce:${nonce}`;
  const exists = await env.PROMPT_CACHE.get(key);
  if (exists) return errorResponse(req, env, { code: 'REPLAY', message: 'nonce already used', status: 409 });
  const ttl = Math.max(30, parseIntEnv(env.NONCE_TTL_SEC, 300));
  await env.PROMPT_CACHE.put(key, '1', { expirationTtl: ttl });
  return null;
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
    const rid = req.headers.get('x-request-id') || generateRequestId();
    const started = nowMs();

    // Prepare D1 schema early for any /v1/prompts* request (helps in test/dev)
    if (url.pathname.startsWith("/v1/prompts") && env.ENABLE_SCHEMA_BOOTSTRAP === '1') {
      await ensurePromptsSchema(env);
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeadersFor(req, env) });
    }

    if (url.pathname === "/healthz") {
      const resp = jsonResponse(req, env, { ok: true, ts: Date.now() });
      logInfo({ request_id: rid, route: '/healthz', method: req.method, status: 200, latency_ms: nowMs() - started });
      return resp;
    }

    if (url.pathname === "/about") {
      const flags = {
        require_read_auth: env.REQUIRE_READ_AUTH === '1',
        write_rate_limit: !!(env.WRITE_RL_LIMIT && env.WRITE_RL_WINDOW_SEC),
        nonce_required_for_write: env.ENABLE_NONCE_REQUIRED_FOR_WRITE === '1',
        schema_bootstrap: env.ENABLE_SCHEMA_BOOTSTRAP === '1',
      };
      const out: any = {
        name: 'vlmm-worker',
        version: env.APP_TITLE ? `${env.APP_TITLE}` : 'dev',
        app_version: (env as any).APP_VERSION || undefined,
        environment: (env as any).ENV_NAME || 'dev',
        openapi_url: '/openapi.yaml',
        routes: ['/v1/vision/analyze', '/v1/vision/stream', '/v1/prompts', '/v1/prompts/{id}', '/v1/prompts/default', '/healthz'],
        flags,
      };
      if (env.ENABLE_REGEX_CONFIG === '1') {
        try {
          const regex_cleanup = await readRegexConfig(env);
          out.config = { ...(out.config || {}), regex_cleanup };
          logInfo({ route: '/about', regex_config_source: regex_cleanup.source });
        } catch (e: any) {
          logWarn({ route: '/about', regex_config_error: String(e?.message || e) });
        }
      }
      const resp = jsonResponse(req, env, out, 200);
      logInfo({ request_id: rid, route: '/about', method: 'GET', status: 200, latency_ms: nowMs() - started });
      return resp;
    }

    if (url.pathname === "/openapi.yaml") {
      const headers = new Headers({ 'content-type': 'text/yaml; charset=utf-8', ...corsHeadersFor(req, env) });
      logInfo({ request_id: rid, route: '/openapi.yaml', method: 'GET', status: 200, latency_ms: nowMs() - started });
      return new Response(OPENAPI_YAML, { status: 200, headers });
    }

    // Manual backup trigger (admin only)
    if (req.method === 'POST' && url.pathname === '/admin/backup') {
      if ((req.headers.get('X-Admin-Token') || '') !== (env.ADMIN_TOKEN || '')) {
        return errorResponse(req, env, { code: 'UNAUTHORIZED', message: 'unauthorized', status: 401 }, rid);
      }
      if (!env.BACKUPS) {
        return errorResponse(req, env, { code: 'NO_BACKUP_BUCKET', message: 'R2 bucket BACKUPS not bound', status: 500 }, rid);
      }
      if (env.ENABLE_SCHEMA_BOOTSTRAP === '1') {
        await ensurePromptsSchema(env);
      }
      const key = await backupPromptsToR2(env);
      logInfo({ request_id: rid, route: '/admin/backup', method: 'POST', status: 200, key, latency_ms: nowMs() - started });
      return jsonResponse(req, env, { ok: true, key }, 200);
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
          const resp = await progressWrappedSSE(req, env, upstreamPromise);
          logInfo({ request_id: rid, route: '/v1/vision/stream', method: 'POST', provider, status: 200, stream: true, latency_ms: nowMs() - started });
          return resp;
        }

        // Non-stream JSON
        const upstream = await upstreamPromise;
        const json = await upstream.json().catch(() => null);
        const headers = corsHeadersFor(req, env);
        const resp = new Response(JSON.stringify(json ?? { error: "bad upstream json" }), {
          status: upstream.status,
          headers: { "content-type": "application/json; charset=utf-8", ...headers },
        });
        logInfo({ request_id: rid, route: '/v1/vision/analyze', method: 'POST', provider, status: upstream.status, stream: false, latency_ms: nowMs() - started });
        return resp;
      } catch (e: any) {
        logError({ request_id: rid, route: url.pathname, method: req.method, error: e?.message || String(e), latency_ms: nowMs() - started });
        return errorResponse(req, env, { code: "BAD_REQUEST", message: e?.message || "Bad Request", status: 400 }, rid);
      }
    }

    // ---------------------------------------------------------------------
    // Prompts API (D1 + KV)
    // ---------------------------------------------------------------------

    // (already ensured above when path startsWith /v1/prompts)

    // LIST
    if (req.method === "GET" && url.pathname === "/v1/prompts") {
      const readAuth = verifyReadAuth(req, env); if (readAuth) return readAuth;
      const ns   = url.searchParams.get("namespace") || "default";
      const lang = url.searchParams.get("lang") || undefined;
      const act  = url.searchParams.get("active") || undefined; // "1"|"0"
      const q    = url.searchParams.get("q") || undefined;
      const tag  = url.searchParams.get("tag") || undefined;
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50)));
      const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
      const sortParam = (url.searchParams.get("sort") || "priority_asc").toLowerCase();

      // Detect presence of prompt_priority column (for forward/backward compat in tests/dev)
      let hasPrioCol = true;
      try {
        const chk = await env.vlm_api_db
          .prepare(`SELECT 1 FROM pragma_table_info('prompts') WHERE name = 'prompt_priority' LIMIT 1`)
          .first();
        hasPrioCol = !!chk;
      } catch { hasPrioCol = false; }

      // Whitelisted ORDER BY options
      let orderBy = hasPrioCol ? "prompt_priority ASC, prompt_name, prompt_version DESC" : "prompt_name, prompt_version DESC";
      if (sortParam === "priority_desc") orderBy = hasPrioCol ? "prompt_priority DESC, prompt_name, prompt_version DESC" : "prompt_name DESC, prompt_version DESC";
      else if (sortParam === "name_asc") orderBy = "prompt_name ASC, prompt_version DESC";
      else if (sortParam === "name_desc") orderBy = "prompt_name DESC, prompt_version DESC";
      else if (sortParam === "updated_desc") orderBy = "prompt_updated_at DESC";

      const canCache = !q && !tag && offset === 0 && sortParam === 'priority_asc' && hasPrioCol; // cache only default sort when prio exists
      const cacheKey = promptsKVKeyList(ns, lang, act);
      if (canCache) {
        const cached = await env.PROMPT_CACHE?.get(cacheKey, "json");
        if (cached) {
          logInfo({ request_id: rid, route: '/v1/prompts', method: 'GET', cache: 'HIT', namespace: ns, lang, active: act, q: !!q, tag: !!tag, count: Array.isArray(cached) ? cached.length : undefined, latency_ms: nowMs() - started });
          return jsonResponse(req, env, cached, 200);
        }
      }

      const where: string[] = ["prompt_namespace = ?"]; const args: any[] = [ns];
      if (lang) { where.push("prompt_lang = ?"); args.push(lang); }
      if (typeof act !== "undefined") { where.push("prompt_is_active = ?"); args.push(Number(act)); }
      if (q) { where.push("(prompt_name LIKE ? OR prompt_text LIKE ?)"); args.push(`%${q}%`, `%${q}%`); }
      if (tag) { where.push("EXISTS (SELECT 1 FROM json_each(prompts.prompt_tags) je WHERE je.value = ?)"); args.push(tag); }

      const sql = `SELECT * FROM prompts WHERE ${where.join(" AND ")}
                   ORDER BY ${orderBy}
                   LIMIT ? OFFSET ?`;
      const rs = await env.vlm_api_db.prepare(sql).bind(...args, limit, offset).all();
      const out = rs.results?.map(mapPromptRow) ?? [];
      if (canCache && env.PROMPT_CACHE) await env.PROMPT_CACHE.put(cacheKey, JSON.stringify(out), { expirationTtl: 60 });
      logInfo({ request_id: rid, route: '/v1/prompts', method: 'GET', cache: canCache ? 'MISS' : 'BYPASS', namespace: ns, lang, active: act, q: !!q, tag: !!tag, count: out.length, latency_ms: nowMs() - started });
      return jsonResponse(req, env, out, 200);
    }

    // GET BY ID
    const mGet = url.pathname.match(/^\/v1\/prompts\/(\d+)$/);
    if (req.method === "GET" && mGet) {
      const readAuth = verifyReadAuth(req, env); if (readAuth) return readAuth;
      const id = Number(mGet[1]);
      const k = promptsKVKeyById(id);
      const cached = await env.PROMPT_CACHE?.get(k, "json");
      if (cached) { logInfo({ request_id: rid, route: '/v1/prompts/:id', method: 'GET', cache: 'HIT', id, latency_ms: nowMs() - started }); return jsonResponse(req, env, cached, 200); }

      const row = await env.vlm_api_db.prepare(`SELECT * FROM prompts WHERE prompt_id = ?`).bind(id).first();
      if (!row) return errorResponse(req, env, { code: "NOT_FOUND", message: "not found", status: 404 });
      const out = mapPromptRow(row);
      if (env.PROMPT_CACHE) await env.PROMPT_CACHE.put(k, JSON.stringify(out), { expirationTtl: 300 });
      logInfo({ request_id: rid, route: '/v1/prompts/:id', method: 'GET', cache: 'MISS', id, latency_ms: nowMs() - started });
      return jsonResponse(req, env, out, 200);
    }

    // GET DEFAULT
    if (req.method === "GET" && url.pathname === "/v1/prompts/default") {
      const readAuth = verifyReadAuth(req, env); if (readAuth) return readAuth;
      const ns   = url.searchParams.get("namespace") || "default";
      const lang = url.searchParams.get("lang") || "ru";
      const k = promptsKVKeyDefault(ns, lang);
      const cached = await env.PROMPT_CACHE?.get(k, "json");
      if (cached) { logInfo({ request_id: rid, route: '/v1/prompts/default', method: 'GET', cache: 'HIT', namespace: ns, lang, latency_ms: nowMs() - started }); return jsonResponse(req, env, cached, 200); }

      const row = await env.vlm_api_db
        .prepare(`SELECT * FROM prompts WHERE prompt_namespace = ? AND prompt_lang = ? AND prompt_is_default = 1 LIMIT 1`)
        .bind(ns, lang).first();
      if (!row) return errorResponse(req, env, { code: "NOT_FOUND", message: "not found", status: 404 });
      const out = mapPromptRow(row);
      if (env.PROMPT_CACHE) await env.PROMPT_CACHE.put(k, JSON.stringify(out), { expirationTtl: 300 });
      logInfo({ request_id: rid, route: '/v1/prompts/default', method: 'GET', cache: 'MISS', namespace: ns, lang, latency_ms: nowMs() - started });
      return jsonResponse(req, env, out, 200);
    }

    // CREATE
    if (req.method === "POST" && url.pathname === "/v1/prompts") {
      if ((req.headers.get("X-Admin-Token") || "") !== (env.ADMIN_TOKEN || "")) {
        return errorResponse(req, env, { code: "UNAUTHORIZED", message: "unauthorized", status: 401 });
      }
      const nonceCheck = await verifyNonce(req, env); if (nonceCheck) return nonceCheck;
      const rl = await rateLimitWrite(req, env, 'prompts_create'); if (rl) return rl;
      let body: any; try { body = await req.json(); } catch { return errorResponse(req, env, { code: "BAD_JSON", message: "invalid json", status: 400 }); }
      if (!body || !body.name || !body.text) return errorResponse(req, env, { code: "BAD_INPUT", message: "name and text required", status: 400 });

      // extra safety in dev/test only
      if (env.ENABLE_SCHEMA_BOOTSTRAP === '1') {
        await env.vlm_api_db.prepare(`CREATE TABLE IF NOT EXISTS prompts (
          prompt_id          INTEGER PRIMARY KEY AUTOINCREMENT,
          prompt_namespace   TEXT NOT NULL DEFAULT 'default',
          prompt_name        TEXT NOT NULL,
          prompt_version     INTEGER NOT NULL DEFAULT 1,
          prompt_lang        TEXT NOT NULL DEFAULT 'ru',
          prompt_text        TEXT NOT NULL,
          prompt_tags        TEXT NOT NULL DEFAULT '[]',
          prompt_is_active   INTEGER NOT NULL DEFAULT 1,
          prompt_is_default  INTEGER NOT NULL DEFAULT 0,
          prompt_created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          prompt_updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );`).run().catch(() => undefined);
      }

      const ns     = body.namespace || "default";
      const ver    = typeof body.version === "number" ? body.version : 1;
      const lang   = body.lang || "ru";
      const tags   = JSON.stringify(Array.isArray(body.tags) ? body.tags : []);
      const active = typeof body.is_active === "number" ? body.is_active : 1;
      const ts     = new Date().toISOString();

      const res = await env.vlm_api_db.prepare(`
        INSERT INTO prompts(
          prompt_namespace, prompt_name, prompt_version, prompt_lang,
          prompt_text, prompt_tags, prompt_is_active, prompt_is_default,
          prompt_created_at, prompt_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).bind(ns, body.name, ver, lang, body.text, tags, active, ts, ts).run();

      const id = Number((res as any)?.meta?.last_row_id ?? (res as any)?.lastRowId ?? 0);
      // Optional initial priority set (compatible with pre-migration DBs)
      if (typeof body.priority === 'number' && Number.isFinite(body.priority)) {
        await env.vlm_api_db.prepare(`UPDATE prompts SET prompt_priority = ? WHERE prompt_id = ?`).bind(body.priority, id).run().catch(() => undefined);
      }
      if (body.make_default) {
        await env.vlm_api_db.batch([
          env.vlm_api_db.prepare(`UPDATE prompts SET prompt_is_default = 0 WHERE prompt_namespace = ? AND prompt_lang = ?`).bind(ns, lang),
          env.vlm_api_db.prepare(`UPDATE prompts SET prompt_is_default = 1 WHERE prompt_id = ?`).bind(id),
        ]);
        await env.PROMPT_CACHE?.delete(promptsKVKeyDefault(ns, lang));
      }

      await env.PROMPT_CACHE?.delete(promptsKVKeyList(ns, lang, String(active)));
      await env.PROMPT_CACHE?.delete(promptsKVKeyList(ns, lang, "*"));
      await env.PROMPT_CACHE?.delete(promptsKVKeyList(ns, "*", "*"));

      logInfo({ request_id: rid, route: '/v1/prompts', method: 'POST', status: 201, id, namespace: ns, lang, make_default: !!body.make_default, latency_ms: nowMs() - started });
      return new Response(JSON.stringify({ id }), { status: 201, headers: { "content-type": "application/json; charset=utf-8", ...corsHeadersFor(req, env) } });
    }

    // UPDATE
    const mPut = url.pathname.match(/^\/v1\/prompts\/(\d+)$/);
    if (req.method === "PUT" && mPut) {
      if ((req.headers.get("X-Admin-Token") || "") !== (env.ADMIN_TOKEN || "")) {
        return errorResponse(req, env, { code: "UNAUTHORIZED", message: "unauthorized", status: 401 });
      }
      const nonceCheck = await verifyNonce(req, env); if (nonceCheck) return nonceCheck;
      const rl = await rateLimitWrite(req, env, 'prompts_update'); if (rl) return rl;
      const id = Number(mPut[1]);
      let body: any; try { body = await req.json(); } catch { body = {}; }

      const cur = await env.vlm_api_db
        .prepare(`SELECT prompt_namespace, prompt_lang, prompt_is_active FROM prompts WHERE prompt_id = ?`).bind(id).first();
      if (!cur) return errorResponse(req, env, { code: "NOT_FOUND", message: "not found", status: 404 });

      const fields: string[] = []; const args: any[] = [];
      for (const [k, v] of Object.entries(body)) {
        if (k === "tags") { fields.push(`prompt_tags = ?`); args.push(JSON.stringify(v)); }
        else if (k === "namespace") { fields.push(`prompt_namespace = ?`); args.push(v); }
        else if (k === "name") { fields.push(`prompt_name = ?`); args.push(v); }
        else if (k === "version") { fields.push(`prompt_version = ?`); args.push(v); }
        else if (k === "lang") { fields.push(`prompt_lang = ?`); args.push(v); }
        else if (k === "text") { fields.push(`prompt_text = ?`); args.push(v); }
        else if (k === "priority") { fields.push(`prompt_priority = ?`); args.push(v); }
        else if (k === "is_active") { fields.push(`prompt_is_active = ?`); args.push(v); }
      }
      if (!fields.length) return errorResponse(req, env, { code: "NO_UPDATES", message: "nothing to update", status: 400 });
      fields.push(`prompt_updated_at = ?`); args.push(new Date().toISOString()); args.push(id);
      await env.vlm_api_db.prepare(`UPDATE prompts SET ${fields.join(", ")} WHERE prompt_id = ?`).bind(...args).run();

      await env.PROMPT_CACHE?.delete(promptsKVKeyById(id));
      await env.PROMPT_CACHE?.delete(promptsKVKeyList(cur.prompt_namespace, cur.prompt_lang, String(cur.prompt_is_active)));
      await env.PROMPT_CACHE?.delete(promptsKVKeyList(cur.prompt_namespace, cur.prompt_lang, "*"));
      logInfo({ request_id: rid, route: '/v1/prompts/:id', method: 'PUT', status: 200, id, latency_ms: nowMs() - started });
      return jsonResponse(req, env, { updated: true }, 200);
    }

    // SET DEFAULT
    const mDef = url.pathname.match(/^\/v1\/prompts\/(\d+)\/default$/);
    if (req.method === "PUT" && mDef) {
      if ((req.headers.get("X-Admin-Token") || "") !== (env.ADMIN_TOKEN || "")) {
        return errorResponse(req, env, { code: "UNAUTHORIZED", message: "unauthorized", status: 401 });
      }
      const nonceCheck = await verifyNonce(req, env); if (nonceCheck) return nonceCheck;
      const rl = await rateLimitWrite(req, env, 'prompts_set_default'); if (rl) return rl;
      const id = Number(mDef[1]);
      const row = await env.vlm_api_db
        .prepare(`SELECT prompt_namespace, prompt_lang, prompt_is_active FROM prompts WHERE prompt_id = ?`).bind(id).first();
      if (!row) return errorResponse(req, env, { code: "NOT_FOUND", message: "not found", status: 404 });
      if (row.prompt_is_active !== 1) return errorResponse(req, env, { code: "BAD_STATE", message: "prompt must be active to set default", status: 400 });

      await env.vlm_api_db.batch([
        env.vlm_api_db.prepare(`UPDATE prompts SET prompt_is_default = 0 WHERE prompt_namespace = ? AND prompt_lang = ?`).bind(row.prompt_namespace, row.prompt_lang),
        env.vlm_api_db.prepare(`UPDATE prompts SET prompt_is_default = 1 WHERE prompt_id = ?`).bind(id),
      ]);
      await env.PROMPT_CACHE?.delete(promptsKVKeyDefault(row.prompt_namespace, row.prompt_lang));
      await env.PROMPT_CACHE?.delete(promptsKVKeyList(row.prompt_namespace, row.prompt_lang, "*"));
      logInfo({ request_id: rid, route: '/v1/prompts/:id/default', method: 'PUT', status: 200, id, latency_ms: nowMs() - started });
      return jsonResponse(req, env, { default_set: true }, 200);
    }

    logWarn({ request_id: rid, route: url.pathname, method: req.method, status: 404, latency_ms: nowMs() - started });
    return errorResponse(req, env, { code: "NOT_FOUND", message: "Not Found", status: 404 }, rid);
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    try {
      if (!env.BACKUPS) return;
      const key = await backupPromptsToR2(env);
      // No direct logging channel here, but console.log works in workers
      console.log(JSON.stringify({ level: 'info', ts: Date.now(), route: 'cron:backup', key }));
    } catch (e: any) {
      console.error(JSON.stringify({ level: 'error', ts: Date.now(), route: 'cron:backup', error: e?.message || String(e) }));
    }
  }
};

// Backup helper: dumps prompts table to R2 as JSON
async function backupPromptsToR2(env: Env): Promise<string> {
  const prefix = (env.BACKUP_PREFIX && env.BACKUP_PREFIX.trim()) || 'd1-backups/';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const key = `${prefix}prompts-${ts}.json`;
  // Simple dump (could be chunked for huge tables)
  const rs = await env.vlm_api_db.prepare('SELECT * FROM prompts ORDER BY prompt_namespace, prompt_name, prompt_version').all();
  const rows = (rs.results || []) as any[];
  const mapped = rows.map(mapPromptRow);
  const body = JSON.stringify({ ts: new Date().toISOString(), count: mapped.length, items: mapped });
  await env.BACKUPS!.put(key, body, { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
  return key;
}
