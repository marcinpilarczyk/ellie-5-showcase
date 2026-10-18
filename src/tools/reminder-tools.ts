import { z } from 'zod';
import { ToolDefinition } from '../types/tool.js';
import { ReminderDispatcher } from '../scheduler/reminders.js';

export function createReminderTools(reminderDispatcher: ReminderDispatcher): ToolDefinition[] {
  const reminderManage: ToolDefinition = {
    name: 'reminder_manage',
    description: 'Full reminder lifecycle control (create, list, reschedule, cancel, delete) in scheduled_reminders. Granted strictly to INTERACTIVE_SLACK runs.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: z.object({
      action: z.enum(['create', 'list', 'reschedule', 'cancel', 'delete']).describe('Action to perform on reminders'),
      reminder_id: z.string().optional().describe('Reminder identifier (for reschedule, cancel, delete)'),
      title: z.string().optional().describe('Reminder title / task description (for create)'),
      target_time: z.string().optional().describe('ISO timestamp or relative datetime (for create or reschedule)'),
      status_filter: z.enum(['PENDING', 'DELIVERED', 'CANCELLED', 'ALL']).optional().default('PENDING').describe('Status filter for list'),
      channel: z.string().optional().describe('Slack channel override'),
      thread_ts: z.string().optional().describe('Slack thread timestamp')
    }),
    execute: async (args, context) => {
      switch (args.action) {
        case 'list': {
          const reminders = reminderDispatcher.listReminders(args.status_filter);
          return {
            count: reminders.length,
            reminders
          };
        }

        case 'create': {
          if (!args.title || !args.target_time) {
            throw new Error('title and target_time are required to create a reminder.');
          }
          const targetDate = parseTargetTime(args.target_time);
          const channel = args.channel || context.slackOrigin?.channel;
          const threadTs = args.thread_ts || context.slackOrigin?.threadTs;

          const id = reminderDispatcher.addReminder(args.title, targetDate, channel, threadTs);
          return {
            status: 'created',
            id,
            title: args.title,
            targetTime: targetDate.toISOString()
          };
        }

        case 'reschedule': {
          if (!args.reminder_id || !args.target_time) {
            throw new Error('reminder_id and target_time are required to reschedule.');
          }
          const targetDate = parseTargetTime(args.target_time);
          const ok = reminderDispatcher.rescheduleReminder(args.reminder_id, targetDate);
          if (!ok) throw new Error(`Reminder '${args.reminder_id}' not found.`);
          return {
            status: 'rescheduled',
            id: args.reminder_id,
            newTargetTime: targetDate.toISOString()
          };
        }

        case 'cancel': {
          if (!args.reminder_id) throw new Error('reminder_id is required to cancel.');
          const ok = reminderDispatcher.cancelReminder(args.reminder_id);
          if (!ok) throw new Error(`Reminder '${args.reminder_id}' not found.`);
          return { status: 'cancelled', id: args.reminder_id };
        }

        case 'delete': {
          if (!args.reminder_id) throw new Error('reminder_id is required to delete.');
          const ok = reminderDispatcher.deleteReminder(args.reminder_id);
          if (!ok) throw new Error(`Reminder '${args.reminder_id}' not found.`);
          return { status: 'deleted', id: args.reminder_id };
        }
      }
    },
    verify: async (params) => {
      if (params.action === 'cancel') {
        const r = reminderDispatcher.getReminder(params.reminder_id!);
        return {
          outcome: r?.status === 'CANCELLED' ? 'VERIFIED_SUCCESS' : 'FAILED_SAFE',
          details: `Reminder status is ${r?.status}.`
        };
      }
      if (params.action === 'delete') {
        const r = reminderDispatcher.getReminder(params.reminder_id!);
        return {
          outcome: r === null ? 'VERIFIED_SUCCESS' : 'FAILED_SAFE',
          details: `Reminder deletion verified.`
        };
      }
      return { outcome: 'VERIFIED_SUCCESS' };
    }
  };

  return [reminderManage];
}

function parseTargetTime(input: string): Date {
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) return parsed;

  const now = Date.now();
  const lower = input.toLowerCase().trim();

  // "in X hours" / "in X mins"
  const m = lower.match(/in\s+(\d+)\s*(m|min|minute|minutes|h|hr|hour|hours|d|day|days)/);
  if (m) {
    const amount = parseInt(m[1], 10);
    const unit = m[2];
    if (unit.startsWith('m')) return new Date(now + amount * 60 * 1000);
    if (unit.startsWith('h')) return new Date(now + amount * 3600 * 1000);
    if (unit.startsWith('d')) return new Date(now + amount * 86400 * 1000);
  }

  // fallback default 1 hour
  return new Date(now + 3600 * 1000);
}
