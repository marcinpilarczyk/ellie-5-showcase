import { z } from 'zod';
import { ToolDefinition } from '../types/tool.js';
import { RoutineRepository } from '../storage/routine-repo.js';
import { GmailSentinel } from '../scheduler/sentinels/gmail-sentinel.js';
import { CalendarSentinel } from '../scheduler/sentinels/calendar-sentinel.js';
import { ProtonSentinel } from '../scheduler/sentinels/proton-sentinel.js';

export function createSentinelManageTools(
  routineRepo: RoutineRepository,
  gmailSentinel?: GmailSentinel,
  calendarSentinel?: CalendarSentinel,
  protonSentinel?: ProtonSentinel
): ToolDefinition[] {
  const sentinelManage: ToolDefinition = {
    name: 'sentinel_manage',
    description: 'Control inbound sentinels (Gmail, Proton, Calendar) and manage VIP / ignore sender rules from Slack. Granted strictly to INTERACTIVE_SLACK runs.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: z.object({
      action: z.enum([
        'list',
        'enable',
        'disable',
        'run_now',
        'add_rule',
        'remove_rule',
        'list_rules'
      ]).describe('Action to perform on sentinels or sender rules'),
      sentinel_id: z.enum([
        'gmail_sentinel',
        'calendar_sentinel',
        'proton_sentinel'
      ]).optional().describe('Target sentinel ID'),
      rule_type: z.enum(['vip', 'ignore']).optional().describe('Rule type (for add_rule)'),
      pattern: z.string().optional().describe('Sender email or domain pattern e.g. "boss@company.com" or "*@spam.com"'),
      reason: z.string().optional().describe('Optional explanation for rule'),
      rule_id: z.number().optional().describe('Rule ID (for remove_rule)')
    }),
    execute: async (args) => {
      switch (args.action) {
        case 'list': {
          const sentinels = routineRepo.listSentinels();
          return {
            count: sentinels.length,
            sentinels: sentinels.map(s => ({
              id: s.id,
              is_active: Boolean(s.is_active),
              last_check_at: s.last_check_at || null
            }))
          };
        }

        case 'enable': {
          if (!args.sentinel_id) throw new Error('sentinel_id is required to enable sentinel.');
          routineRepo.setSentinelActive(args.sentinel_id, true);
          return { status: 'enabled', id: args.sentinel_id, is_active: true };
        }

        case 'disable': {
          if (!args.sentinel_id) throw new Error('sentinel_id is required to disable sentinel.');
          routineRepo.setSentinelActive(args.sentinel_id, false);
          return { status: 'disabled', id: args.sentinel_id, is_active: false };
        }

        case 'run_now': {
          if (!args.sentinel_id) throw new Error('sentinel_id is required to run sentinel check.');
          let report: any = {};
          if (args.sentinel_id === 'gmail_sentinel' && gmailSentinel) {
            report = await gmailSentinel.runCheck();
          } else if (args.sentinel_id === 'calendar_sentinel' && calendarSentinel) {
            report = await calendarSentinel.runCheck();
          } else if (args.sentinel_id === 'proton_sentinel' && protonSentinel) {
            report = await protonSentinel.runCheck();
          } else {
            throw new Error(`Sentinel '${args.sentinel_id}' is not configured or available.`);
          }
          return { status: 'check_completed', id: args.sentinel_id, report };
        }

        case 'add_rule': {
          if (!args.sentinel_id || !args.rule_type || !args.pattern) {
            throw new Error('sentinel_id, rule_type (vip|ignore), and pattern are required to add sender rule.');
          }
          const rule = routineRepo.addSenderRule(args.sentinel_id, args.rule_type, args.pattern, args.reason);
          return { status: 'rule_added', rule };
        }

        case 'list_rules': {
          const rules = routineRepo.listSenderRules(args.sentinel_id);
          return { count: rules.length, rules };
        }

        case 'remove_rule': {
          if (args.rule_id === undefined) throw new Error('rule_id is required to remove a sender rule.');
          const ok = routineRepo.removeSenderRule(args.rule_id);
          if (!ok) throw new Error(`Rule ID ${args.rule_id} not found.`);
          return { status: 'rule_removed', rule_id: args.rule_id };
        }
      }
    },
    verify: async (params) => {
      if (params.action === 'enable' || params.action === 'disable') {
        const s = routineRepo.getSentinel(params.sentinel_id!);
        const expected = params.action === 'enable' ? 1 : 0;
        return {
          outcome: s.is_active === expected ? 'VERIFIED_SUCCESS' : 'FAILED_SAFE',
          details: `Sentinel ${params.sentinel_id} active is ${s.is_active}.`
        };
      }
      return { outcome: 'VERIFIED_SUCCESS' };
    }
  };

  return [sentinelManage];
}
