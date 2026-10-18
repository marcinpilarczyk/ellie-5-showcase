import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { initializeAppDatabase, initializeLedgerDatabase } from '../storage/schema.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { ResultStore } from '../storage/result-store.js';
import { WaitingRepository } from '../storage/waiting-repo.js';
import { createWaitingTools } from '../tools/waiting-tools.js';
import { ToolDispatcher } from '../governance/dispatcher.js';
import { ToolDefinition, ToolExecutionContext } from '../types/tool.js';
import {
  parseProjectStateSections,
  serializeProjectState,
  normalizeSectionName,
  CANONICAL_PROJECT_SECTIONS,
  createProjectStateTools,
  ProjectStateAdapter
} from '../tools/project-state-tools.js';

describe('Phase 3 — Follow-Through State, Canonical Project Docs & Outward Deduplication', () => {
  let appDb: DatabaseSync;
  let ledgerDb: DatabaseSync;
  let ledgerRepo: ActionLedgerRepository;
  let resultStore: ResultStore;
  let waitingRepo: WaitingRepository;
  let dispatcher: ToolDispatcher;

  const testContext: ToolExecutionContext = {
    runId: 'run_test_phase3',
    isInteractive: true,
    toolGrant: {
      allowedToolNames: new Set([
        'waiting_track',
        'waiting_list',
        'waiting_resolve',
        'project_state_read',
        'project_state_update',
        'gmail_send',
        'gmail_draft',
        'slack_post_message'
      ]),
      allowConsequential: true
    }
  };

  beforeEach(() => {
    appDb = new DatabaseSync(':memory:');
    ledgerDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    initializeLedgerDatabase(ledgerDb);

    ledgerRepo = new ActionLedgerRepository(ledgerDb);
    resultStore = new ResultStore(appDb);
    waitingRepo = new WaitingRepository(appDb);
    dispatcher = new ToolDispatcher(ledgerRepo, resultStore);
  });

  describe('3.1 First-Class waiting_items Table & Tools', () => {
    it('creates waiting_items table via migration 8 and performs CRUD', () => {
      const item = waitingRepo.track({
        counterparty: 'Acme Corp',
        subject: 'Signed consulting agreement',
        channel: 'email',
        thread_ref: 'thread_123',
        due_at: '2026-10-20T10:00:00Z',
        status: 'open'
      });

      assert.ok(item.id.startsWith('wait_'));
      assert.equal(item.counterparty, 'Acme Corp');
      assert.equal(item.status, 'open');

      // List active items
      const active = waitingRepo.list({ status: 'active' });
      assert.equal(active.length, 1);
      assert.equal(active[0].id, item.id);

      // Nudge item
      const nudged = waitingRepo.nudge(item.id);
      assert.equal(nudged?.status, 'nudged');

      // Still active when nudged
      const activeAfterNudge = waitingRepo.list({ status: 'active' });
      assert.equal(activeAfterNudge.length, 1);
      assert.equal(activeAfterNudge[0].status, 'nudged');

      // Resolve item
      const resolved = waitingRepo.resolve(item.id, 'Received via DocuSign');
      assert.equal(resolved?.status, 'resolved');
      assert.ok(resolved?.subject.includes('[resolved: Received via DocuSign]'));

      // No longer active
      const activeAfterResolve = waitingRepo.list({ status: 'active' });
      assert.equal(activeAfterResolve.length, 0);

      // Listed under resolved or all
      const all = waitingRepo.list({ status: 'all' });
      assert.equal(all.length, 1);
      assert.equal(all[0].status, 'resolved');
    });

    it('filters waiting items by counterparty and due date', () => {
      waitingRepo.track({
        counterparty: 'Jane Doe',
        subject: 'Portfolio review notes',
        due_at: '2026-10-18T12:00:00Z'
      });
      waitingRepo.track({
        counterparty: 'BigCo Talent',
        subject: 'Offer letter confirmation',
        due_at: '2026-10-25T12:00:00Z'
      });

      const dueSoon = waitingRepo.list({ dueBefore: '2026-10-19T00:00:00Z' });
      assert.equal(dueSoon.length, 1);
      assert.equal(dueSoon[0].counterparty, 'Jane Doe');

      const filtered = waitingRepo.list({ counterparty: 'Bigco' });
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0].counterparty, 'BigCo Talent');
    });

    it('executes waiting tools through ToolDispatcher with verification hooks', async () => {
      for (const tool of createWaitingTools(waitingRepo)) {
        dispatcher.registerTool(tool);
      }

      // 1. Track
      const trackRes: any = await dispatcher.dispatch('waiting_track', {
        counterparty: 'Vendor Partner',
        subject: 'API credentials',
        channel: 'slack'
      }, testContext);

      assert.equal(trackRes.status, 'tracked');
      const itemId = trackRes.item.id;

      // 2. List
      const listRes: any = await dispatcher.dispatch('waiting_list', { status: 'active' }, testContext);
      assert.equal(listRes.count, 1);
      assert.equal(listRes.items[0].id, itemId);

      // 3. Resolve
      const resolveRes: any = await dispatcher.dispatch('waiting_resolve', {
        id: itemId,
        status: 'resolved',
        notes: 'Credentials delivered in 1Password'
      }, testContext);
      assert.equal(resolveRes.status, 'resolved');
    });
  });

  describe('3.2 Canonical project_state_update Tool', () => {
    it('normalizes section names and parses all 8 canonical sections', () => {
      assert.equal(normalizeSectionName('objective'), 'Objective');
      assert.equal(normalizeSectionName('current_status'), 'Current Status');
      assert.equal(normalizeSectionName('open_loops'), 'Open Loops / Waiting On');
      assert.equal(normalizeSectionName('waiting_on'), 'Open Loops / Waiting On');
      assert.equal(normalizeSectionName('key_decisions'), 'Key Decisions');
      assert.equal(normalizeSectionName('risks_blockers'), 'Risks / Blockers');
      assert.equal(normalizeSectionName('next_actions'), 'Next Actions');
      assert.equal(normalizeSectionName('linked_artifacts'), 'Linked Artifacts');
      assert.equal(normalizeSectionName('invalid_random_section'), null);

      const sampleDoc = `
# PROJECT_STATE: JOB_SEARCH

## Objective
Secure a Principal/VP AI Product role.

## Current Status
3 active interview processes.

## Active Workstreams
- Enterprise AI outreach
- Technical assessment prep

## Open Loops / Waiting On
Waiting on Recruiter feedback from Acme.

## Key Decisions
Focus on Warsaw & Remote roles.

## Risks / Blockers
Q4 hiring freeze at BigTech.

## Next Actions
Follow up with Hiring Manager on Tuesday.

## Linked Artifacts
- Resume V5: https://drive.google.com/doc123
`;

      const parsed = parseProjectStateSections(sampleDoc);
      assert.equal(parsed.sections['Objective'], 'Secure a Principal/VP AI Product role.');
      assert.equal(parsed.sections['Current Status'], '3 active interview processes.');
      assert.equal(parsed.sections['Open Loops / Waiting On'], 'Waiting on Recruiter feedback from Acme.');
      assert.equal(parsed.sections['Next Actions'], 'Follow up with Hiring Manager on Tuesday.');
    });

    it('updates specific sections without clobbering existing sections', async () => {
      let storedContent = serializeProjectState('JOB_SEARCH', {
        'Objective': 'Land strategic leadership role',
        'Current Status': 'Initial conversations',
        'Active Workstreams': 'Pipeline building',
        'Open Loops / Waiting On': 'None',
        'Key Decisions': 'Prioritize European tech',
        'Risks / Blockers': 'Time constraints',
        'Next Actions': 'Draft cover letters',
        'Linked Artifacts': 'Dossier 2026'
      });

      const inMemoryAdapter: ProjectStateAdapter = {
        findDoc: async (project: string) => ({ documentId: `doc_${project}`, title: `PROJECT_STATE: ${project}` }),
        createDoc: async (project: string, initialContent: string) => {
          storedContent = initialContent;
          return { documentId: `doc_${project}` };
        },
        readDoc: async () => storedContent,
        replaceDoc: async (_id: string, content: string) => {
          storedContent = content;
        }
      };

      for (const tool of createProjectStateTools(inMemoryAdapter)) {
        dispatcher.registerTool(tool);
      }

      // Update ONLY current_status and next_actions
      const updateRes: any = await dispatcher.dispatch('project_state_update', {
        project: 'JOB_SEARCH',
        sections: {
          current_status: 'Advanced to final round at Alpha Inc',
          next_actions: 'Prepare system architecture presentation'
        }
      }, testContext);

      assert.equal(updateRes.status, 'UPDATED');
      assert.deepEqual(updateRes.updatedSections, ['Current Status', 'Next Actions']);

      // Read back via project_state_read
      const readRes: any = await dispatcher.dispatch('project_state_read', {
        project: 'JOB_SEARCH'
      }, testContext);

      assert.equal(readRes.sections['Current Status'], 'Advanced to final round at Alpha Inc');
      assert.equal(readRes.sections['Next Actions'], 'Prepare system architecture presentation');
      // Verify other sections were PRESERVED intact
      assert.equal(readRes.sections['Objective'], 'Land strategic leadership role');
      assert.equal(readRes.sections['Active Workstreams'], 'Pipeline building');
      assert.equal(readRes.sections['Key Decisions'], 'Prioritize European tech');
      assert.equal(readRes.sections['Risks / Blockers'], 'Time constraints');
    });

    it('refuses updates with non-canonical section names', async () => {
      const inMemoryAdapter: ProjectStateAdapter = {
        findDoc: async () => null,
        createDoc: async () => ({ documentId: 'doc_1' }),
        readDoc: async () => '',
        replaceDoc: async () => {}
      };

      for (const tool of createProjectStateTools(inMemoryAdapter)) {
        dispatcher.registerTool(tool);
      }

      await assert.rejects(
        async () => {
          await dispatcher.dispatch('project_state_update', {
            project: 'JOB_SEARCH',
            sections: {
              invented_non_canonical_section: 'Some content'
            }
          }, testContext);
        },
        /Unknown section 'invented_non_canonical_section'/
      );
    });
  });

  describe('3.3 Outward Action Deduplication in ToolDispatcher', () => {
    beforeEach(() => {
      const gmailSendTool: ToolDefinition = {
        name: 'gmail_send',
        description: 'Send gmail',
        effectClass: 'CONSEQUENTIAL',
        schema: z.object({
          to: z.string(),
          subject: z.string(),
          body: z.string()
        }),
        execute: async (params) => ({ sent: true, to: params.to })
      };

      const gmailDraftTool: ToolDefinition = {
        name: 'gmail_draft',
        description: 'Draft gmail',
        effectClass: 'INTERNAL_REVERSIBLE_WRITE',
        schema: z.object({
          to: z.string(),
          subject: z.string(),
          body: z.string()
        }),
        execute: async (params) => ({ draftId: 'd_123', to: params.to })
      };

      const slackPostTool: ToolDefinition = {
        name: 'slack_post_message',
        description: 'Post to Slack',
        effectClass: 'INTERNAL_REVERSIBLE_WRITE',
        schema: z.object({
          channel: z.string(),
          text: z.string()
        }),
        execute: async (params) => ({ ok: true, channel: params.channel })
      };

      dispatcher.registerTool(gmailSendTool);
      dispatcher.registerTool(gmailDraftTool);
      dispatcher.registerTool(slackPostTool);
    });

    it('refuses duplicate outward proposals to same recipient & subject within 24 hours', async () => {
      // 1. First proposal stages successfully
      const first: any = await dispatcher.dispatch('gmail_send', {
        to: 'recruiter@example.com',
        subject: 'Application for Lead Architect',
        body: 'Please find my resume attached.'
      }, testContext);

      assert.equal(first.status, 'STAGED_FOR_APPROVAL');
      assert.ok(first.actionId);

      // 2. Second proposal with exact same recipient and subject is REFUSED
      await assert.rejects(
        async () => {
          await dispatcher.dispatch('gmail_send', {
            to: 'recruiter@example.com',
            subject: 'Application for Lead Architect',
            body: 'A different body or retry'
          }, testContext);
        },
        (err: Error) => {
          assert.match(err.message, /\[Duplicate Action Refusal\]/);
          assert.match(err.message, /recruiter@example\.com/);
          assert.match(err.message, /application for lead architect/);
          return true;
        }
      );

      // 3. Normalized subject handles Re: prefix and case insensitivity
      await assert.rejects(
        async () => {
          await dispatcher.dispatch('gmail_draft', {
            to: 'RECRUITER@example.com ',
            subject: 'Re: Application for Lead Architect',
            body: 'Following up...'
          }, testContext);
        },
        /\[Duplicate Action Refusal\]/
      );
    });

    it('allows outward action to different recipient or different subject', async () => {
      await dispatcher.dispatch('gmail_send', {
        to: 'first@example.com',
        subject: 'Project kickoff',
        body: 'Notes'
      }, testContext);

      // Different recipient -> succeeds
      const diffRecipient: any = await dispatcher.dispatch('gmail_send', {
        to: 'second@example.com',
        subject: 'Project kickoff',
        body: 'Notes'
      }, testContext);
      assert.equal(diffRecipient.status, 'STAGED_FOR_APPROVAL');

      // Same recipient, different subject -> succeeds
      const diffSubject: any = await dispatcher.dispatch('gmail_send', {
        to: 'first@example.com',
        subject: 'Weekly status update',
        body: 'Notes'
      }, testContext);
      assert.equal(diffSubject.status, 'STAGED_FOR_APPROVAL');
    });

    it('allows re-proposal if previous action was explicitly DROPPED or DENIED', async () => {
      const first: any = await dispatcher.dispatch('gmail_send', {
        to: 'partner@example.com',
        subject: 'Partnership proposal',
        body: 'Draft body'
      }, testContext);

      // User drops the action
      ledgerRepo.dropAction(first.actionId, 'owner');

      // Now a retry/re-proposal is permitted
      const retried: any = await dispatcher.dispatch('gmail_send', {
        to: 'partner@example.com',
        subject: 'Partnership proposal',
        body: 'Refined body'
      }, testContext);

      assert.equal(retried.status, 'STAGED_FOR_APPROVAL');
    });

    it('deduplicates Slack outbound messages by channel and text prefix', async () => {
      await dispatcher.dispatch('slack_post_message', {
        channel: 'C_ANNOUNCEMENTS',
        text: 'System maintenance scheduled for tonight at 23:00 UTC.'
      }, testContext);

      await assert.rejects(
        async () => {
          await dispatcher.dispatch('slack_post_message', {
            channel: 'c_announcements',
            text: 'System maintenance scheduled for tonight at 23:00 UTC.'
          }, testContext);
        },
        /\[Duplicate Action Refusal\]/
      );
    });
  });
});
