import 'dotenv/config';
import fs from 'node:fs';
import net from 'node:net';
import { GoogleGenAI } from '@google/genai';
import { dataDir, DatabaseManager } from '../storage/database.js';
import { initializeAppDatabase, initializeLedgerDatabase } from '../storage/schema.js';
import { GoogleWorkspaceClient } from '../integrations/google/client.js';
import { renderDocx } from '../documents/render-docx.js';
import { readingOrder, Block } from '../documents/blocks.js';
import { libreOfficeEngine, pdfToolsInstalled, readingOrderProblems } from '../documents/pdf.js';

/**
 * `npm run doctor`: what is configured, what is missing, what would be disabled.
 * Exit code 1 if anything FAILs. Never prints secret values.
 */

type Level = 'PASS' | 'WARN' | 'FAIL';
const results: Array<{ level: Level; name: string; detail: string }> = [];
const report = (level: Level, name: string, detail: string): void => { results.push({ level, name, detail }); };

const env = (k: string) => process.env[k]?.trim() || '';

const REQUIRED: Array<[string, string]> = [
  ['ELLIE_CONTROL_PLANE_TOKEN', 'control page login'],
  ['ELLIE_PUBLIC_URL', 'links in Slack and Google OAuth redirect'],
  ['ELLIE_OWNER_NAME', 'how Ellie addresses you'],
  ['ELLIE_OWNER_FULL_NAME', 'signatures and outreach'],
  ['GEMINI_API_KEY', 'all model calls'],
  ['GEMINI_FLASH_MODEL', 'default model'],
  ['SLACK_BOT_TOKEN', 'Slack'],
  ['SLACK_SIGNING_SECRET', 'Slack request verification'],
  ['SLACK_OWNER_USER_ID', 'only you can talk to Ellie'],
  ['SLACK_BOT_USER_ID', 'telling Ellie\'s own messages apart in threads'],
  ['SLACK_CHANNEL_ID', 'routine reports and proactive messages'],
  ['GOOGLE_CLIENT_ID', 'Gmail, Drive, Docs, Sheets, Calendar'],
  ['GOOGLE_CLIENT_SECRET', 'Gmail, Drive, Docs, Sheets, Calendar']
];

const OPTIONAL: Array<[string, string]> = [
  ['GEMINI_REASONING_MODEL', 'routines marked "reasoning" use Flash instead (GEMINI_PRO_MODEL is also accepted)'],
  ['GEMINI_IMAGE_MODEL', 'image generation defaults to gemini-3.1-flash-image (Nano Banana)'],
  ['ELLIE_PRIVATE_PORT', 'no token-free tailnet listener'],
  ['ELLIE_CONTROL_URL', 'Slack links to the control page use ELLIE_PUBLIC_URL'],
  ['ELLIE_MCP_GATEWAY_URL', 'Ads and LinkedIn gateway tools hidden'],
  ['APIFY_API_TOKEN', 'LinkedIn profile/post lookups hidden'],
  ['COMPOSIO_API_KEY', 'Composio free tool discovery and installation hidden'],
  ['ELLIE_CLAIMS_BANK_DOC_ID', 'outreach claims cannot be checked (drafts are blocked)'],
  ['ELLIE_SEND_ALLOWLIST', 'any recipient can be approved'],
  ['ELLIE_MAX_DAILY_SENDS', 'no daily send cap']
];

/** Settings that only older versions used; their presence means a half-migrated .env. */
const OBSOLETE = ['ELLIE_APP_DB_PATH', 'ELLIE_LEDGER_DB_PATH', 'GEMINI_ARGON_MODEL'];

function checkConfig(): void {
  for (const [k, why] of REQUIRED) {
    if (!env(k) || /^your-|placeholder|xoxb-\.\.\.$/i.test(env(k))) report('FAIL', k, `missing (${why})`);
  }
  for (const [k, effect] of OPTIONAL) {
    if (!env(k) && !(k === "GEMINI_REASONING_MODEL" && env("GEMINI_PRO_MODEL"))) report('WARN', k, `not set: ${effect}`);
  }
  for (const k of OBSOLETE) {
    if (env(k)) report('FAIL', k, 'obsolete setting from an older Ellie; remove it from .env');
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(ELLIE|GEMINI|SLACK|GOOGLE|PROTON|APIFY|COMPOSIO)_/.test(k)) continue;
    if (typeof v === 'string' && /ellie-v[0-4]\b/i.test(v)) report('FAIL', k, 'points at an old Ellie install (ellie-v2/v4 path)');
  }
  if (env('NODE_ENV') !== 'production') report('WARN', 'NODE_ENV', `is "${env('NODE_ENV') || 'unset'}" (production enforces required settings at startup)`);
}

