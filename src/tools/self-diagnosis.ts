import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import child_process from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ToolDefinition } from '../types/tool.js';
import { ResultStore, RESULT_STORE_THRESHOLD } from '../storage/result-store.js';
import { RunTraceStore } from '../storage/run-trace-store.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { createVpsInspectTool } from './vps-inspect.js';

export const SELF_DIAGNOSIS_TOOL_NAMES = [
  'repo_list_and_search',
  'repo_read_file',
  'trace_inspect_recent',
  'vps_inspect'
] as const;

export interface SelfDiagnosisToolsOptions {
  appDb?: DatabaseSync;
  ledgerDb?: DatabaseSync;
  runTraceStore?: RunTraceStore;
  ledgerRepo?: ActionLedgerRepository;
  resultStore?: ResultStore;
  repoRoot?: string;
}

export function resolveRepoRoot(customRoot?: string): string {
  if (customRoot && fs.existsSync(customRoot)) {
    return fs.realpathSync(customRoot);
  }
  if (process.env.ELLIE_REPO_ROOT && fs.existsSync(process.env.ELLIE_REPO_ROOT)) {
    return fs.realpathSync(process.env.ELLIE_REPO_ROOT);
  }
  if (fs.existsSync('/home/ellie/ellie')) {
    return fs.realpathSync('/home/ellie/ellie');
  }
  return fs.realpathSync(process.cwd());
}

/**
 * SECURITY HARD RULE:
 * Resolve canonical paths and strictly DENY access in host code to:
 * - .env*
 * - private/*
 * - *.sqlite*
 * - Any path resolving outside the repository root.
 */
export function assertSafeRepoPath(inputPath: string, repoRoot: string): { realPath: string; relPath: string } {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('[Security Refusal] File path must be a non-empty string.');
  }

  const realRepoRoot = resolveRepoRoot(repoRoot);
  let normalized = inputPath.trim().replace(/\\/g, '/');

  // Strip leading standard VPS path /home/ellie/ellie/ if provided
  if (normalized.startsWith('/home/ellie/ellie/')) {
    normalized = normalized.slice('/home/ellie/ellie/'.length);
  } else if (normalized === '/home/ellie/ellie') {
    normalized = '.';
  }

  // Also strip realRepoRoot prefix if absolute path matching realRepoRoot was passed
  const realRepoRootNorm = realRepoRoot.replace(/\\/g, '/');
  if (normalized.toLowerCase().startsWith(realRepoRootNorm.toLowerCase() + '/')) {
    normalized = normalized.slice(realRepoRootNorm.length + 1);
  }

  // Pre-check raw path segments before disk resolution
  const rawSegments = normalized.split('/').map(s => s.toLowerCase());
  if (rawSegments.some(s => s.startsWith('.env'))) {
    throw new Error('[Security Refusal] Access denied: access to .env files is strictly forbidden.');
  }
  if (rawSegments.includes('private')) {
    throw new Error('[Security Refusal] Access denied: access to private directory is strictly forbidden.');
  }
  if (rawSegments.some(s => s.includes('.sqlite'))) {
    throw new Error('[Security Refusal] Access denied: access to sqlite database files is strictly forbidden.');
  }

  const candidatePath = path.resolve(realRepoRoot, normalized);
  const relCandidate = path.relative(realRepoRoot, candidatePath).replace(/\\/g, '/');
  if (relCandidate.startsWith('..') || path.isAbsolute(relCandidate)) {
    throw new Error(`[Security Refusal] Access denied: path '${inputPath}' resolves outside repository root.`);
  }

  if (!fs.existsSync(candidatePath)) {
    throw new Error(`[NotFound] File does not exist: ${inputPath}`);
  }

  // Resolve canonical path following symlinks
  const realTarget = fs.realpathSync(candidatePath);
  const rel = path.relative(realRepoRoot, realTarget).replace(/\\/g, '/');

  // Strictly check that path is inside repo root
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`[Security Refusal] Access denied: path '${inputPath}' resolves outside repository root.`);
  }

  const canonicalSegments = rel.split('/').map(s => s.toLowerCase());

  // Strictly DENY access to .env*
  if (canonicalSegments.some(s => s.startsWith('.env'))) {
    throw new Error('[Security Refusal] Access denied: access to .env files is strictly forbidden.');
  }

  // Strictly DENY access to private/*
  if (canonicalSegments.includes('private')) {
    throw new Error('[Security Refusal] Access denied: access to private directory is strictly forbidden.');
  }

  // Strictly DENY access to *.sqlite*
  if (canonicalSegments.some(s => s.includes('.sqlite'))) {
    throw new Error('[Security Refusal] Access denied: access to sqlite database files is strictly forbidden.');
  }

  if (!fs.statSync(realTarget).isFile()) {
    throw new Error(`[Security Refusal] Path is a directory, not a file: ${inputPath}`);
  }

  // Allowed areas: src/, skills/, or allowed root files
  const isSrc = rel.startsWith('src/');
  const isSkills = rel.startsWith('skills/');
  const isRootAllowed = ['package.json', 'tsconfig.json', 'readme.md'].includes(rel.toLowerCase());

  if (!isSrc && !isSkills && !isRootAllowed) {
    throw new Error(`[Security Refusal] Access denied: '${inputPath}' is not in src/, skills/, or package.json.`);
  }

  return { realPath: realTarget, relPath: rel };
}

