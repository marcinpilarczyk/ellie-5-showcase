import express, { Express, Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { GOOGLE_SCOPES } from '../integrations/google/client.js';
import { createAuthMiddleware, resolveControlPlaneToken } from './auth-middleware.js';
import { createQueueRouter } from './routes/queue.js';
import { createOpsRouter } from './routes/ops.js';
import { createVoiceRouter } from './routes/voice.js';
import { createSlackRouter } from './routes/slack.js';
import { createHealthRouter } from './routes/health.js';
import { createSpacesRouter } from './routes/spaces.js';
import { Runtime } from '../runtime/build-runtime.js';

export function createApp(runtime: Runtime): Express {
  const app = express();

  // Capture rawBody for Slack webhook signature verification; allow up to 25mb for audio payloads
  app.use(express.json({
    limit: '25mb',
    verify: (req: Request, _res, buf) => {
      (req as any).rawBody = buf;
    }
  }));
  app.use(express.urlencoded({
    extended: true,
    verify: (req: Request, _res, buf) => {
      (req as any).rawBody = buf;
    }
  }));

  // Health route (public)
  app.use('/api/health', createHealthRouter(runtime.googleClient, runtime.slackClient));

  // Slack webhook routes (public with HMAC signature validation)
  app.use('/api/slack', createSlackRouter(runtime.coworkerService));

  // Google OAuth callback: public (Google redirects here) but only accepts a state we issued
  const oauthStates = new Map<string, number>();
  // Also served on /api/auth/google/callback: the redirect URI registered in Google Cloud since v2
  app.get(['/api/integrations/google/callback', '/api/auth/google/callback'], async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const state = req.query.state as string;
    const issuedAt = state ? oauthStates.get(state) : undefined;
    if (state) oauthStates.delete(state);
    if (!issuedAt || Date.now() - issuedAt > 10 * 60_000) {
      res.status(400).send('Unknown or expired sign-in attempt. Start again from /api/integrations/google/connect.');
      return;
    }
    if (!code) {
      res.status(400).send('Missing code parameter');
      return;
    }
    try {
      const oauth2Client = runtime.googleClient.getOAuthClient();
      const { tokens } = await oauth2Client.getToken(code);
      runtime.googleClient.saveTokensToDb(tokens);
      res.send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:3rem;background:#0f172a;color:#fff;">
          <h2>Google Workspace Connected Successfully!</h2>
          <p><a href="/" style="color:#60a5fa;">Back to Ellie</a></p>
        </body></html>
      `);
    } catch (err: any) {
      res.status(500).send(`Authentication failed: ${err.message}`);
    }
  });

  // Apply Auth Middleware to all subsequent routes
  // Ports of private listeners (127.0.0.1 only, reached through tailscale serve); see index.ts
  const trustedPorts: Set<number> = app.locals.trustedPorts = new Set<number>();
  app.use(createAuthMiddleware(resolveControlPlaneToken(), {
    isTrustedListener: req => trustedPorts.has(req.socket.localPort ?? -1)
  }));

  // Start Google sign-in (behind the control-page login)
  app.get('/api/integrations/google/connect', (_req: Request, res: Response) => {
    const client = runtime.googleClient.getOAuthClient();
    if (!client) {
      res.status(503).send('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured.');
      return;
    }
    const state = crypto.randomBytes(16).toString('hex');
    oauthStates.set(state, Date.now());
    res.redirect(client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: GOOGLE_SCOPES, state }));
  });

  // Mount API Routers
  app.use('/api/queue', createQueueRouter(runtime.ledgerRepo, runtime.dispatcher, runtime.memoryRepo, runtime.modelRouter, runtime.waitingRepo, runtime.coworkerService));
  app.use('/api/spaces', createSpacesRouter(runtime.spaceRepo));
  app.use('/api/voice', createVoiceRouter(runtime));
  app.use('/api/ops', createOpsRouter(
    runtime.routineRepo,
    runtime.runTraceStore,
    runtime.costRepo,
    runtime.routineWorker,
    runtime.gmailSentinel,
    runtime.calendarSentinel,
    runtime.protonSentinel,
    runtime.googleClient,
    runtime.slackClient,
    runtime.protonClient,
    runtime.modelRouter,
    runtime.ledgerRepo,
    Boolean(runtime.aliasRepo.resolveId('claims_bank_doc') || process.env.ELLIE_CLAIMS_BANK_DOC_ID?.trim())
  ));

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

  // Serve published spaces directly on /spaces/:slug
  app.get('/spaces/:slug', (req: Request, res: Response) => {
    const slug = String(req.params['slug']);
    const space = runtime.spaceRepo.get(slug);
    if (!space) {
      res.status(404).send(`
        <!doctype html>
        <html lang="en">
        <head><meta charset="utf-8"><title>Space Not Found · Ellie</title>
        <style>
          body { background: #0f172a; color: #e2e8f0; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .box { background: #1e293b; padding: 2.5rem; border-radius: 12px; border: 1px solid #334155; text-align: center; max-width: 420px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
          h2 { margin-top: 0; color: #f87171; }
          p { color: #94a3b8; line-height: 1.5; }
          a { color: #60a5fa; text-decoration: none; font-weight: 500; }
          a:hover { text-decoration: underline; }
        </style>
        </head>
        <body>
          <div class="box">
            <h2>Space Not Found</h2>
            <p>No published space found with slug <code>${escapeHtml(slug)}</code>.</p>
            <p><a href="/" style="color:#60a5fa;">← Control Plane</a></p>
          </div>
        </body>
        </html>
      `);
      return;
    }
    const content = runtime.spaceRepo.getContent(space.slug);
    if (!content) {
      res.status(404).send('Space has no content yet.');
      return;
    }
    res.setHeader(
      'Content-Security-Policy',
      "sandbox allow-scripts allow-popups; default-src 'none'; style-src 'unsafe-inline' https:; font-src https: data:; img-src data: https:; connect-src 'none';",
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(content);
  });

  // Control page: approvals, spaces, routines, runs, costs, docs, settings.
  const indexHtmlPath = path.resolve('src/web/index.html');
  const serveHtml = (_req: Request, res: Response) => {
    if (fs.existsSync(indexHtmlPath)) {
      res.sendFile(indexHtmlPath);
    } else {
      res.send('Ellie control page');
    }
  };

  for (const page of ['/spaces', '/routines', '/runs', '/costs', '/docs', '/settings', '/web']) {
    app.get(page, serveHtml);
  }

  // Root route: serves the web dashboard when visited in a browser (Accept: text/html),
  // and returns JSON status when accessed by API/mobile clients.
  app.get('/', (req: Request, res: Response) => {
    const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
    if (acceptsHtml || req.query['ui'] === 'web') {
      serveHtml(req, res);
      return;
    }
    res.json({ ok: true, service: 'ellie-v5-control-plane', ui: 'android' });
  });

  return app;
}
