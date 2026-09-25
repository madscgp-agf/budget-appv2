import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Each test file gets its own database; call before importing src/. */
export function useTempEnv(name, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `osg-${name}-`));
  Object.assign(process.env, {
    DATABASE_FILE: path.join(dir, 'test.sqlite'),
    APP_SECRET: 'test-secret-test-secret-test-secret-0000',
    NODE_ENV: 'test',
    APP_URL: 'http://localhost:4999',
    STOREFRONT_ORIGINS: 'https://www.oversized.test',
    ...extra,
  });
  return dir;
}

export async function startServer() {
  const { createApp } = await import('../src/app.js');
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, client: (opts) => makeClient(base, opts), close: () => new Promise((r) => server.close(r)) };
}

export function makeClient(base, { origin, bearer } = {}) {
  const jar = new Map();
  const cookies = [];
  const request = async (method, p, body, extraHeaders = {}) => {
    const headers = { ...extraHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (origin) headers.origin = origin;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() || []) {
      cookies.push(c);
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (!value || /Expires=Thu, 01 Jan 1970/.test(c)) jar.delete(name);
      else jar.set(name, value);
    }
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    return { status: res.status, body: data, headers: res.headers };
  };
  return {
    get: (p, h) => request('GET', p, undefined, h),
    post: (p, b, h) => request('POST', p, b ?? {}, h),
    patch: (p, b, h) => request('PATCH', p, b, h),
    put: (p, b, h) => request('PUT', p, b, h),
    jar,
    cookies,
    setBearer(t) {
      bearer = t;
    },
  };
}

/** Plays a whole round against the server: start, move the clock, submit. */
export async function playRound(client, eventsFor, { advance = 45_500 } = {}) {
  const { advanceClock } = await import('../src/lib/clock.js');
  const start = await client.post('/api/rounds');
  if (start.status !== 201) throw new Error(`start failed ${start.status} ${JSON.stringify(start.body)}`);
  const events = eventsFor(start.body.seed);
  advanceClock(advance);
  const submit = await client.post(`/api/rounds/${start.body.roundId}/submit`, { events, rulesVersion: start.body.rulesVersion });
  return { start, submit, events };
}
