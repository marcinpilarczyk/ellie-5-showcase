import { z } from 'zod';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { ToolDefinition } from '../types/tool.js';

/**
 * READ-ONLY view of the box Ellie runs on, so she can say what is stuck and what to do.
 *
 * SECURITY: no shell and no free-form command. Every operation maps to a fixed argv; the model only
 * picks an operation, a unit from UNITS, and bounded numbers. Output is redacted for secrets before
 * it is returned (logs and process command lines can contain tokens).
 */

/** Units she may read. Anything else is refused. */
export const INSPECTABLE_UNITS = [
  'ellie.service',
  'ellie-wake.service',
  'ellie-wake.timer',
  'proton-bridge.service'
] as const;

const OPERATIONS = ['logs', 'service_status', 'timers', 'processes', 'resources'] as const;

const MAX_OUTPUT_CHARS = 12000;
const MAX_LOG_LINES = 300;
const EXEC_TIMEOUT_MS = 8000;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/xox[abprs]-[A-Za-z0-9-]{8,}/g, '[REDACTED_SLACK_TOKEN]'],
  [/xapp-[A-Za-z0-9-]{8,}/g, '[REDACTED_SLACK_TOKEN]'],
  [/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_KEY]'],
  [/ya29\.[0-9A-Za-z_-]{20,}/g, '[REDACTED_GOOGLE_TOKEN]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED_KEY]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED_JWT]'],
  [/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [REDACTED]'],
  // key=value / key: value / --key value where the key looks secret
  [/((?:token|secret|password|passwd|pass|api[_-]?key|apikey|authorization|credential|signing[_-]?secret|refresh[_-]?token|client[_-]?secret)[A-Za-z0-9_-]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1[REDACTED]'],
  [/(--(?:[a-z-]*(?:token|secret|password|key))\s+)\S+/gi, '$1[REDACTED]'],
  // URL credentials
  [/(\w+:\/\/[^\s:/@]+:)[^\s@/]+@/g, '$1[REDACTED]@']
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

function clipOutput(text: string, keep: 'head' | 'tail' = 'tail'): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
  return {
    text: keep === 'tail' ? text.slice(text.length - MAX_OUTPUT_CHARS) : text.slice(0, MAX_OUTPUT_CHARS),
    truncated: true
  };
}

/** `systemctl --user` and `journalctl --user` need this when the process was not started from a login session. */
function userEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!env.XDG_RUNTIME_DIR && typeof process.getuid === 'function') {
    env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  }
  return env;
}

function run(file: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise(resolve => {
    execFile(
      file,
      args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: userEnv(), shell: false, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error ? ((error as any).code as number | null) ?? 1 : 0;
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: typeof code === 'number' ? code : 1 });
      }
    );
  });
}

function assertUnit(unit: string | undefined): string {
  const found = INSPECTABLE_UNITS.find(u => u === unit);
  if (!found) {
    throw new Error(`[Security Refusal] Unit '${unit ?? ''}' is not inspectable. Allowed: ${INSPECTABLE_UNITS.join(', ')}.`);
  }
  return found;
}

/** Defensive: values go into argv (no shell), but still keep them to a plain journalctl time/priority vocabulary. */
const SINCE_RE = /^(\d{1,3}\s?(min|minute|minutes|hour|hours|day|days)\s+ago|today|yesterday|\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?)$/i;

function shapeProcessLine(line: string): string {
  return redactSecrets(line.length > 260 ? `${line.slice(0, 260)}…` : line);
}

export interface VpsInspectOptions {
  /** Test seam: replaces the command runner. */
  runner?: typeof run;
  /** Test seam: replaces the platform check. */
  platform?: NodeJS.Platform;
}

