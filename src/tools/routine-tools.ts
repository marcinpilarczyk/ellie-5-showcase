import { z } from 'zod';
import { ToolDefinition, COMMAND_AND_CONTROL_TOOL_NAMES } from '../types/tool.js';
import { RoutineRepository, formatCronSchedule } from '../storage/routine-repo.js';
import { RoutineWorker } from '../scheduler/routine-worker.js';
import { ToolDispatcher } from '../governance/dispatcher.js';

/** morning_brief from "Morning brief": lowercase ASCII words joined by underscores. */
export function routineIdFromTitle(title: string): string {
  return title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
}

export function createRoutineTools(
  routineRepo: RoutineRepository,
  routineWorker?: RoutineWorker,
  dispatcher?: ToolDispatcher
): ToolDefinition[] {
  const routineManage: ToolDefinition = {
    name: 'routine_manage',
    description: 'Full Command & Control management of scheduled routines (list, create, enable, disable, update_schedule, update_instructions, run_now, delete). Granted strictly to INTERACTIVE_SLACK runs.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: z.object({
      action: z.enum([
        'list',
        'create',
        'enable',
        'disable',
        'update_schedule',
        'update_instructions',
        'update_model',
        'run_now',
        'delete'
      ]).describe('Action to perform on scheduled routines'),
      routine_id: z.string().optional().describe('Routine identifier (required for enable, disable, update_schedule, update_instructions, update_model, run_now, delete; on create it is made from the title when left out)'),
      title: z.string().optional().describe('Human-friendly title for the routine (required for create)'),
      description: z.string().optional().describe('Prompt criteria / operational instructions for the routine'),
      cron_schedule: z.string().optional().describe('Cron schedule e.g. "15 9 * * 1-5" or "0 8 * * *"'),
      timezone: z.string().optional().default('Europe/Warsaw').describe('Timezone, default Europe/Warsaw'),
      destination: z.string().optional().describe('Output destination (Google Sheet name/tab, Doc, or Slack channel)'),
      tool_grant: z.array(z.string()).optional().describe('Allowed tool names for this routine (CONSEQUENTIAL tools strictly prohibited)'),
      primary_model: z.enum(['flash', 'reasoning']).optional().describe('Model for this routine: "flash" (default) or "reasoning" (Argon, slower and dearer; for research packs and judgement-heavy work). Set it on create or with update_model when the owner asks for Argon / the reasoning model.')
    }),
    execute: async (args) => {
      // 1. Guardrail against CONSEQUENTIAL or Command & Control tools in routine tool_grant
      if (args.tool_grant && dispatcher) {
        for (const t of args.tool_grant) {
          const toolDef = dispatcher.getTool(t);
          if (!toolDef) {
            throw new Error(`[Security Refusal] Tool '${t}' does not exist on this server.`);
          }
          if (toolDef.effectClass === 'CONSEQUENTIAL') {
            throw new Error(`[Security Refusal] Security guardrail violation: Routines cannot add CONSEQUENTIAL tool '${t}' to their tool grant.`);
          }
          if (COMMAND_AND_CONTROL_TOOL_NAMES.has(t)) {
            throw new Error(`[Security Refusal] Security guardrail violation: Routines cannot add Command & Control tool '${t}' to their tool grant.`);
          }
        }
      }

      switch (args.action) {
        case 'list': {
          const routines = routineRepo.getAllRoutines();
          return {
            count: routines.length,
            routines: routines.map(r => ({
              id: r.id,
              title: r.title,
              cron_schedule: r.cron_schedule,
              cadence: r.cadence_description || formatCronSchedule(r.cron_schedule),
              destination: r.destination || 'Slack',
              is_active: Boolean(r.is_active),
              model: /reason|pro|argon/i.test(r.primary_model || '') ? 'reasoning (Argon)' : 'flash',
              last_run_at: r.last_run_at || null,
              last_run_status: r.last_run_status || null,
              description: r.description
            }))
          };
        }

        case 'create': {
          if (!args.title || !args.cron_schedule) {
            throw new Error('title and cron_schedule are required to create a new routine.');
          }
          const id = args.routine_id?.trim() || routineIdFromTitle(args.title);
          if (!id) throw new Error('Give the routine a title with letters or digits.');
          if (routineRepo.getRoutine(id)) {
            throw new Error(`Routine '${id}' already exists.`);
          }

          routineRepo.upsertRoutine({
            id,
            title: args.title,
            description: args.description || '',
            cron_schedule: args.cron_schedule,
            timezone: args.timezone || 'Europe/Warsaw',
            is_active: 1,
            destination: args.destination,
            cadence_description: formatCronSchedule(args.cron_schedule),
            default_grant: args.tool_grant,
            primary_model: args.primary_model
          });

          const created = routineRepo.getRoutine(id)!;
          return {
            status: 'created',
            routine: created,
            confirm: `Created routine "${created.title}" (${id}): ${created.cadence_description}, ${created.timezone}, active${args.primary_model === 'reasoning' ? ', on the reasoning model (Argon)' : ''}.`
          };
        }

        case 'update_model': {
          if (!args.routine_id || !args.primary_model) {
            throw new Error('routine_id and primary_model ("flash" or "reasoning") are required to update the model.');
          }
          const r = routineRepo.getRoutine(args.routine_id);
          if (!r) throw new Error(`Routine '${args.routine_id}' not found.`);
          routineRepo.updateRoutine(args.routine_id, { primary_model: args.primary_model });
          return {
            status: 'model_updated',
            id: args.routine_id,
            primary_model: args.primary_model,
            confirm: `"${r.title}" now runs on ${args.primary_model === 'reasoning' ? 'the reasoning model (Argon)' : 'Flash'}.`
          };
        }

        case 'enable': {
          if (!args.routine_id) throw new Error('routine_id is required to enable a routine.');
          const r = routineRepo.getRoutine(args.routine_id);
          if (!r) throw new Error(`Routine '${args.routine_id}' not found.`);
          routineRepo.setRoutineActive(args.routine_id, true);
          return { status: 'enabled', id: args.routine_id, is_active: true };
        }

        case 'disable': {
          if (!args.routine_id) throw new Error('routine_id is required to disable a routine.');
          const r = routineRepo.getRoutine(args.routine_id);
          if (!r) throw new Error(`Routine '${args.routine_id}' not found.`);
          routineRepo.setRoutineActive(args.routine_id, false);
          return { status: 'disabled', id: args.routine_id, is_active: false };
        }

        case 'update_schedule': {
          if (!args.routine_id || !args.cron_schedule) {
            throw new Error('routine_id and cron_schedule are required to update schedule.');
          }
          const r = routineRepo.getRoutine(args.routine_id);
          if (!r) throw new Error(`Routine '${args.routine_id}' not found.`);
          routineRepo.updateRoutineSchedule(args.routine_id, args.cron_schedule);
          return {
            status: 'schedule_updated',
            id: args.routine_id,
            cron_schedule: args.cron_schedule,
            cadence: formatCronSchedule(args.cron_schedule),
            confirm: `"${r.title}" now runs ${formatCronSchedule(args.cron_schedule)}, ${r.timezone}.`
          };
        }

        case 'update_instructions': {
          if (!args.routine_id || args.description === undefined) {
            throw new Error('routine_id and description are required to update instructions.');
          }
          const r = routineRepo.getRoutine(args.routine_id);
          if (!r) throw new Error(`Routine '${args.routine_id}' not found.`);
          routineRepo.updateRoutineInstructions(args.routine_id, args.description);
          return { status: 'instructions_updated', id: args.routine_id, description: args.description, confirm: `Updated the instructions of "${r.title}".` };
        }

        case 'run_now': {
          if (!args.routine_id) throw new Error('routine_id is required to run a routine now.');
          if (!routineWorker) throw new Error('RoutineWorker is not available in runtime.');
          // Runs in the background (it can take minutes); the routine posts its own result to Slack
          const started = routineWorker.startRoutineNow(args.routine_id);
          if (started.alreadyRunning) {
            return { status: 'already_running', id: args.routine_id, runningSince: started.runningSince, note: 'Not started again. The run in progress posts its result to Slack.' };
          }
          if (!started.started) throw new Error(started.error);
          return { status: 'started', id: args.routine_id, note: 'The routine posts its result to Slack when it finishes.' };
        }

        case 'delete': {
          if (!args.routine_id) throw new Error('routine_id is required to delete a routine.');
          const deleted = routineRepo.deleteRoutine(args.routine_id);
          if (!deleted) throw new Error(`Routine '${args.routine_id}' not found.`);
          return { status: 'deleted', id: args.routine_id };
        }
      }
    },
    verify: async (params) => {
      if (params.action === 'enable' || params.action === 'disable') {
        const r = routineRepo.getRoutine(params.routine_id!);
        const expected = params.action === 'enable' ? 1 : 0;
        return {
          outcome: r?.is_active === expected ? 'VERIFIED_SUCCESS' : 'FAILED_SAFE',
          details: `Routine '${params.routine_id}' active state is ${r?.is_active}.`
        };
      }
      if (params.action === 'delete') {
        const r = routineRepo.getRoutine(params.routine_id!);
        return {
          outcome: r === null ? 'VERIFIED_SUCCESS' : 'FAILED_SAFE',
          details: `Routine '${params.routine_id}' deletion verified.`
        };
      }
      return { outcome: 'VERIFIED_SUCCESS' };
    }
  };

  return [routineManage];
}
