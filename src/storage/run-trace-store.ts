import { DatabaseSync } from 'node:sqlite';
import { UnifiedRunResult } from '../types/runner.js';

export interface RunTraceRecord {
  run_id: string;
  trigger: string;
  instruction?: string;
  status: string;
  delivery_mode: string;
  tools_called: string;
  handles_used: string;
  prompt_tokens: number;
  cached_tokens: number;
  thinking_tokens: number;
  candidates_tokens: number;
  total_tokens: number;
  /** Wall-clock run time. */
  duration_ms: number;
  /** Model-call time only (subset of duration_ms). */
  model_ms: number;
  error?: string | null;
  /** What reached Slack for this run (message text, or a note for a card or reaction); null until delivered. */
  delivered_text?: string | null;
  created_at: string;
}

export class RunTraceStore {
  constructor(private readonly db: DatabaseSync) {}

  public recordRun(trigger: string, instruction: string, result: UnifiedRunResult): void {
    const toolsCalledJson = JSON.stringify(
      result.toolCallsExecuted.map(tc => ({
        tool: tc.tool,
        params: tc.params,
        result: tc.result !== undefined ? tc.result : null,
        durationMs: tc.durationMs,
        handle: tc.handle
      }))
    );
    const handlesUsedJson = JSON.stringify(result.handlesCreated);

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO run_traces (
        run_id, trigger, instruction, status, delivery_mode,
        tools_called, handles_used,
        prompt_tokens, cached_tokens, thinking_tokens, candidates_tokens, total_tokens,
        duration_ms, model_ms, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      result.runId,
      trigger,
      instruction,
      result.status,
      result.output.deliveryMode,
      toolsCalledJson,
      handlesUsedJson,
      result.telemetry.promptTokens,
      result.telemetry.cachedTokens,
      result.telemetry.thinkingTokens,
      result.telemetry.candidatesTokens,
      result.telemetry.totalTokens,
      result.wallMs,
      result.telemetry.durationMs,
      result.error || null
    );
  }

  /** Appends what was delivered for a run, so a reply can be checked against its tool results. */
  public recordDelivered(runId: string, text: string): void {
    this.db.prepare(`
      UPDATE run_traces
      SET delivered_text = CASE WHEN delivered_text IS NULL THEN ? ELSE delivered_text || char(10) || ? END
      WHERE run_id = ?
    `).run(text, text, runId);
  }

  public listTraces(limit = 50): RunTraceRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM run_traces
      ORDER BY created_at DESC LIMIT ?
    `);
    return stmt.all(limit) as unknown as RunTraceRecord[];
  }

  public getTrace(runId: string): RunTraceRecord | null {
    const stmt = this.db.prepare('SELECT * FROM run_traces WHERE run_id = ?');
    const res = stmt.get(runId);
    return (res ? (res as unknown as RunTraceRecord) : null);
  }
}