function checkStorage(): void {
  const dir = dataDir();
  if (/google drive|my drive|dropbox|onedrive|icloud/i.test(dir)) {
    report('FAIL', 'ELLIE_DATA_DIR', `${dir} is inside a synced folder; SQLite needs a local disk`);
  }
  try {
    const manager = new DatabaseManager();
    const app = manager.getAppDb();
    const ledger = manager.getLedgerDb();
    initializeAppDatabase(app);
    initializeLedgerDatabase(ledger);
    const v = (db: any) => (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as any).v;
    report('PASS', 'Database', `${dir} (app schema v${v(app)}, ledger schema v${v(ledger)})`);
    manager.close();
  } catch (err: any) {
    report('FAIL', 'Database', err.message);
  }
  const priv = env('ELLIE_PRIVATE_DIR');
  if (priv && !fs.existsSync(priv)) report('WARN', 'ELLIE_PRIVATE_DIR', `${priv} does not exist`);
}

async function withTimeout<T>(p: Promise<T>, ms = 10_000): Promise<T> {
  let timer: any;
  return Promise.race([p, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms); })])
    .finally(() => clearTimeout(timer));
}

async function checkGemini(): Promise<void> {
  if (!env('GEMINI_API_KEY')) return;
  const client = new GoogleGenAI({ apiKey: env('GEMINI_API_KEY') });
  const models: Array<[string, string]> = [['GEMINI_FLASH_MODEL', env('GEMINI_FLASH_MODEL')]];
  const reasoning = env('GEMINI_REASONING_MODEL') || env('GEMINI_PRO_MODEL');
  if (reasoning) models.push([env('GEMINI_REASONING_MODEL') ? 'GEMINI_REASONING_MODEL' : 'GEMINI_PRO_MODEL', reasoning]);
  const imageModel = env('GEMINI_IMAGE_MODEL') || 'gemini-3.1-flash-image';
  models.push(['GEMINI_IMAGE_MODEL', imageModel]);
  for (const [k, model] of models) {
    if (!model) continue;
    try {
      await withTimeout(client.models.get({ model }));
      report('PASS', k, `${model} exists`);
    } catch (err: any) {
      let reason = err.message;
      try { reason = JSON.parse(reason).error?.message ?? reason; } catch {}
      report('FAIL', k, `${model}: ${String(reason).slice(0, 160)}`);
    }
  }
}

async function checkSlack(): Promise<void> {
  if (!env('SLACK_BOT_TOKEN')) return;
  try {
    const res: any = await withTimeout(fetch('https://slack.com/api/auth.test', {
      method: 'POST', headers: { Authorization: `Bearer ${env('SLACK_BOT_TOKEN')}` }
    }).then(r => r.json()));
    if (!res.ok) return report('FAIL', 'Slack', `auth.test: ${res.error}`);
    if (env('SLACK_BOT_USER_ID') && res.user_id !== env('SLACK_BOT_USER_ID')) {
      report('FAIL', 'SLACK_BOT_USER_ID', `is ${env('SLACK_BOT_USER_ID')} but the token belongs to ${res.user_id}`);
    } else {
      report('PASS', 'Slack', `bot ${res.user} in workspace ${res.team}`);
    }
  } catch (err: any) {
    report('FAIL', 'Slack', err.message);
  }
}

