import { z } from 'zod';
import { ToolDefinition } from '../types/tool.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { MemoryRepository } from '../storage/memory-repo.js';

export function createQueueManageTools(
  ledgerRepo: ActionLedgerRepository,
  memoryRepo?: MemoryRepository
): ToolDefinition[] {
  const queueManage: ToolDefinition = {
    name: 'queue_manage',
    description: 'Approval queue inspection and draft management (list_staged, update_staged_payload, drop_action, drop_batch, clear_stale). Strictly prohibited from approving or executing consequential actions. Granted strictly to INTERACTIVE_SLACK runs.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: z.object({
      action: z.enum([
        'list_staged',
        'update_staged_payload',
        'drop_action',
        'drop_batch',
        'clear_stale'
      ]).describe('Action to perform on the approval queue (approve and execute are strictly prohibited)'),
      action_id: z.string().optional().describe('Action ID (for update_staged_payload, drop_action)'),
      batch_id: z.string().optional().describe('Batch ID (for drop_batch or filtering list_staged)'),
      payload: z.record(z.string(), z.any()).optional().describe('Updated JSON payload (for update_staged_payload)'),
      max_age_hours: z.number().optional().default(24).describe('Maximum age in hours before dropping staged action (for clear_stale)'),
      reason: z.string().optional().describe('Reason for dropping action or batch')
    }),
    execute: async (args, context) => {
      const actor = `slack:${context.slackOrigin?.user || 'owner'}`;

      switch (args.action) {
        case 'list_staged': {
          const staged = ledgerRepo.listStaged(args.batch_id);
          return {
            count: staged.length,
            batchId: args.batch_id || null,
            actions: staged.map(a => {
              let parsedPayload: any = {};
              try { parsedPayload = JSON.parse(a.payload_json); } catch {}
              return {
                id: a.id,
                action_type: a.action_type,
                created_at: a.created_at,
                expires_at: a.expires_at,
                batch_id: a.batch_id || null,
                payload: parsedPayload
              };
            })
          };
        }

        case 'update_staged_payload': {
          if (!args.action_id || !args.payload) {
            throw new Error('action_id and payload are required to update staged draft.');
          }
          const updated = ledgerRepo.updateStagedPayload(args.action_id, args.payload, actor);
          return {
            status: 'payload_updated',
            id: updated.id,
            action_type: updated.action_type,
            payloadHash: updated.payload_hash
          };
        }

        case 'drop_action': {
          if (!args.action_id) {
            throw new Error('action_id is required to drop an action.');
          }
          const dropped = ledgerRepo.dropAction(args.action_id, actor, args.reason || 'Dropped from Slack');
          if (memoryRepo && dropped?.action_type && typeof memoryRepo.recordNegativeEvidence === 'function') {
            memoryRepo.recordNegativeEvidence(dropped.action_type);
          }
          return {
            status: 'dropped',
            id: dropped.id,
            action_type: dropped.action_type,
            state: dropped.state
          };
        }

        case 'drop_batch': {
          if (!args.batch_id) {
            throw new Error('batch_id is required to drop a batch.');
          }
          const count = ledgerRepo.dropBatch(args.batch_id, actor, args.reason || 'Batch dropped from Slack');
          return {
            status: 'batch_dropped',
            batchId: args.batch_id,
            droppedCount: count
          };
        }

        case 'clear_stale': {
          const count = ledgerRepo.clearStale(args.max_age_hours || 24, actor);
          return {
            status: 'stale_cleared',
            clearedCount: count,
            maxAgeHours: args.max_age_hours || 24
          };
        }
      }
    },
    verify: async (params) => {
      if (params.action === 'drop_action') {
        const item = ledgerRepo.get(params.action_id!);
        return {
          outcome: item?.state === 'DENIED' ? 'VERIFIED_SUCCESS' : 'FAILED_SAFE',
          details: `Action ${params.action_id} state is ${item?.state}.`
        };
      }
      return { outcome: 'VERIFIED_SUCCESS' };
    }
  };

  return [queueManage];
}
