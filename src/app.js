import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { HttpError } from './lib/errors.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { connectionsRouter } from './routes/connections.js';
import { accountsRouter } from './routes/accounts.js';
import { categoriesRouter } from './routes/categories.js';
import { transactionsRouter } from './routes/transactions.js';
import { budgetsRouter } from './routes/budgets.js';
import { goalsRouter } from './routes/goals.js';
import { recurringRouter } from './routes/recurring.js';
import { reportsRouter } from './routes/reports.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => res.json({ ok: true, version: '2.0.0' }));

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/connections', connectionsRouter);
  app.use('/api/accounts', accountsRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/budgets', budgetsRouter);
  app.use('/api/goals', goalsRouter);
  app.use('/api/recurring', recurringRouter);
  app.use('/api/reports', reportsRouter);

  app.use(express.static(path.join(config.rootDir, 'public'), { extensions: ['html'] }));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'No such endpoint' }));

  // The client is a single page app: every other path renders the shell.
  app.get(/.*/, (_req, res) => res.sendFile(path.join(config.rootDir, 'public', 'index.html')));

  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'That request body was not valid JSON' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side' });
  });

  return app;
}
