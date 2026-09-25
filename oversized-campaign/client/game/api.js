// Talks to the campaign server. Credentials are included so the HttpOnly
// session cookie travels with every request; the page never sees it.
export function createApi(base, { proxyBase } = {}) {
  let headerToken = null; // fallback when cookies are blocked: kept in memory only

  async function call(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (headerToken) headers.authorization = `Bearer ${headerToken}`;
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'include',
        cache: 'no-store',
      });
    } catch {
      const e = new Error('Ingen forbindelse til spilserveren');
      e.status = 0;
      throw e;
    }
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* empty */
    }
    if (data.headerToken) headerToken = data.headerToken;
    if (!res.ok) {
      const e = new Error(data.error || `Fejl ${res.status}`);
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return data;
  }

  return {
    get usingHeaderSession() {
      return Boolean(headerToken);
    },
    me: () => call('GET', '/api/me'),
    /**
     * Make sure we have a player. Tries the cookie first; if the browser
     * drops it (third-party cookie blocking), falls back to a per-visit token.
     */
    async ensureSession() {
      const me = await call('GET', '/api/me');
      if (me.player) return { ...me, cookieOk: !headerToken };
      await call('POST', '/api/session', {});
      const check = await call('GET', '/api/me');
      if (check.player) return { ...check, cookieOk: true };
      const fb = await call('POST', '/api/session', { transport: 'header' });
      return { ...fb, cookieOk: false };
    },
    startRound: () => call('POST', '/api/rounds', {}),
    submitRound: (id, events, rulesVersion) => call('POST', `/api/rounds/${id}/submit`, { events, rulesVersion }),
    history: () => call('GET', '/api/rounds/history'),
    leaderboard: () => call('GET', '/api/leaderboard'),
    updateProfile: (p) => call('PATCH', '/api/me', p),
    emailLink: (email) => call('POST', '/api/email-link', { email }),
    claim: () => call('POST', '/api/rewards/claim', {}),
    rewards: () => call('GET', '/api/rewards'),
    logout: () => call('POST', '/api/logout', {}),
    /** Only works inside the storefront (same-origin app proxy path). */
    async linkCustomer() {
      if (!proxyBase) return null;
      const res = await fetch(`${proxyBase}/customer-assertion`, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error('Kunne ikke kontakte butikken');
      const a = await res.json();
      if (!a.loggedIn) return { loggedIn: false };
      return call('POST', '/api/link-customer', { assertion: a.assertion });
    },
  };
}