export function createVpsInspectTool(options: VpsInspectOptions = {}): ToolDefinition {
  const exec = options.runner ?? run;
  const platform = options.platform ?? process.platform;

  return {
    name: 'vps_inspect',
    description:
      'READ-ONLY look at the server Ellie runs on, to find out what is stuck or failing. Operations: ' +
      '"logs" (journal of ellie.service, ellie-wake.service, ellie-wake.timer or proton-bridge.service; filter by text, priority, time), ' +
      '"service_status" (systemctl status of one of those units), "timers" (next/last wake cycle), ' +
      '"processes" (top processes by cpu or memory, and long-running ones), "resources" (load, memory, disk). ' +
      'Cannot change anything: it cannot restart, kill or write. Tell the owner the command to run when action is needed. Secrets are redacted.',
    effectClass: 'READ',
    notEvidence: true,
    schema: z.object({
      operation: z.enum(OPERATIONS).describe('What to inspect.'),
      unit: z.enum(INSPECTABLE_UNITS).optional().describe('For logs and service_status. Default ellie.service.'),
      lines: z.number().int().positive().max(MAX_LOG_LINES).optional().default(100).describe('Log lines (default 100, max 300).'),
      since: z.string().max(40).optional().describe('Logs only: "30 min ago", "2 hours ago", "today", "yesterday" or "YYYY-MM-DD [HH:MM]".'),
      priority: z.enum(['err', 'warning', 'info']).optional().describe('Logs only: this priority and worse. Use "err" to see only errors.'),
      grep: z.string().max(80).optional().describe('Logs only: case-insensitive text the line must contain.'),
      sortBy: z.enum(['cpu', 'mem', 'age']).optional().default('cpu').describe('Processes only: order (age = longest-running first).'),
      limit: z.number().int().positive().max(40).optional().default(20).describe('Processes only: how many (default 20, max 40).')
    }),
    execute: async params => {
      if (platform !== 'linux') {
        return { available: false, reason: `vps_inspect only works on the Linux server (this host is ${platform}).` };
      }

      switch (params.operation) {
        case 'logs': {
          const unit = assertUnit(params.unit ?? 'ellie.service');
          const args = ['--user', '-u', unit, '-n', String(params.lines ?? 100), '--no-pager', '-o', 'short-iso'];
          if (params.since) {
            if (!SINCE_RE.test(params.since.trim())) {
              throw new Error('Invalid "since". Use "30 min ago", "2 hours ago", "today", "yesterday" or "YYYY-MM-DD [HH:MM]".');
            }
            args.push('--since', params.since.trim());
          }
          if (params.priority) args.push('-p', params.priority);
          const res = await exec('journalctl', args);
          if (res.code !== 0 && !res.stdout) {
            return { unit, error: redactSecrets(res.stderr.trim() || 'journalctl failed.') };
          }
          let lines = res.stdout.split('\n');
          if (params.grep) {
            const needle = params.grep.toLowerCase();
            lines = lines.filter(l => l.toLowerCase().includes(needle));
          }
          const clipped = clipOutput(redactSecrets(lines.join('\n')), 'tail');
          return { unit, lineCount: lines.length, truncated: clipped.truncated, log: clipped.text };
        }

        case 'service_status': {
          const unit = assertUnit(params.unit ?? 'ellie.service');
          const res = await exec('systemctl', ['--user', 'status', unit, '--no-pager', '-l', '-n', '15']);
          // systemctl status exits non-zero for inactive/failed units; the text is still the answer.
          const clipped = clipOutput(redactSecrets(res.stdout || res.stderr), 'head');
          return { unit, truncated: clipped.truncated, status: clipped.text.trim() };
        }

        case 'timers': {
          const res = await exec('systemctl', ['--user', 'list-timers', '--all', '--no-pager']);
          return { timers: redactSecrets(res.stdout || res.stderr).trim() };
        }

        case 'processes': {
          const sortKey = params.sortBy === 'mem' ? '-pmem' : params.sortBy === 'age' ? '-etimes' : '-pcpu';
          const res = await exec('ps', ['-eo', 'pid,ppid,user:12,stat,etime,pcpu,pmem,rss,args', `--sort=${sortKey}`]);
          if (res.code !== 0 && !res.stdout) {
            return { error: redactSecrets(res.stderr.trim() || 'ps failed.') };
          }
          const all = res.stdout.split('\n').filter(Boolean);
          const header = all[0] ?? '';
          const rows = all.slice(1);
          const selected = rows.slice(0, params.limit ?? 20).map(shapeProcessLine);
          // Zombies and uninterruptible sleep are the usual "stuck" signatures; always surface them.
          const suspicious = rows.filter(r => /^\s*\d+\s+\d+\s+\S+\s+[ZD]/.test(r)).slice(0, 20).map(shapeProcessLine);
          return {
            sortedBy: params.sortBy ?? 'cpu',
            totalProcesses: rows.length,
            columns: header,
            top: selected,
            zombieOrBlockedProcesses: suspicious
          };
        }

        case 'resources': {
          const [uptime, mem, disk] = await Promise.all([
            exec('uptime', []),
            exec('free', ['-m']),
            exec('df', ['-h', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'squashfs'])
          ]);
          let load: string | undefined;
          try { load = fs.readFileSync('/proc/loadavg', 'utf8').trim(); } catch {}
          return {
            uptime: uptime.stdout.trim(),
            loadavg: load,
            memoryMb: mem.stdout.trim(),
            disk: disk.stdout.trim()
          };
        }

        default:
          throw new Error(`Unknown operation '${(params as any).operation}'.`);
      }
    }
  };
}