function collectSafeFiles(repoRoot: string, pathPrefix?: string): string[] {
  const realRepoRoot = resolveRepoRoot(repoRoot);
  const results: string[] = [];

  const allowedTopDirs = ['src', 'skills'];
  const allowedRootFiles = ['package.json'];

  let targetPrefix = pathPrefix?.trim().replace(/\\/g, '/') || '';
  if (targetPrefix.startsWith('/home/ellie/ellie/')) {
    targetPrefix = targetPrefix.slice('/home/ellie/ellie/'.length);
  }

  if (targetPrefix) {
    const candidate = path.resolve(realRepoRoot, targetPrefix);
    const rel = path.relative(realRepoRoot, candidate).replace(/\\/g, '/');
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`[Security Refusal] pathPrefix '${pathPrefix}' resolves outside repository root.`);
    }
    const segs = rel.split('/').map(s => s.toLowerCase());
    if (segs.some(s => s.startsWith('.env') || s === 'private' || s.includes('.sqlite'))) {
      throw new Error('[Security Refusal] pathPrefix targets forbidden directories.');
    }
  }

  function walk(currentDir: string) {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const rel = path.relative(realRepoRoot, fullPath).replace(/\\/g, '/');
      const lowerName = entry.name.toLowerCase();

      // Skip forbidden directories & files
      if (
        lowerName.startsWith('.env') ||
        lowerName === 'private' ||
        lowerName === 'node_modules' ||
        lowerName === '.git' ||
        lowerName === 'dist' ||
        lowerName === '.test-data' ||
        lowerName.includes('.sqlite')
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        if (
          rel.startsWith('src/') ||
          rel.startsWith('skills/') ||
          rel.toLowerCase() === 'package.json'
        ) {
          if (!targetPrefix || rel.startsWith(targetPrefix)) {
            results.push(rel);
          }
        }
      }
    }
  }

  for (const topDir of allowedTopDirs) {
    const fullTop = path.join(realRepoRoot, topDir);
    if (fs.existsSync(fullTop)) {
      walk(fullTop);
    }
  }

  for (const rootFile of allowedRootFiles) {
    const fullFile = path.join(realRepoRoot, rootFile);
    if (fs.existsSync(fullFile)) {
      const rel = path.relative(realRepoRoot, fullFile).replace(/\\/g, '/');
      if (!targetPrefix || rel.startsWith(targetPrefix)) {
        results.push(rel);
      }
    }
  }

  return results.sort();
}

function getRecentGitLog(repoRoot: string): string {
  try {
    const log = child_process.execSync('git log -n 10 --oneline', {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return log.trim();
  } catch (err: any) {
    return 'git log unavailable or not a git repository.';
  }
}

export function createRepoListAndSearchTool(repoRoot?: string): ToolDefinition {
  return {
    name: 'repo_list_and_search',
    description: 'Lists files or searches text across /home/ellie/ellie/src, skills, and package.json (plus git log -n 10 --oneline).',
    effectClass: 'READ',
    notEvidence: true,
    schema: z.object({
      query: z.string().optional().describe('Text query to search across files (case-insensitive substring). If omitted, lists available files.'),
      pathPrefix: z.string().optional().describe('Optional relative subdirectory to restrict the list or search to (e.g. "src/agent" or "skills")'),
      includeGitLog: z.boolean().optional().default(true).describe('Whether to include the last 10 git log commits (default true)')
    }),
    execute: async (params) => {
      const root = resolveRepoRoot(repoRoot);
      const gitLog = params.includeGitLog !== false ? getRecentGitLog(root) : undefined;

      if (params.query && params.query.trim()) {
        const queryLower = params.query.trim().toLowerCase();
        const files = collectSafeFiles(root, params.pathPrefix);
        const matches: Array<{ file: string; line: number; text: string }> = [];

        for (const relFile of files) {
          const fullPath = path.join(root, relFile);
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(queryLower)) {
                matches.push({
                  file: relFile,
                  line: i + 1,
                  text: lines[i].trim().slice(0, 200)
                });
                if (matches.length >= 100) break;
              }
            }
          } catch {}
          if (matches.length >= 100) break;
        }

        return {
          gitLog,
          query: params.query,
          matchesCount: matches.length,
          matches
        };
      }

      const files = collectSafeFiles(root, params.pathPrefix);
      return {
        gitLog,
        filesCount: files.length,
        files
      };
    }
  };
}

