import { Router } from 'express';
import { config } from '../config.js';
import { verifyAppProxy, isShopDomain } from '../lib/shopify.js';
import { mintCustomerAssertion } from '../lib/assertions.js';

// Requests that arrive through the Shopify app proxy
// (https://<shop>/apps/oversized/... -> https://<app>/proxy/...).
// Shopify strips cookies on this path, so no session is used here; the only
// thing we take from it is Shopify's signed statement of who is logged in.
export const proxyRouter = Router();

proxyRouter.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!verifyAppProxy(req.query)) return res.status(401).json({ error: 'invalid proxy signature' });
  if (!isShopDomain(req.query.shop) || (config.shopify.shopDomain && req.query.shop !== config.shopify.shopDomain)) {
    return res.status(403).json({ error: 'wrong shop' });
  }
  next();
});

proxyRouter.get('/customer-assertion', (req, res) => {
  const customerId = req.query.logged_in_customer_id;
  if (!customerId) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, assertion: mintCustomerAssertion(req.query.shop, customerId) });
});
