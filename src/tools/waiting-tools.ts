import { z } from 'zod';
import { ToolDefinition } from '../types/tool.js';
import { WaitingRepository, WaitingStatus } from '../storage/waiting-repo.js';

export function createWaitingTools(waitingRepo: WaitingRepository): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // 1. Track waiting item
  tools.push({
    name: 'waiting_track',
    description: 'Tracks an item Ellie or the owner is waiting on (e.g. an email reply, an external deliverable, candidate response, partner decision).',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: z.object({
      counterparty: z.string().describe('Who owes the response or deliverable (e.g. "Jane Doe", "Acme HR", "Vendor Support")'),
      subject: z.string().describe('What is being waited on (e.g. "Revised contract draft", "Confirmation of interview time")'),
      channel: z.enum(['email', 'slack', 'phone', 'other']).optional().default('email').describe('Communication channel where response is expected'),
      thread_ref: z.string().optional().describe('Optional message ID, thread ID, or URL reference'),
      due_at: z.string().optional().describe('Optional ISO date/timestamp by when the reply is expected (e.g. "2026-10-18T12:00:00Z")'),
      status: z.enum(['open', 'nudged', 'resolved']).optional().default('open').describe('Initial status (default: open)')
    }),
    execute: async (params) => {
      const item = waitingRepo.track({
        counterparty: params.counterparty,
        subject: params.subject,
        channel: params.channel,
        thread_ref: params.thread_ref,
        due_at: params.due_at,
        status: params.status as WaitingStatus
      });
      return {
        status: 'tracked',
        item,
        message: `Tracking waiting item: '${item.subject}' from ${item.counterparty} (ID: ${item.id}).`
      };
    },
    verify: async (params, lastKnownResult) => {
      const id = lastKnownResult?.item?.id;
      if (!id) return { outcome: 'FAILED_SAFE', details: 'No item ID returned to verify.' };
      const item = waitingRepo.get(id);
      if (item) {
        return { outcome: 'VERIFIED_SUCCESS', details: `Waiting item ${id} confirmed in store.` };
      }
      return { outcome: 'FAILED_SAFE', details: `Waiting item ${id} not found.` };
    }
  });

  // 2. List waiting items
  tools.push({
    name: 'waiting_list',
    description: 'Lists tracked waiting items (delegated tasks, owed replies, pending reviews). Can filter by status ("active", "open", "nudged", "resolved", "all"), due date, or counterparty.',
    effectClass: 'READ',
    schema: z.object({
      status: z.enum(['active', 'open', 'nudged', 'resolved', 'all']).optional().default('active').describe('Status filter (default: "active", which returns both open and nudged)'),
      due_before: z.string().optional().describe('Optional ISO timestamp: only return items due on or before this time'),
      counterparty: z.string().optional().describe('Optional name/substring filter for counterparty')
    }),
    execute: async (params) => {
      const items = waitingRepo.list({
        status: params.status,
        dueBefore: params.due_before,
        counterparty: params.counterparty
      });
      return {
        count: items.length,
        items
      };
    }
  });

  // 3. Resolve or nudge waiting item
  tools.push({
    name: 'waiting_resolve',
    description: 'Updates a waiting item when the reply/deliverable arrives ("resolved") or when a follow-up ping was sent ("nudged").',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: z.object({
      id: z.string().describe('The waiting item ID (e.g. "wait_172911234_abc")'),
      status: z.enum(['resolved', 'nudged']).optional().default('resolved').describe('New status ("resolved" or "nudged", default: resolved)'),
      notes: z.string().optional().describe('Optional resolution note or context')
    }),
    execute: async (params) => {
      let item = null;
      if (params.status === 'nudged') {
        item = waitingRepo.nudge(params.id);
      } else {
        item = waitingRepo.resolve(params.id, params.notes);
      }
      if (!item) {
        throw new Error(`Waiting item '${params.id}' not found.`);
      }
      return {
        status: item.status,
        item,
        message: `Waiting item '${item.id}' marked as ${item.status}.`
      };
    },
    verify: async (params) => {
      const item = waitingRepo.get(params.id);
      if (!item) return { outcome: 'FAILED_SAFE', details: `Waiting item ${params.id} missing.` };
      if (item.status === (params.status || 'resolved')) {
        return { outcome: 'VERIFIED_SUCCESS', details: `Waiting item ${params.id} confirmed as ${item.status}.` };
      }
      return { outcome: 'FAILED_SAFE', details: `Waiting item ${params.id} status is ${item.status}, expected ${params.status}.` };
    }
  });

  return tools;
}
