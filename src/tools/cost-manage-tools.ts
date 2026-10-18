import { z } from 'zod';
import { ToolDefinition } from '../types/tool.js';
import { CostRepository } from '../storage/cost-repo.js';

export function createCostManageTools(costRepo: CostRepository): ToolDefinition[] {
  const costManage: ToolDefinition = {
    name: 'cost_and_budget_manage',
    description: 'Inspect exact API spend, call counts, and token telemetry for Flash vs the reasoning model models from SQLite telemetry. Granted strictly to INTERACTIVE_SLACK runs.',
    effectClass: 'READ',
    schema: z.object({
      action: z.enum(['today', 'this_week', 'summary']).describe('Time window for cost telemetry'),
      days: z.number().min(1).max(90).optional().default(7).describe('Custom days window for summary action')
    }),
    execute: async (args) => {
      let days = args.days || 7;
      if (args.action === 'today') days = 1;
      if (args.action === 'this_week') days = 7;

      const breakdown = costRepo.getBreakdown(days);
      const summary = costRepo.getSummary(days);

      return {
        window: args.action === 'today' ? 'today' : args.action === 'this_week' ? 'past 7 days' : `past ${days} days`,
        days,
        totalCostUsd: breakdown.totalCostUsd,
        totalCalls: summary.callsCount,
        flash: {
          callsCount: breakdown.flash.callsCount,
          estimatedCostUsd: breakdown.flash.estimatedCostUsd,
          promptTokens: breakdown.flash.promptTokens,
          cachedTokens: breakdown.flash.cachedTokens,
          thinkingTokens: breakdown.flash.thinkingTokens,
          completionTokens: breakdown.flash.completionTokens,
          totalTokens: breakdown.flash.totalTokens
        },
        reasoning: {
          callsCount: breakdown.reasoning.callsCount,
          estimatedCostUsd: breakdown.reasoning.estimatedCostUsd,
          promptTokens: breakdown.reasoning.promptTokens,
          cachedTokens: breakdown.reasoning.cachedTokens,
          thinkingTokens: breakdown.reasoning.thinkingTokens,
          completionTokens: breakdown.reasoning.completionTokens,
          totalTokens: breakdown.reasoning.totalTokens
        },
        other: breakdown.other.callsCount > 0 ? breakdown.other : undefined
      };
    }
  };

  return [costManage];
}
