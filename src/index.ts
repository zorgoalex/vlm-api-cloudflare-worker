/**
 * VLMM proxy on Cloudflare Workers
 *  - POST /v1/vision/analyze  (JSON or multipart/form-data)
 *  - POST /v1/vision/stream   (SSE passthrough)
 *  - GET  /healthz
 *
 * CORS:
 *  - Разрешённые Origin'ы берутся из env.ALLOWED_ORIGINS (через запятую)
 *    или из DEFAULT_ALLOWED_ORIGINS ниже.
 */

export interface Env {
  OPENROUTER_API_KEY: string; // wrangler secret put OPENROUTER_API_KEY
  DEFAULT_MODEL?: string;     // wrangler vars (не секрет)
  APP_URL?: string;           // для HTTP-Referer атрибуции
  APP_TITLE?: string;         // для X-Title атрибуции
  ALLOWED_ORIGINS?: string;   // "https://front.vercel.app,http://localhost:3000"
}

// ← поставь свой домен фронта (можно добавить ещё)
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "https://vlm-api-front.vercel.app",
];

const MAX_FILE_MB = 1;
const ALLOWED_MIME = /^image\/(jpeg|png|webp|gif)$/i;

type Detail = "low" | "high" | "auto";

type AnalyzeJsonBody = {
  prompt?: string;
  image_url?: string;
  image_base64?: string; // без data:-префикса
  model?: string;
  detail?: Detail;
  stream?: boolean;
};

function parseAllowedOrigins(env: Env): Set<string> {
  const fromEnv = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  return new Set(fromEnv.length ? fromEnv : DEFAULT_ALLOWED_ORIGINS);
}

function corsHeadersFor(req: Request, env: Env, extra: Record<string, string> = {}) {
  const allowed = parseAllowedOrigins(env);
  const origin = req.headers.get("Origin") || "";
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

function jsonResponse(req: Request, env: Env, body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeadersFor(req, env) },
  });
}

async function fileToDataUrl(file: File): Promise<string> {
  if (!ALLOWED_MIME.test(file.type)) {
    throw new Error("Unsupported file type (jpeg/png/webp/gif only).");
  }
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    throw new Error(`File too large (> ${MAX_FILE_MB}MB).`);
  }
  const buf = await file.arrayBuffer();
  // конвертируем буфер в base64 без переполнения call stack
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const b64 = btoa(binary);
  const mime = file.type || "image/jpeg";
  return `data:${mime};base64,${b64}`;
}

function makeMessages(prompt: string, imageUrlData: string, detail?: Detail) {
  const content: any[] = [{ type: "text", text: prompt }];
  if (detail) content.push({ type: "image_url", image_url: { url: imageUrlData, detail } });
  else content.push({ type: "image_url", image_url: { url: imageUrlData } });
  return [{ role: "user", content }];
}

async function buildContentFromRequest(req: Request): Promise<{
  prompt: string;
  imageUrlData: string;
  detail?: Detail;
  model?: string;
  stream: boolean;
}> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const prompt = (form.get("prompt") as string) || "Describe the image in detail.";
    const model = (form.get("model") as string) || undefined;
    const detail = (form.get("detail") as Detail) || undefined;
    const stream = (form.get("stream") as string) === "true";

    const file = form.get("file");
    const urlField = form.get("image_url") as string | null;

    if (file instanceof File) {
      const dataUrl = await fileToDataUrl(file);
      return { prompt, imageUrlData: dataUrl, detail, model, stream };
    }
    if (urlField) {
      return { prompt, imageUrlData: urlField, detail, model, stream };
    }
    throw new Error("Expected 'file' in multipart/form-data (or provide 'image_url').");
  }

  const body = (await req.json()) as AnalyzeJsonBody;
  const prompt = body.prompt || "Describe the image in detail.";
  const model = body.model;
  const detail = body.detail;
  const stream = !!body.stream;

  if (body.image_url) {
    return { prompt, imageUrlData: body.image_url, detail, model, stream };
  }
  if (body.image_base64) {
    return {
      prompt,
      imageUrlData: `data:image/jpeg;base64,${body.image_base64}`,
      detail,
      model,
      stream,
    };
  }
  throw new Error("Provide either 'image_url' or 'image_base64' or use multipart with 'file'.");
}

async function callOpenRouter(env: Env, payload: any) {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (env.APP_URL) headers["HTTP-Referer"] = env.APP_URL;
  if (env.APP_TITLE) headers["X-Title"] = env.APP_TITLE;

  return fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const reqId = crypto.randomUUID();

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeadersFor(req, env) });
    }

    // Health
    if (url.pathname === "/healthz") {
      return jsonResponse(req, env, { ok: true, request_id: reqId });
    }

    // /v1/vision/analyze
    if (url.pathname === "/v1/vision/analyze" && req.method === "POST") {
      try {
        const { prompt, imageUrlData, detail, model } = await buildContentFromRequest(req);
        const payload = {
          model: model || env.DEFAULT_MODEL || "openai/gpt-4o-mini",
          messages: makeMessages(prompt, imageUrlData, detail),
          stream: false,
        };

        const upstream = await callOpenRouter(env, payload);
        const text = await upstream.text();

        return new Response(text, {
          status: upstream.status,
          headers: { "content-type": "application/json", ...corsHeadersFor(req, env), "x-request-id": reqId },
        });
      } catch (e: any) {
        console.error("[analyze]", reqId, e);
        return jsonResponse(req, env, { request_id: reqId, error: e.message || "Bad Request" }, 400);
      }
    }

    // /v1/vision/stream
    if (url.pathname === "/v1/vision/stream" && req.method === "POST") {
      try {
        const { prompt, imageUrlData, detail, model } = await buildContentFromRequest(req);
        const payload = {
          model: model || env.DEFAULT_MODEL || "openai/gpt-4o-mini",
          messages: makeMessages(prompt, imageUrlData, detail),
          stream: true,
        };

        const upstream = await callOpenRouter(env, payload);
        const headers = new Headers({
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          "connection": "keep-alive",
          "x-request-id": reqId,
          ...corsHeadersFor(req, env),
        });

        return new Response(upstream.body, {
          status: upstream.status,
          headers,
        });
      } catch (e: any) {
        console.error("[stream]", reqId, e);
        const errLine = `data: ${JSON.stringify({ request_id: reqId, error: e.message || "Bad Request" })}\n\n`;
        return new Response(errLine, {
          status: 400,
          headers: { "content-type": "text/event-stream; charset=utf-8", ...corsHeadersFor(req, env), "x-request-id": reqId },
        });
      }
    }

    return jsonResponse(req, env, { request_id: reqId, error: "Not Found" }, 404);
  },
};