export function createRepoReadFileTool(options?: { repoRoot?: string; resultStore?: ResultStore }): ToolDefinition {
  const root = options?.repoRoot;
  const resultStore = options?.resultStore;

  return {
    name: 'repo_read_file',
    description: 'Reads a specific source file or line range from /home/ellie/ellie/src or skills (large files are routed through the Result Store). Strictly denies access to .env*, private/*, *.sqlite*, or paths outside repo.',
    effectClass: 'READ',
    notEvidence: true,
    schema: z.object({
      filePath: z.string().describe('File path to read from src, skills, or package.json (e.g. "src/agent/runner.ts", "skills/poprawna-polszczyzna/SKILL.md", "package.json")'),
      startLine: z.number().int().positive().optional().describe('1-based start line number (inclusive)'),
      endLine: z.number().int().positive().optional().describe('1-based end line number (inclusive)')
    }),
    execute: async (params, context) => {
      const repoRoot = resolveRepoRoot(root);
      const { realPath, relPath } = assertSafeRepoPath(params.filePath, repoRoot);

      const rawContent = fs.readFileSync(realPath, 'utf8');
      const lines = rawContent.split(/\r?\n/);
      const totalLines = lines.length;

      const start = params.startLine ? Math.max(1, params.startLine) : 1;
      const end = params.endLine ? Math.min(totalLines, Math.max(start, params.endLine)) : totalLines;

      if (start > totalLines) {
        throw new Error(`Start line (${start}) exceeds total lines in file (${totalLines}).`);
      }

      const selectedLines = lines.slice(start - 1, end);
      const numberedContent = selectedLines
        .map((line, idx) => `${start + idx}: ${line}`)
        .join('\n');

      const output = {
        filePath: relPath,
        startLine: start,
        endLine: end,
        totalLines,
        content: numberedContent
      };

      if (resultStore) {
        const serialized = JSON.stringify(output, null, 2);
        if (serialized.length > RESULT_STORE_THRESHOLD) {
          const runId = context?.runId || `run_diag_${Date.now()}`;
          const intercepted = resultStore.intercept(runId, 'repo_read_file', output, { notEvidence: true });
          if (intercepted.isStored) {
            return intercepted;
          }
        }
      }

      return output;
    }
  };
}

const DIGEST_CHARS = 300;

function clip(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return text.length > DIGEST_CHARS ? `${text.slice(0, DIGEST_CHARS)}…` : text;
}

/**
 * A traced call for diagnosis: errors in full, everything else as a short preview or its Result
 * Store handle. Full results made one trace_inspect_recent call 246k chars (run_1792048853034_vn796ce).
 */
function digestToolCall(call: any): any {
  const result = call?.result;
  const isError = result && typeof result === 'object' && 'error' in result;
  const paramsText = JSON.stringify(call?.params ?? {}) ?? '';
  return {
    tool: call?.tool,
    params: paramsText.length <= DIGEST_CHARS ? call?.params : clip(paramsText),
    result: isError ? result
      : result && typeof result === 'object' && result.isStored && result.handle ? { handle: result.handle }
      : clip(result),
    durationMs: call?.durationMs
  };
}

