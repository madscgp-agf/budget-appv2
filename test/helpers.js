import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Each test file gets its own throwaway database, set before src/config is loaded. */
export function useTempDatabase(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `budget-${name}-`));
  process.env.DATABASE_FILE = path.join(dir, 'test.sqlite');
  process.env.JWT_SECRET = 'test-secret';
  process.env.NODE_ENV = 'test';
  process.env.APP_URL = 'http://localhost:3999';
  return dir;
}

/** Starts the app on an ephemeral port and returns a client that keeps cookies. */
export async function startServer() {
  const { createApp } = await import('../src/app.js');
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, client: () => makeClient(base), close: () => new Promise((r) => server.close(r)) };
}

function makeClient(base) {
  const jar = new Map();

  const request = async (method, path, body) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });

    for (const cookie of res.headers.getSetCookie?.() || []) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (!value || cookie.includes('Expires=Thu, 01 Jan 1970')) jar.delete(name);
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
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body ?? {}),
    patch: (path, body) => request('PATCH', path, body),
    put: (path, body) => request('PUT', path, body),
    del: (path) => request('DELETE', path),
    jar,
  };
}

/** Registers a user and returns a signed-in client. */
export async function signUp(harness, { username, email = `${username}@example.com`, password = 'password123' } = {}) {
  const client = harness.client();
  const res = await client.post('/api/auth/register', { username, email, password, displayName: username });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return { client, user: res.body.user };
}
