import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

// Prompts API tests are scaffolded and will be enabled once endpoints are available in this worker.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Prompts API (D1 + KV)', () => {
  const base = 'http://example.com';
  const admin = env.ADMIN_TOKEN || 'test-admin';

  it('POST /v1/prompts requires admin token', async () => {
    const ctx = createExecutionContext();
    const req = new IncomingRequest(`${base}/v1/prompts`, { method: 'POST', body: JSON.stringify({ name: 'x', text: 'y' }), headers: { 'content-type': 'application/json' } });
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it('CRUD + default + list + get', async () => {
    // create
    let ctx = createExecutionContext();
    let req = new IncomingRequest(`${base}/v1/prompts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Admin-Token': admin },
      body: JSON.stringify({ namespace: 'default', name: 'order_parser_ru', version: 1, lang: 'ru', text: 'Тест', tags: ['ru','parser'], is_active: 1, make_default: true }),
    });
    let res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(201);
    const created = await res.json() as any;
    expect(typeof created.id).toBe('number');
    const id = created.id;

    // get by id
    ctx = createExecutionContext();
    req = new IncomingRequest(`${base}/v1/prompts/${id}`);
    res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    let item = await res.json();
    expect(item.id).toBe(id);
    expect(item.is_default).toBe(1);

    // list
    ctx = createExecutionContext();
    req = new IncomingRequest(`${base}/v1/prompts?namespace=default&lang=ru&active=1`);
    res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.find((p: any) => p.id === id)).toBeTruthy();

    // get default
    ctx = createExecutionContext();
    req = new IncomingRequest(`${base}/v1/prompts/default?namespace=default&lang=ru`);
    res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const def = await res.json();
    expect(def.id).toBe(id);

    // update
    ctx = createExecutionContext();
    req = new IncomingRequest(`${base}/v1/prompts/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'X-Admin-Token': admin },
      body: JSON.stringify({ name: 'order_parser_ru_v2', text: 'Новый текст' }),
    });
    res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);

    // re-fetch by id for updated
    ctx = createExecutionContext();
    req = new IncomingRequest(`${base}/v1/prompts/${id}`);
    res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    item = await res.json();
    expect(item.name).toBe('order_parser_ru_v2');
  });

  it('priority and sort options', async () => {
    // create three items with different priorities and names
    let ctx = createExecutionContext();
    let req = new IncomingRequest(`${base}/v1/prompts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Admin-Token': admin },
      body: JSON.stringify({ namespace: 'sort', name: 'b_second', version: 1, lang: 'ru', text: 'B', priority: 5, is_active: 1 }),
    });
    let res = await worker.fetch(req, env, ctx); await waitOnExecutionContext(ctx); expect(res.status).toBe(201);
    const idB = (await res.json() as any).id;

    ctx = createExecutionContext();
    req = new IncomingRequest(`${base}/v1/prompts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Admin-Token': admin },
      body: JSON.stringify({ namespace: 'sort', name: 'a_first', version: 1, lang: 'ru', text: 'A', priority: -1, is_active: 1 }),
    });
    res = await worker.fetch(req, env, ctx); await waitOnExecutionContext(ctx); expect(res.status).toBe(201);
    const idA = (await res.json() as any).id;

    ctx = createExecutionContext();
    req = new IncomingRequest(`${base}/v1/prompts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Admin-Token': admin },
      body: JSON.stringify({ namespace: 'sort', name: 'c_third', version: 1, lang: 'ru', text: 'C', priority: 10, is_active: 1 }),
    });
    res = await worker.fetch(req, env, ctx); await waitOnExecutionContext(ctx); expect(res.status).toBe(201);
    const idC = (await res.json() as any).id;

    // default sort: priority ASC, then name
    ctx = createExecutionContext();
    req = new IncomingRequest(`${base}/v1/prompts?namespace=sort&lang=ru&active=1`);
    res = await worker.fetch(req, env, ctx); await waitOnExecutionContext(ctx); expect(res.status).toBe(200);
    let list = await res.json();
    const namesDefault = list.map((p: any) => p.name);
    expect(namesDefault).toEqual(['a_first','b_second','c_third']);

    // sort=priority_desc
    ctx = createExecutionContext();
    req = new IncomingRequest(`${base}/v1/prompts?namespace=sort&lang=ru&active=1&sort=priority_desc`);
    res = await worker.fetch(req, env, ctx); await waitOnExecutionContext(ctx); expect(res.status).toBe(200);
    list = await res.json();
    const namesPrioDesc = list.map((p: any) => p.name);
    expect(namesPrioDesc).toEqual(['c_third','b_second','a_first']);

    // sort=name_desc
    ctx = createExecutionContext();
    req = new IncomingRequest(`${base}/v1/prompts?namespace=sort&lang=ru&active=1&sort=name_desc`);
    res = await worker.fetch(req, env, ctx); await waitOnExecutionContext(ctx); expect(res.status).toBe(200);
    list = await res.json();
    const namesNameDesc = list.map((p: any) => p.name);
    expect(namesNameDesc).toEqual(['c_third','b_second','a_first']);

    // Update one item to test updated_desc order
    ctx = createExecutionContext();
    req = new IncomingRequest(`${base}/v1/prompts/${idB}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'X-Admin-Token': admin },
      body: JSON.stringify({ text: 'B updated' }),
    });
    res = await worker.fetch(req, env, ctx); await waitOnExecutionContext(ctx); expect(res.status).toBe(200);

    // sort=updated_desc should place b_second first
    ctx = createExecutionContext();
    req = new IncomingRequest(`${base}/v1/prompts?namespace=sort&lang=ru&active=1&sort=updated_desc`);
    res = await worker.fetch(req, env, ctx); await waitOnExecutionContext(ctx); expect(res.status).toBe(200);
    list = await res.json();
    const firstUpdated = list[0];
    expect(firstUpdated.name).toBe('b_second');
  });
});
