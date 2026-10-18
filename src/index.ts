import 'dotenv/config';
import { buildRuntime } from './runtime/build-runtime.js';
import { createApp } from './http/app.js';

// P11: fail closed on config. Refuse to start rather than run with an open door.
if (process.env.NODE_ENV === 'production') {
  const missing = ['ELLIE_CONTROL_PLANE_TOKEN', 'GEMINI_API_KEY', 'SLACK_SIGNING_SECRET', 'SLACK_OWNER_USER_ID']
    .filter(k => !process.env[k]?.trim());
  if (missing.length > 0) {
    console.error(`[Ellie] Refusing to start: ${missing.join(', ')} must be set in production.`);
    process.exit(1);
  }
}

const PORT = parseInt(process.env.PORT || '3001', 10);
const PRIVATE_PORT = parseInt(process.env.ELLIE_PRIVATE_PORT || '', 10);
const runtime = buildRuntime();
const app = createApp(runtime);

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`[Ellie] Listening on http://127.0.0.1:${PORT}`);
});

// Private no-login listener: bind to loopback and expose ONLY via `tailscale serve`.
// Never point a public proxy at this port.
let privateServer: ReturnType<typeof app.listen> | undefined;
if (Number.isFinite(PRIVATE_PORT) && PRIVATE_PORT > 0 && PRIVATE_PORT !== PORT) {
  app.locals.trustedPorts.add(PRIVATE_PORT);
  privateServer = app.listen(PRIVATE_PORT, '127.0.0.1', () => {
    console.log(`[Ellie] Private tailnet listener on http://127.0.0.1:${PRIVATE_PORT} (no token)`);
  });
}

// Periodic reminder dispatcher check (every 60s)
const reminderTimer = setInterval(async () => {
  try {
    await runtime.reminderDispatcher.dispatchDueReminders();
  } catch (err: any) {
    console.warn('[Server] Reminder check warning:', err.message);
  }
}, 60 * 1000);
reminderTimer.unref();

export { app, server, privateServer, runtime };