async function checkGoogle(): Promise<void> {
  if (!env('GOOGLE_CLIENT_ID') || !env('GOOGLE_CLIENT_SECRET')) return;
  const manager = new DatabaseManager();
  try {
    const db = manager.getAppDb();
    initializeAppDatabase(db);
    const google = new GoogleWorkspaceClient(db);
    if (!google.isConnected()) {
      return report('FAIL', 'Google', `not connected; open ${env('ELLIE_PUBLIC_URL') || '<ELLIE_PUBLIC_URL>'}/api/integrations/google/connect or import a token`);
    }
    const profile = await withTimeout(google.getGmailProfile());
    report('PASS', 'Google', `connected as ${profile.emailAddress}`);
  } catch (err: any) {
    report('FAIL', 'Google', err.message.slice(0, 200));
  } finally {
    manager.close();
  }
}

async function checkGateway(): Promise<void> {
  const url = env('ELLIE_MCP_GATEWAY_URL');
  if (!url) return;
  try {
    const res = await withTimeout(fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(env('ELLIE_MCP_GATEWAY_KEY') ? { Authorization: `Bearer ${env('ELLIE_MCP_GATEWAY_KEY')}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'doctor', method: 'tools/list', params: {} })
    }));
    report(res.ok ? 'PASS' : 'WARN', 'MCP gateway', `HTTP ${res.status}`);
  } catch (err: any) {
    report('WARN', 'MCP gateway', `unreachable: ${err.message}`);
  }
}

/** Renders a made-up memo to DOCX and PDF, and reads the PDF back: what document_render does on every call. */
async function checkDocuments(): Promise<void> {
  if (!pdfToolsInstalled()) {
    report('WARN', 'Document PDF', 'soffice, pdfinfo or pdftotext missing: document_render writes the DOCX only');
    return;
  }
  try {
    const blocks: Block[] = [
      { type: 'header', name: 'Test Person', contact: ['test@example.test'] },
      { type: 'heading', text: 'Summary' },
      { type: 'paragraph', text: 'A made-up memo to prove the **renderer** works.' }
    ];
    const started = Date.now();
    const pdf = await withTimeout(libreOfficeEngine.convert(await renderDocx({ kind: 'memo', theme: 'executive-editorial', title: 'doctor', blocks })), 90_000);
    const [pages, text] = await Promise.all([libreOfficeEngine.pageCount(pdf), libreOfficeEngine.text(pdf)]);
    const problems = readingOrderProblems(readingOrder(blocks), text);
    if (pages !== 1 || problems.length) report('FAIL', 'Document PDF', `${pages} page(s); ${problems.join(' ') || 'text in order'}`);
    else report('PASS', 'Document PDF', `DOCX -> PDF, 1 page, text in block order (${Date.now() - started} ms)`);
  } catch (err: any) {
    report('FAIL', 'Document PDF', `render failed: ${err.message}`);
  }
}

function checkPort(name: string, host: string, port: number): Promise<void> {
  return new Promise(resolve => {
    const socket = net.connect({ host, port, timeout: 3000 });
    const done = (level: Level, detail: string) => { report(level, name, detail); socket.destroy(); resolve(); };
    socket.on('connect', () => done('PASS', `${host}:${port} reachable`));
    socket.on('timeout', () => done('WARN', `${host}:${port} timed out`));
    socket.on('error', err => done('WARN', `${host}:${port} ${err.message}`));
  });
}

async function main(): Promise<void> {
  checkConfig();
  checkStorage();
  await Promise.all([checkGemini(), checkSlack(), checkGoogle(), checkGateway(), checkDocuments()]);
  if (env('PROTON_USERNAME') && env('PROTON_ENABLED') !== 'false') {
    await checkPort('Proton Bridge IMAP', env('PROTON_IMAP_HOST') || '127.0.0.1', parseInt(env('PROTON_IMAP_PORT') || '1143', 10));
  }

  const order: Record<Level, number> = { FAIL: 0, WARN: 1, PASS: 2 };
  for (const r of results.sort((a, b) => order[a.level] - order[b.level])) {
    console.log(`${r.level.padEnd(4)}  ${r.name.padEnd(26)} ${r.detail}`);
  }
  const fails = results.filter(r => r.level === 'FAIL').length;
  console.log(`\n${fails === 0 ? 'Ready.' : `${fails} problem(s) to fix before starting Ellie.`}`);
  process.exitCode = fails === 0 ? 0 : 1;
}

main().catch(err => {
  console.error('doctor crashed:', err);
  process.exit(1);
});
