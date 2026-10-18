import { z } from 'zod';
import { ToolDefinition } from '../types/tool.js';
import { MemoryRepository } from '../storage/memory-repo.js';
import { ReminderDispatcher } from '../scheduler/reminders.js';

export function createMemoryTools(
  memoryRepo: MemoryRepository,
  reminderDispatcher?: ReminderDispatcher
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // 1. memory_save
  const memorySaveTool: ToolDefinition = {
    name: 'memory_save',
    description: 'Records a new permanent memory fact, owner preference, or operational policy. Verified via read-back hook.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: z.object({
      statement: z.string().describe('The factual statement or policy to remember'),
      domain: z.string().optional().default('general').describe('Domain (e.g. work, preferences, bio)'),
      category: z.string().optional().default('FACT').describe('Category (e.g. PREFERENCE, POLICY, FACT)')
    }),
    execute: async (params) => {
      const fact = memoryRepo.addFact(params.statement, params.domain || 'general', params.category || 'FACT');
      return { ok: true, fact };
    },
    verify: async (params, lastKnownResult) => {
      const factId = lastKnownResult?.fact?.id;
      if (!factId) return { outcome: 'FAILED_SAFE', details: 'No fact ID returned.' };
      const loaded = memoryRepo.getFact(factId);
      if (loaded && loaded.statement === params.statement) {
        return { outcome: 'VERIFIED_SUCCESS', details: `Memory fact confirmed in database (ID: ${factId}).` };
      }
      return { outcome: 'FAILED_SAFE', details: `Fact ${factId} could not be confirmed upon read-back.` };
    }
  };
  tools.push(memorySaveTool);

  // 2. memory_list_facts
  tools.push({
    name: 'memory_list_facts',
    description: 'Lists all active learned memory facts, policies, and operational preferences.',
    effectClass: 'READ',
    schema: z.object({}),
    execute: async () => {
      return memoryRepo.listAllFacts();
    }
  });

  // 3. preference_candidate learning tools
  tools.push({
    name: 'memory_record_candidate',
    description: 'Records an observed stylistic preference or correction into candidate store for graduated learning (promoted after 3 occurrences).',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: z.object({
      key: z.string().describe('Preference key or pattern name (e.g. email_signoff, outreach_brevity)'),
      preferredValue: z.string().describe('Observed preferred phrasing or behavior'),
      scope: z.string().optional().default('global').describe('Scope of candidate (global, outreach, calendar)')
    }),
    execute: async (params) => {
      const candidate = memoryRepo.recordCandidate(params.key, params.preferredValue, params.scope || 'global');
      return { ok: true, candidate };
    },
    verify: async (params, lastKnownResult) => {
      const id = lastKnownResult?.candidate?.id;
      if (!id) return { outcome: 'FAILED_SAFE', details: 'No candidate ID returned.' };
      const c = memoryRepo.getCandidate(id);
      return c ? { outcome: 'VERIFIED_SUCCESS', details: `Candidate ${id} confirmed.` } : { outcome: 'FAILED_SAFE', details: 'Candidate not found.' };
    }
  });

  tools.push({
    name: 'memory_list_candidates',
    description: 'Lists candidate preferences undergoing graduated learning evaluation.',
    effectClass: 'READ',
    notEvidence: true,
    schema: z.object({}),
    execute: async () => {
      return memoryRepo.listCandidates();
    }
  });

  tools.push({
    name: 'memory_promote_candidate',
    description: 'Immediately promotes a preference candidate to an active memory fact.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: z.object({
      candidateId: z.string().describe('The candidate ID to promote')
    }),
    execute: async (params) => {
      memoryRepo.promoteCandidate(params.candidateId);
      return { ok: true, candidateId: params.candidateId };
    }
  });

  // 4. reminder_set (schedule reminder)
  tools.push({
    name: 'reminder_set',
    description: 'Schedules a proactive reminder delivered to the owner via Slack at target ISO datetime.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: z.object({
      title: z.string().describe('Reminder message text'),
      targetIso: z.string().describe('ISO-8601 target datetime string when reminder is due'),
      channel: z.string().optional().describe('Slack channel override'),
      threadTs: z.string().optional().describe('Slack thread timestamp')
    }),
    execute: async (params) => {
      if (!reminderDispatcher) {
        throw new Error('ReminderDispatcher is not available in current runtime.');
      }
      const targetDate = new Date(params.targetIso);
      if (isNaN(targetDate.getTime())) {
        throw new Error(`Invalid ISO date format: ${params.targetIso}`);
      }
      const reminderId = reminderDispatcher.addReminder(params.title, targetDate, params.channel, params.threadTs);
      return { ok: true, reminderId, title: params.title, targetTime: targetDate.toISOString() };
    },
    verify: async (params, lastKnownResult) => {
      const id = lastKnownResult?.reminderId;
      return id
        ? { outcome: 'VERIFIED_SUCCESS', details: `Reminder ${id} confirmed scheduled for ${params.targetIso}.` }
        : { outcome: 'FAILED_SAFE', details: 'Reminder ID was not returned.' };
    }
  });

  // 5. memory_manage (Full Control Over Memory & Learned Rules)
  tools.push({
    name: 'memory_manage',
    description: 'Full Command & Control over memory facts, executive rules, and learned preference candidates (list, search, add_global_rule, edit, delete). Granted strictly to INTERACTIVE_SLACK runs.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: z.object({
      action: z.enum(['list', 'search', 'add_global_rule', 'edit', 'delete']).describe('Action on memory or rules'),
      target: z.enum(['fact', 'candidate', 'ledger']).optional().default('fact').describe('Target store: "fact", "candidate", or "ledger"'),
      id: z.string().optional().describe('Fact or candidate ID (for edit, delete)'),
      statement: z.string().optional().describe('Rule or fact statement text (for add_global_rule, edit)'),
      domain: z.string().optional().default('rules').describe('Domain/tag (e.g. rules, preferences, bio)'),
      preferred_value: z.string().optional().describe('Preferred value (for candidate edit)'),
      query: z.string().optional().describe('Search query (for search)')
    }),
    execute: async (params) => {
      switch (params.action) {
        case 'list': {
          if (params.target === 'candidate') {
            const candidates = memoryRepo.listCandidates();
            return { target: 'candidate', count: candidates.length, candidates };
          }
          if (params.target === 'ledger') {
            const ledger = memoryRepo.listRrsiLedger();
            return { target: 'ledger', count: ledger.length, ledger };
          }
          const facts = memoryRepo.listAllFacts();
          return { target: 'fact', count: facts.length, facts };
        }

        case 'search': {
          if (!params.query) throw new Error('query is required for search.');
          const facts = memoryRepo.searchFacts(params.query);
          const candidates = memoryRepo.searchCandidates(params.query);
          return {
            query: params.query,
            factsCount: facts.length,
            facts,
            candidatesCount: candidates.length,
            candidates
          };
        }

        case 'add_global_rule': {
          if (!params.statement) throw new Error('statement is required for add_global_rule.');
          const fact = memoryRepo.addFact(params.statement, params.domain || 'rules', 'RULE', 1.0, 'owner');
          return { status: 'rule_added', fact };
        }

        case 'edit': {
          if (!params.id) throw new Error('id is required for edit.');
          if (params.target === 'candidate') {
            if (!params.preferred_value) throw new Error('preferred_value is required to edit candidate.');
            const ok = memoryRepo.updateCandidate(params.id, params.preferred_value);
            if (!ok) throw new Error(`Candidate '${params.id}' not found.`);
            return { status: 'candidate_updated', id: params.id, preferredValue: params.preferred_value };
          }
          if (!params.statement) throw new Error('statement is required to edit fact.');
          const ok = memoryRepo.updateFact(params.id, params.statement, params.domain);
          if (!ok) throw new Error(`Fact '${params.id}' not found.`);
          return { status: 'fact_updated', id: params.id, statement: params.statement };
        }

        case 'delete': {
          if (!params.id) throw new Error('id is required for delete.');
          if (params.target === 'candidate') {
            const ok = memoryRepo.deleteCandidate(params.id);
            if (!ok) throw new Error(`Candidate '${params.id}' not found.`);
            return { status: 'candidate_deleted', id: params.id };
          }
          const ok = memoryRepo.deleteFact(params.id);
          if (!ok) throw new Error(`Fact '${params.id}' not found.`);
          return { status: 'fact_deleted', id: params.id };
        }
      }
    },
    verify: async (params) => {
      if (params.action === 'delete') {
        const found = params.target === 'candidate' ? memoryRepo.getCandidate(params.id!) : memoryRepo.getFact(params.id!);
        return {
          outcome: found === null ? 'VERIFIED_SUCCESS' : 'FAILED_SAFE',
          details: `Item ${params.id} deletion verified.`
        };
      }
      return { outcome: 'VERIFIED_SUCCESS' };
    }
  });

  return tools;
}
