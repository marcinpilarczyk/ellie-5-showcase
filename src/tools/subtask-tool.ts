import { z } from 'zod';
import { COMMAND_AND_CONTROL_TOOL_NAMES, ToolDefinition, ToolExecutionContext } from '../types/tool.js';
import type { UnifiedAgentRunner } from '../agent/runner.js';
import type { ResultStore } from '../storage/result-store.js';

export function createSubtaskTools(runner: UnifiedAgentRunner, resultStore?: ResultStore): ToolDefinition[] {
  const delegateSubtask: ToolDefinition = {
    name: 'delegate_subtask',
    description: 'Delegate a focused research, calculation, or investigation subtask to an agentic sub-round. The sub-round runs autonomously with its own fresh context and returns the synthesized finding back to you, preventing raw tool outputs from bloating your context. Subtasks are strictly read-only.',
    effectClass: 'READ',
    schema: z.object({
      task: z.string().describe('Clear, self-contained instruction for what the subtask must investigate, calculate, or produce'),
      expected_output: z.string().optional().describe('Description of the specific data format or answer expected'),
      tools: z.array(z.string()).optional().describe('Optional list of tool names to grant to the subtask. Only READ tools are permitted; defaults to all granted read tools'),
      tier: z.enum(['FAST', 'ANALYSIS']).optional().default('FAST').describe("Model tier: 'FAST' (Flash) for quick lookups, 'ANALYSIS' (Reasoning model) for deep synthesis. Defaults to FAST"),
      max_rounds: z.number().min(1).max(6).optional().default(4).describe('Maximum rounds for the subtask (1-6, default 4)')
    }),
    execute: async (args, context: ToolExecutionContext) => {
      // 1. Guard against recursive nesting
      const currentDepth = context.subtaskDepth || 0;
      if (currentDepth >= 1) {
        return {
          status: 'REFUSED',
          error: 'Subtask nesting limit reached: a subtask cannot delegate to another subtask.'
        };
      }

      // 2. Resolve granted tools: strictly READ tools only, no C&C, no delegate_subtask
      const dispatcher = typeof runner.getDispatcher === 'function'
        ? runner.getDispatcher()
        : (runner as any).dispatcher || (runner as any)['dispatcher'];
      const allTools: any[] = dispatcher ? dispatcher.getAllTools() : [];
      const readToolNames = new Set<string>(
        allTools
          .filter((t: any) => t.effectClass === 'READ' && t.name !== 'delegate_subtask' && !COMMAND_AND_CONTROL_TOOL_NAMES.has(t.name))
          .map((t: any) => t.name as string)
      );

      const subtaskAllowedTools = new Set<string>();
      if (args.tools && args.tools.length > 0) {
        for (const t of args.tools) {
          if (readToolNames.has(t) && context.toolGrant.allowedToolNames.has(t)) {
            subtaskAllowedTools.add(t);
          }
        }
      } else {
        // Intersect caller's grant with available read tools
        for (const t of readToolNames) {
          if (context.toolGrant.allowedToolNames.has(t)) {
            subtaskAllowedTools.add(t);
          }
        }
      }

      // Ensure skills and result_read are always granted to subtasks
      ['result_read', 'sheet_query', 'skills_list', 'skill_read'].forEach(t => {
        if (readToolNames.has(t)) subtaskAllowedTools.add(t);
      });

      // 3. Run subtask
      const subtaskRunId = `subtask_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const instruction = args.expected_output
        ? `${args.task}\n\nExpected Output Format: ${args.expected_output}`
        : args.task;

      const subtaskResult = await runner.run({
        runId: subtaskRunId,
        trigger: 'subtask',
        instruction,
        tier: args.tier === 'ANALYSIS' ? 'ANALYSIS' : 'INTERACTIVE',
        isInteractive: false,
        subtaskDepth: currentDepth + 1,
        maxRounds: Math.min(Math.max(args.max_rounds || 4, 1), 6),
        timeBudgetMs: 120_000,
        toolGrant: {
          allowedToolNames: subtaskAllowedTools,
          allowConsequential: false
        },
        slackOrigin: context.slackOrigin
      });

      const deliverable = subtaskResult.output.slackMessage
        || subtaskResult.output.coworkerHeadline
        || subtaskResult.output.summary
        || '';

      let handle: string | undefined;
      // If output is substantial (> 1800 chars), keep in ResultStore
      if (deliverable.length > 1800 && resultStore) {
        handle = resultStore.keep(subtaskRunId, 'delegate_subtask', deliverable);
      }

      return {
        status: subtaskResult.status,
        deliverable: handle ? deliverable.slice(0, 1500) + `\n... [Full content stored in handle ${handle}]` : deliverable,
        handle,
        toolsCalled: subtaskResult.toolCallsExecuted.map(tc => tc.tool),
        totalTokens: subtaskResult.telemetry.totalTokens,
        roundsUsed: subtaskResult.toolCallsExecuted.length
      };
    }
  };

  return [delegateSubtask];
}
