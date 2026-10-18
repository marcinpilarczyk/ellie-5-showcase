import { DatabaseSync } from 'node:sqlite';
import type { UnifiedRunResult } from '../types/runner.js';
import { ResultStore, RESULT_READER_TOOLS, NON_EVIDENCE_TOOLS } from './result-store.js';

const MAX_SUMMARY_CHARS = 4000;
const MAX_ENTRIES = 25;
/** Results longer than this are kept in the Result Store, so a later run can reopen them in full. */
const KEEP_INLINE_CHARS = 300;
/** A carried result up to this size goes into the follow-up in full (one Result Store threshold). */
const INLINE_RESULT_MAX_CHARS = 6000;
/** All inlined carried results together; every round re-sends them. */
const INLINE_BUDGET_CHARS = 4000;

function preview(value: unknown, max: number): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

interface CarryoverEntry {
  tool: string;
  params: string;
  outcome: string;
  handle?: string;
  error?: boolean;
  runId: string;
}

/**
 * Evidence from the runs in a Slack thread. Slack history only carries what was said; this carries
 * what was found (tool results, result-store handles, created links), so a follow-up or "continue"
 * builds on the earlier work instead of redoing it. It accumulates across every run in the thread:
 * a source read three runs ago stays reachable, and anything longer than a line is kept in the
 * Result Store under a handle, so the model reopens it with one result_read instead of digging
 * through old traces.
 */
export class ThreadCarryoverRepository {
  constructor(private readonly db: DatabaseSync, private readonly resultStore?: ResultStore) {}

  /** One run on its own (no Result Store, no merge). */
  public static summarize(run: UnifiedRunResult): string {
    return ThreadCarryoverRepository.render(run, ThreadCarryoverRepository.entriesFrom(run));
  }

  private static entriesFrom(run: UnifiedRunResult, resultStore?: ResultStore): CarryoverEntry[] {
    return run.toolCallsExecuted
      // Readers point at handles that are already listed; non-evidence/diagnostic tools add nothing to carry.
      .filter(call => !RESULT_READER_TOOLS.has(call.tool) && !NON_EVIDENCE_TOOLS.has(call.tool))
      .map(call => {
        const error = Boolean(call.result && typeof call.result === 'object' && 'error' in call.result);
        let handle = call.handle;
        if (!handle && !error && resultStore && preview(call.result, KEEP_INLINE_CHARS + 1).length > KEEP_INLINE_CHARS) {
          handle = resultStore.keep(run.runId, call.tool, call.result, { notEvidence: call.notEvidence });
        }
        return {
          tool: call.tool,
          params: preview(call.params ?? {}, 160),
          outcome: handle ? `stored as handle ${handle} (read it with result_read)` : preview(call.result, KEEP_INLINE_CHARS),
          handle,
          error,
          runId: run.runId
        };
      });
  }

  private static render(run: UnifiedRunResult, entries: CarryoverEntry[]): string {
    const header = `Latest run ${run.runId} ended with status ${run.output.finishStatus ?? run.status}: ${preview(run.output.summary ?? '', 200)}`;
    const lines = entries.map(e => `- ${e.tool}(${e.params}) -> ${e.outcome}${e.runId !== run.runId ? ` [earlier run ${e.runId}]` : ''}`);
    // Oldest entries go first when space runs out.
    while (lines.length > 0 && [header, ...lines].join('\n').length > MAX_SUMMARY_CHARS) lines.shift();
    return [header, ...lines].join('\n');
  }

  public save(threadKey: string, run: UnifiedRunResult): void {
    if (run.toolCallsExecuted.length === 0) return;
    const fresh = ThreadCarryoverRepository.entriesFrom(run, this.resultStore);
    const key = (e: CarryoverEntry) => `${e.tool}:${e.params}`;
    const freshKeys = new Set(fresh.map(key));
    // Earlier runs keep what they found; their failures and anything this run redid are dropped.
    const earlier = this.entries(threadKey).filter(e => !e.error && !freshKeys.has(key(e)));
    const merged = [...earlier, ...fresh].slice(-MAX_ENTRIES);

    this.db.prepare(`
      INSERT INTO thread_carryover (thread_key, run_id, summary, entries_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(thread_key) DO UPDATE SET
        run_id = excluded.run_id, summary = excluded.summary, entries_json = excluded.entries_json, updated_at = excluded.updated_at
    `).run(threadKey, run.runId, ThreadCarryoverRepository.render(run, merged), JSON.stringify(merged), new Date().toISOString());
  }

  private entries(threadKey: string): CarryoverEntry[] {
    const row = this.db.prepare('SELECT entries_json FROM thread_carryover WHERE thread_key = ?').get(threadKey) as { entries_json: string | null } | undefined;
    if (!row?.entries_json) return [];
    try {
      return JSON.parse(row.entries_json) as CarryoverEntry[];
    } catch {
      return [];
    }
  }

  /**
   * Carried results short enough to go straight into a follow-up (newest first, within a budget), so
   * reopening them costs no result_read round. Longer ones stay behind their handle.
   */
  public inlineResults(threadKey: string, maxEach = INLINE_RESULT_MAX_CHARS, budget = INLINE_BUDGET_CHARS): Array<{ handle: string; tool: string; params: string; text: string }> {
    if (!this.resultStore) return [];
    const out: Array<{ handle: string; tool: string; params: string; text: string }> = [];
    let used = 0;
    for (const e of [...this.entries(threadKey)].reverse()) {
      if (!e.handle || e.error) continue;
      let read;
      try { read = this.resultStore.readSlice(e.handle, { maxChars: maxEach }); } catch { continue; }
      if (read.totalChars > maxEach || used + read.totalChars > budget) continue;
      out.push({ handle: e.handle, tool: e.tool, params: e.params, text: read.slice });
      used += read.totalChars;
    }
    return out;
  }

  public getResultStore(): ResultStore | undefined {
    return this.resultStore;
  }

  public recordHandle(threadKey: string, runId: string, tool: string, params: string, handle: string, outcome?: string): void {
    const existing = this.entries(threadKey);
    if (existing.some(e => e.handle === handle)) return;

    const outcomeText = outcome
      ? `stored as handle ${handle} (${outcome})`
      : `stored as handle ${handle} (query it with sheet_query or result_read)`;

    const newEntry: CarryoverEntry = {
      tool,
      params,
      outcome: outcomeText,
      handle,
      error: false,
      runId
    };
    const merged = [...existing, newEntry].slice(-MAX_ENTRIES);
    const summary = this.get(threadKey);
    const updatedSummary = summary
      ? `${summary}\n- ${newEntry.tool}(${newEntry.params}) -> ${newEntry.outcome}`
      : `Attached spreadsheet carryover:\n- ${newEntry.tool}(${newEntry.params}) -> ${newEntry.outcome}`;

    this.db.prepare(`
      INSERT INTO thread_carryover (thread_key, run_id, summary, entries_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(thread_key) DO UPDATE SET
        run_id = excluded.run_id, summary = excluded.summary, entries_json = excluded.entries_json, updated_at = excluded.updated_at
    `).run(threadKey, runId, updatedSummary, JSON.stringify(merged), new Date().toISOString());
  }

  public get(threadKey: string): string | null {
    const row = this.db.prepare('SELECT summary FROM thread_carryover WHERE thread_key = ?').get(threadKey) as { summary: string } | undefined;
    return row?.summary ?? null;
  }
}
