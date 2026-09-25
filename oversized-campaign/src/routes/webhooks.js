import express, { Router } from 'express';
import { handleWebhook } from '../lib/webhooks.js';

export const webhooksRouter = Router();

// Raw body: the HMAC is computed over the exact bytes Shopify sent.
webhooksRouter.post('/', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  const out = handleWebhook(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), req.headers);
  res.status(out.status).json(out.body);
});
