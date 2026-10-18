import { DatabaseSync } from 'node:sqlite';

export interface ApiUsageRecord {
  id?: number;
  model: string;
  source: string;
  source_id?: string;
  prompt_tokens: number;
  cached_tokens?: number;
  thinking_tokens?: number;
  completion_tokens: number;
  total_tokens: number;
  created_at?: string;
}

export interface ModelCostMetrics {
  callsCount: number;
  promptTokens: number;
  cachedTokens: number;
  thinkingTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface CostBreakdownSummary {
  periodDays: number;
  flash: ModelCostMetrics;
  reasoning: ModelCostMetrics;
  other: ModelCostMetrics;
  totalCostUsd: number;
}

export class CostRepository {
  constructor(private readonly db: DatabaseSync) {}

  public recordUsage(record: ApiUsageRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO api_usage (model, source, source_id, prompt_tokens, cached_tokens, thinking_tokens, completion_tokens, total_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.model,
      record.source,
      record.source_id || null,
      record.prompt_tokens,
      record.cached_tokens || 0,
      record.thinking_tokens || 0,
      record.completion_tokens,
      record.total_tokens
    );
  }

  public countCallsSince(source: string, days = 1): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM api_usage
      WHERE source = ? AND created_at >= datetime('now', '-' || ? || ' days')
    `);
    const row = stmt.get(source, days) as any;
    return Number(row?.count || 0);
  }

  public getSummary(sinceDays = 7): {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    callsCount: number;
    breakdown?: CostBreakdownSummary;
  } {
    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as callsCount,
        COALESCE(SUM(prompt_tokens), 0) as totalPromptTokens,
        COALESCE(SUM(completion_tokens), 0) as totalCompletionTokens,
        COALESCE(SUM(total_tokens), 0) as totalTokens
      FROM api_usage
      WHERE created_at >= datetime('now', '-' || ? || ' days')
    `);
    const row = stmt.get(sinceDays) as any;
    const breakdown = this.getBreakdown(sinceDays);

    return {
      totalPromptTokens: Number(row.totalPromptTokens || 0),
      totalCompletionTokens: Number(row.totalCompletionTokens || 0),
      totalTokens: Number(row.totalTokens || 0),
      callsCount: Number(row.callsCount || 0),
      breakdown
    };
  }

  public getBreakdown(sinceDays = 7): CostBreakdownSummary {
    const stmt = this.db.prepare(`
      SELECT
        model,
        COUNT(*) as callsCount,
        COALESCE(SUM(prompt_tokens), 0) as promptTokens,
        COALESCE(SUM(cached_tokens), 0) as cachedTokens,
        COALESCE(SUM(thinking_tokens), 0) as thinkingTokens,
        COALESCE(SUM(completion_tokens), 0) as completionTokens,
        COALESCE(SUM(total_tokens), 0) as totalTokens
      FROM api_usage
      WHERE created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY model
    `);

    const rows = stmt.all(sinceDays) as any[];

    const initMetrics = (): ModelCostMetrics => ({
      callsCount: 0,
      promptTokens: 0,
      cachedTokens: 0,
      thinkingTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0
    });

    const flash = initMetrics();
    const reasoning = initMetrics();
    const other = initMetrics();

    for (const r of rows) {
      const model = String(r.model || '').toLowerCase();
      const calls = Number(r.callsCount || 0);
      const prompt = Number(r.promptTokens || 0);
      const cached = Number(r.cachedTokens || 0);
      const thinking = Number(r.thinkingTokens || 0);
      const completion = Number(r.completionTokens || 0);
      const total = Number(r.totalTokens || 0);

      // Flash Pricing: $0.75/M input ($0.075 cached), $3.75/M output, $3.75/M thinking
      // Reasoning model pricing (estimate): $2.00/M input ($0.20 cached), $10.00/M output, $10.00/M thinking
      if (model.includes('flash')) {
        flash.callsCount += calls;
        flash.promptTokens += prompt;
        flash.cachedTokens += cached;
        flash.thinkingTokens += thinking;
        flash.completionTokens += completion;
        flash.totalTokens += total;
        // Gemini API's candidatesTokenCount (completion) already includes thoughtsTokenCount.
        const nonCachedPrompt = Math.max(0, prompt - cached);
        flash.estimatedCostUsd += (nonCachedPrompt * 0.75 + cached * 0.075 + completion * 3.75) / 1_000_000;
      } else if (isReasoningModel(model)) {
        reasoning.callsCount += calls;
        reasoning.promptTokens += prompt;
        reasoning.cachedTokens += cached;
        reasoning.thinkingTokens += thinking;
        reasoning.completionTokens += completion;
        reasoning.totalTokens += total;
        const nonCachedPrompt = Math.max(0, prompt - cached);
        reasoning.estimatedCostUsd += (nonCachedPrompt * 2.00 + cached * 0.20 + completion * 10.00) / 1_000_000;
      } else {
        other.callsCount += calls;
        other.promptTokens += prompt;
        other.cachedTokens += cached;
        other.thinkingTokens += thinking;
        other.completionTokens += completion;
        other.totalTokens += total;
        other.estimatedCostUsd += (prompt * 0.20 + completion * 0.80) / 1_000_000;
      }
    }

    flash.estimatedCostUsd = Math.round(flash.estimatedCostUsd * 10000) / 10000;
    reasoning.estimatedCostUsd = Math.round(reasoning.estimatedCostUsd * 10000) / 10000;
    other.estimatedCostUsd = Math.round(other.estimatedCostUsd * 10000) / 10000;
    const totalCostUsd = Math.round((flash.estimatedCostUsd + reasoning.estimatedCostUsd + other.estimatedCostUsd) * 10000) / 10000;

    return {
      periodDays: sinceDays,
      flash,
      reasoning,
      other,
      totalCostUsd
    };
  }
}

/** The configured reasoning model (GEMINI_REASONING_MODEL, or GEMINI_PRO_MODEL from older .env files). */
export function isReasoningModel(model: string): boolean {
  const configured = (process.env.GEMINI_REASONING_MODEL || process.env.GEMINI_PRO_MODEL || '').trim();
  return (configured !== '' && model === configured) || /\bpro\b|-pro|argon|reason/i.test(model);
}
