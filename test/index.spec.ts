import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Worker basics', () => {
  it('GET /healthz returns ok (unit)', async () => {
    const request = new IncomingRequest('http://example.com/healthz');
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.ok).toBe(true);
  });

  it('unknown route returns standardized error (integration)', async () => {
    const response = await SELF.fetch('https://example.com/unknown');
    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.code).toBe('NOT_FOUND');
    expect(typeof json.request_id).toBe('string');
  });

  it('serves /about and /openapi.yaml', async () => {
    const about = await SELF.fetch('https://example.com/about');
    expect(about.status).toBe(200);
    const meta = await about.json();
    expect(meta.openapi_url).toBe('/openapi.yaml');

    const spec = await SELF.fetch('https://example.com/openapi.yaml');
    expect(spec.status).toBe(200);
    const text = await spec.text();
    expect(text.startsWith('openapi: 3.0.3')).toBe(true);
  });

  it('admin backup writes to R2 when bound', async () => {
    // Only run if R2 is available in this env
    if (!(env as any).BACKUPS) return;
    const ctx = createExecutionContext();
    const req = new IncomingRequest('http://example.com/admin/backup', { method: 'POST', headers: { 'X-Admin-Token': env.ADMIN_TOKEN || 'test-admin' } });
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    // Optionally verify the object exists
    const list = await (env as any).BACKUPS.list({ prefix: 'd1-backups/' });
    expect(list).toBeTruthy();
  });
});
