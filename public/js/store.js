import { api } from './api.js';

/** Shared client state. Views read from here and call refresh helpers. */
export const store = {
  user: null,
  authConfig: { google: { enabled: false, clientId: '', redirectFlow: false }, defaultCurrency: 'USD' },
  accounts: [],
  categories: [],
  connections: { connected: [], incoming: [], outgoing: [] },
  period: new Date().toISOString().slice(0, 7),
  essentialsLoaded: false,

  get currency() {
    return this.user?.currency || this.authConfig.defaultCurrency || 'USD';
  },

  async loadAuthConfig() {
    this.authConfig = await api.get('/api/auth/config');
    return this.authConfig;
  },

  async loadSession() {
    try {
      const { user } = await api.get('/api/users/me');
      this.user = user;
    } catch {
      this.user = null;
    }
    return this.user;
  },

  async loadAccounts() {
    this.accounts = (await api.get('/api/accounts')).accounts;
    return this.accounts;
  },

  async loadCategories() {
    this.categories = (await api.get('/api/categories')).categories;
    return this.categories;
  },

  async loadConnections() {
    this.connections = await api.get('/api/connections');
    return this.connections;
  },

  /** The reference data most views need before they can render a form. */
  async loadEssentials() {
    await Promise.all([this.loadAccounts(), this.loadCategories(), this.loadConnections()]);
    this.essentialsLoaded = true;
  },

  /** Loads that reference data once, so forms opened from any view have it. */
  async ensureEssentials() {
    if (this.essentialsLoaded) return;
    await this.loadEssentials();
  },

  writableAccounts() {
    return this.accounts.filter((a) => a.role === 'owner' || a.role === 'editor');
  },

  categoriesOfKind(kind) {
    return this.categories.filter((c) => c.kind === kind);
  },

  signOut: async () => {
    await api.post('/api/auth/logout');
    window.location.href = '/';
  },
};
