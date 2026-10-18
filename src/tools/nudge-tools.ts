import { z } from 'zod';
import { ToolDefinition } from '../types/tool.js';
import { NudgeGate } from '../scheduler/nudge-gate.js';
import { SlackClient } from '../integrations/slack/client.js';

export function createNudgeTools(nudgeGate: NudgeGate, slackClient?: SlackClient): ToolDefinition[] {
  const nudgeManage: ToolDefinition = {
    name: 'nudge_settings_manage',
    description: 'Proactive noise and snooze control (snooze, unsnooze, set_quiet_hours, set_daily_cap, deliver_held_now, get_settings). Granted strictly to INTERACTIVE_SLACK runs.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: z.object({
      action: z.enum([
        'snooze',
        'unsnooze',
        'set_quiet_hours',
        'set_daily_cap',
        'deliver_held_now',
        'get_settings'
      ]).describe('Action to perform on proactive nudge settings'),
      snooze_until: z.string().optional().describe('ISO timestamp or time description e.g. "4pm", "in 2 hours", "2026-10-14T16:00:00Z"'),
      quiet_hours_start: z.number().min(0).max(23).optional().describe('Quiet hours start hour (e.g. 21 or 22 for 10pm)'),
      quiet_hours_end: z.number().min(0).max(23).optional().describe('Quiet hours end hour (e.g. 7 or 8 for 8am)'),
      daily_cap: z.number().min(1).max(100).optional().describe('Maximum number of proactive messages per day')
    }),
    execute: async (args, context) => {
      switch (args.action) {
        case 'get_settings': {
          return {
            status: 'ok',
            settings: nudgeGate.getSettings()
          };
        }

        case 'snooze': {
          if (!args.snooze_until) {
            throw new Error('snooze_until is required to snooze proactive nudges.');
          }
          const untilDate = parseSnoozeTime(args.snooze_until);
          nudgeGate.snooze(untilDate);
          return {
            status: 'snoozed',
            snoozedUntil: untilDate.toISOString(),
            message: `Proactive messages snoozed until ${untilDate.toLocaleTimeString()}.`
          };
        }

        case 'unsnooze': {
          nudgeGate.unsnooze();
          return {
            status: 'unsnoozed',
            message: 'Proactive messages un-snoozed.'
          };
        }

        case 'set_quiet_hours': {
          if (args.quiet_hours_start === undefined || args.quiet_hours_end === undefined) {
            throw new Error('quiet_hours_start and quiet_hours_end (0-23) are required.');
          }
          nudgeGate.setQuietHours(args.quiet_hours_start, args.quiet_hours_end);
          return {
            status: 'quiet_hours_updated',
            quiet_hours_start: args.quiet_hours_start,
            quiet_hours_end: args.quiet_hours_end,
            message: `Quiet hours set to ${args.quiet_hours_start}:00 – ${args.quiet_hours_end}:00.`
          };
        }

        case 'set_daily_cap': {
          if (args.daily_cap === undefined) {
            throw new Error('daily_cap is required.');
          }
          nudgeGate.setDailyCap(args.daily_cap);
          return {
            status: 'daily_cap_updated',
            daily_cap: args.daily_cap,
            message: `Daily proactive message cap set to ${args.daily_cap}.`
          };
        }

        case 'deliver_held_now': {
          const result = nudgeGate.deliverHeldMessagesNow();
          if (result.deliveredCount > 0 && slackClient?.isConfigured()) {
            const channel = context.slackOrigin?.channel || slackClient.defaultChannel;
            const text = `📬 *Held proactive updates (${result.deliveredCount}):*\n` +
              result.messages.map(m => `• ${m.slice(0, 300)}`).join('\n');
            await slackClient.postMessage({ channel, text }).catch(() => {});
          }
          return {
            status: 'delivered',
            deliveredCount: result.deliveredCount,
            messages: result.messages
          };
        }
      }
    },
    verify: async (params) => {
      if (params.action === 'snooze' || params.action === 'unsnooze') {
        const s = nudgeGate.getSettings();
        const expected = params.action === 'snooze';
        return {
          outcome: s.isSnoozed === expected ? 'VERIFIED_SUCCESS' : 'FAILED_SAFE',
          details: `Nudge snooze state is ${s.isSnoozed}.`
        };
      }
      return { outcome: 'VERIFIED_SUCCESS' };
    }
  };

  return [nudgeManage];
}

function parseSnoozeTime(input: string): Date {
  const direct = new Date(input);
  if (!isNaN(direct.getTime()) && direct.getTime() > Date.now() - 3600000) {
    return direct;
  }

  const now = new Date();
  const lower = input.toLowerCase().trim();

  // "in X hours"
  const relMatch = lower.match(/in\s+(\d+)\s*(h|hr|hour|hours|m|min|minutes)/);
  if (relMatch) {
    const val = parseInt(relMatch[1], 10);
    const ms = relMatch[2].startsWith('h') ? val * 3600000 : val * 60000;
    return new Date(now.getTime() + ms);
  }

  // "4pm", "16:00", "9am"
  const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (timeMatch) {
    let hour = parseInt(timeMatch[1], 10);
    const min = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const ampm = timeMatch[3];
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    const target = new Date(now);
    target.setHours(hour, min, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1); // Tomorrow
    }
    return target;
  }

  // Default fallback 2 hours
  return new Date(now.getTime() + 2 * 3600000);
}