export function createTraceInspectRecentTool(options: {
  appDb?: DatabaseSync;
  ledgerDb?: DatabaseSync;
}): ToolDefinition {
  return {
    name: 'trace_inspect_recent',
    description: 'For diagnosing a failure only: the last N run traces (each tool call with its parameters, errors in full, other results as a short preview or handle), action_ledger entries and errors. Not for recovering earlier work: that is listed with handles in the thread context.',
    effectClass: 'READ',
    notEvidence: true,
    schema: z.object({
      limit: z.number().int().positive().max(50).optional().default(5).describe('Number of recent runs or actions to inspect (default 5, max 50)'),
      errorsOnly: z.boolean().optional().default(false).describe('Filter to only show runs or actions that had errors or failed-safe status'),
      includeLedger: z.boolean().optional().default(true).describe('Whether to include recent action_ledger proposals and events (default true)')
    }),
    execute: async (params) => {
      const limit = params.limit || 5;
      const appDb = options.appDb;
      const ledgerDb = options.ledgerDb;

      let runTraces: any[] = [];
      let stagedOrExecutedActions: any[] = [];
      const recentErrors: string[] = [];

      // 1. Query run_traces from appDb
      if (appDb) {
        try {
          const sql = params.errorsOnly
            ? `SELECT * FROM run_traces WHERE error IS NOT NULL AND error != '' ORDER BY created_at DESC LIMIT ?`
            : `SELECT * FROM run_traces ORDER BY created_at DESC LIMIT ?`;
          const rows = appDb.prepare(sql).all(limit) as any[];

          runTraces = rows.map(r => {
            let toolsCalled = [];
            let handlesUsed = [];
            try { toolsCalled = JSON.parse(r.tools_called).map(digestToolCall); } catch {}
            try { handlesUsed = JSON.parse(r.handles_used); } catch {}

            if (r.error) {
              recentErrors.push(`[Run ${r.run_id}] ${r.error}`);
            }

            return {
              runId: r.run_id,
              trigger: r.trigger,
              instruction: r.instruction,
              status: r.status,
              deliveryMode: r.delivery_mode,
              toolsCalled,
              handlesUsed,
              durationMs: r.duration_ms,
              modelMs: r.model_ms,
              error: r.error,
              createdAt: r.created_at
            };
          });
        } catch (err: any) {
          recentErrors.push(`Failed querying run_traces: ${err.message}`);
        }
      }

      // 2. Query action_ledger from ledgerDb
      if (ledgerDb && params.includeLedger !== false) {
        try {
          const sql = params.errorsOnly
            ? `SELECT * FROM action_ledger WHERE (last_error IS NOT NULL AND last_error != '') OR state IN ('FAILED_SAFE', 'RECONCILIATION_REQUIRED', 'DENIED') ORDER BY created_at DESC LIMIT ?`
            : `SELECT * FROM action_ledger ORDER BY created_at DESC LIMIT ?`;
          const rows = ledgerDb.prepare(sql).all(limit) as any[];

          for (const r of rows) {
            let payload: any = r.payload_json;
            try { payload = JSON.parse(r.payload_json); } catch {}

            let events: any[] = [];
            try {
              events = ledgerDb.prepare(`
                SELECT from_state, to_state, actor, reason, event_data, created_at
                FROM action_ledger_events
                WHERE action_id = ?
                ORDER BY id ASC
              `).all(r.id) as any[];
            } catch {}

            if (r.last_error) {
              recentErrors.push(`[Action ${r.id}] ${r.last_error}`);
            }

            stagedOrExecutedActions.push({
              actionId: r.id,
              actionType: r.action_type,
              state: r.state,
              payload,
              originRunId: r.origin_run_id,
              slackThreadTs: r.slack_thread_ts,
              lastError: r.last_error,
              createdAt: r.created_at,
              executedAt: r.executed_at,
              verifiedAt: r.verified_at,
              events: events.map(e => ({
                from: e.from_state,
                to: e.to_state,
                actor: e.actor,
                reason: e.reason,
                eventData: e.event_data
              }))
            });
          }
        } catch (err: any) {
          recentErrors.push(`Failed querying action_ledger: ${err.message}`);
        }
      }

      return {
        runTracesCount: runTraces.length,
        runTraces,
        actionsCount: stagedOrExecutedActions.length,
        stagedOrExecutedActions,
        recentErrorsCount: recentErrors.length,
        recentErrors
      };
    }
  };
}

export function createSelfDiagnosisTools(options: SelfDiagnosisToolsOptions): ToolDefinition[] {
  return [
    createRepoListAndSearchTool(options.repoRoot),
    createRepoReadFileTool({ repoRoot: options.repoRoot, resultStore: options.resultStore }),
    createTraceInspectRecentTool({ appDb: options.appDb, ledgerDb: options.ledgerDb }),
    createVpsInspectTool()
  ];
}
