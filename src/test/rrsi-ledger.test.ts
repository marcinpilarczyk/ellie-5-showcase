import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeAppDatabase, initializeLedgerDatabase } from '../storage/schema.js';
import { MemoryRepository, estimateTokenCost } from '../storage/memory-repo.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { screenCandidateLeakage } from '../agent/correction-extractor.js';
import { SlackCoworkerService } from '../integrations/slack/coworker.js';
import { SlackClient } from '../integrations/slack/client.js';
import { UnifiedAgentRunner } from '../agent/runner.js';
import { createMemoryTools } from '../tools/memory-tools.js';

describe('RRSI (arXiv:2609.24972v3) Subsystem Suite', () => {
  let appDb: DatabaseSync;
  let ledgerDb: DatabaseSync;
  let memoryRepo: MemoryRepository;
  let ledgerRepo: ActionLedgerRepository;

  beforeEach(() => {
    appDb = new DatabaseSync(':memory:');
    ledgerDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    initializeLedgerDatabase(ledgerDb);
    memoryRepo = new MemoryRepository(appDb);
    ledgerRepo = new ActionLedgerRepository(ledgerDb);
  });

  it('1. Proposal & Graduated Promotion in rrsi_edit_ledger', () => {
    const ruleText = 'State the core recommendation in the first sentence';
    const expectedCost = estimateTokenCost(ruleText);

    // Recording a candidate creates an rrsi_edit_ledger row with status: 'candidate', accepted: 0, and positive delta_cost
    const c1 = memoryRepo.recordCandidate('direct_thesis', ruleText, 'gmail_send');
    assert.equal(c1.status, 'candidate');
    assert.equal(c1.occurrences, 1);

    const ledger1 = memoryRepo.getRrsiByTarget(c1.id);
    assert.ok(ledger1, 'Expected RRSI ledger entry for candidate');
    assert.equal(ledger1.component_type, 'preference');
    assert.equal(ledger1.status, 'candidate');
    assert.equal(ledger1.accepted, 0);
    assert.equal(ledger1.trials, 1);
    assert.equal(ledger1.positive_trials, 1);
    assert.equal(ledger1.negative_trials, 0);
    assert.equal(ledger1.delta_cost, expectedCost);

    // Second occurrence increments trials and delta_score
    memoryRepo.recordCandidate('direct_thesis', ruleText, 'gmail_send');
    const ledger2 = memoryRepo.getRrsiByTarget(c1.id)!;
    assert.equal(ledger2.trials, 2);
    assert.equal(ledger2.positive_trials, 2);
    assert.equal(ledger2.status, 'candidate');
    assert.equal(ledger2.delta_score, 0.5);

    // Third occurrence promotes candidate and marks RRSI ledger accepted = 1
    memoryRepo.recordCandidate('direct_thesis', ruleText, 'gmail_send');
    const ledger3 = memoryRepo.getRrsiByTarget(c1.id)!;
    assert.equal(ledger3.trials, 3);
    assert.equal(ledger3.accepted, 1);
    assert.equal(ledger3.status, 'accepted');
    assert.ok(ledger3.delta_score >= 1.0);

    const facts = memoryRepo.getExecutiveFacts();
    assert.ok(facts.some(f => f.statement.includes(ruleText)), 'Promoted rule should appear in executive facts');
  });

  it('2. Diff-Level Leakage Critic blocks payload figures, IDs, paths, entities, and long prose dumps', () => {
    const input = {
      actionType: 'gmail_send',
      feedback: 'Make the summary tighter',
      oldPayload: {
        to: 'jan@example.com',
        recipient: 'Jan Kowalski',
        amount: '$45,000',
        discount: '85%',
        channel: 'C0123ABCDEF',
        docId: 'doc_12345abcdef67890',
        threadId: '1798765432.123456',
        path: '/EllieOS/finance/report.pdf',
        note: 'Project for Contoso Corp'
      },
      newPayload: {
        to: 'jan@example.com',
        recipient: 'Jan Kowalski',
        amount: '$45,000',
        discount: '85%',
        channel: 'C0123ABCDEF',
        docId: 'doc_12345abcdef67890',
        threadId: '1798765432.123456',
        path: '/EllieOS/finance/report.pdf',
        note: 'Executive briefing for Contoso Corp'
      }
    };

    // Blocks currency figures ($45,000)
    assert.equal(
      screenCandidateLeakage('Always quote $45,000 for this scope.', input).leaked,
      true,
      'Must block leaked payload currency figure'
    );

    // Blocks percentage figures (85%)
    assert.equal(
      screenCandidateLeakage('Always apply an 85% discount.', input).leaked,
      true,
      'Must block leaked payload percentage'
    );

    // Blocks Slack channel IDs
    assert.equal(
      screenCandidateLeakage('Send summary to C0123ABCDEF channel.', input).leaked,
      true,
      'Must block leaked Slack channel ID'
    );

    // Blocks Slack thread timestamps / IDs
    assert.equal(
      screenCandidateLeakage('Post reply to 1798765432.123456 thread.', input).leaked,
      true,
      'Must block leaked Slack thread ID'
    );

    // Blocks document IDs
    assert.equal(
      screenCandidateLeakage('Review doc_12345abcdef67890 before drafting.', input).leaked,
      true,
      'Must block leaked doc ID'
    );

    // Blocks file paths
    assert.equal(
      screenCandidateLeakage('Check /EllieOS/finance/report.pdf for figures.', input).leaked,
      true,
      'Must block leaked file path'
    );

    // Blocks emails
    assert.equal(
      screenCandidateLeakage('Send directly to jan@example.com.', input).leaked,
      true,
      'Must block leaked email'
    );

    // Blocks URLs
    assert.equal(
      screenCandidateLeakage('Link to https://example.com/briefing in the email.', input).leaked,
      true,
      'Must block leaked URL'
    );

    // Blocks proper nouns
    assert.equal(
      screenCandidateLeakage('Confirm with Jan Kowalski first.', input).leaked,
      true,
      'Must block leaked proper noun recipient'
    );
    assert.equal(
      screenCandidateLeakage('Prepare deck for Contoso Corp.', input).leaked,
      true,
      'Must block leaked proper noun organization'
    );

    // Blocks >35 word prose dumps
    const longProse = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    assert.equal(
      screenCandidateLeakage(longProse, input).leaked,
      true,
      'Must block overly long prose dump (>35 words)'
    );

    // Allows clean generalizable rule
    assert.equal(
      screenCandidateLeakage('Open executive outreach emails with Hi instead of Dear.', input).leaked,
      false,
      'Clean generalizable stylistic rule must pass'
    );

    // Allows explicit always/never owner override
    const explicitInput = {
      ...input,
      feedback: 'Always address Contoso Corp as Contoso Group'
    };
    assert.equal(
      screenCandidateLeakage('Always address Contoso Corp as Contoso Group.', explicitInput).leaked,
      false,
      'Explicit always/never owner override must be permitted'
    );
  });

  it('3. Credit Assignment (Lt) on Slack card approve/drop & negative evidence', async () => {
    const cand = memoryRepo.recordCandidate('concise_subject', 'Keep subject lines under 6 words', 'gmail_send');
    assert.equal(cand.occurrences, 1);

    const staged1 = ledgerRepo.stageProposal({
      actionType: 'gmail_send',
      payload: { to: 'jan@example.com', subject: 'Update', body: 'Hello' }
    });
    const staged2 = ledgerRepo.stageProposal({
      actionType: 'gmail_send',
      payload: { to: 'alice@example.com', subject: 'Update 2', body: 'Hello 2' }
    });

    const mockSlack = {
      isConfigured: () => true,
      updateMessage: async () => ({ ok: true }),
      postMessage: async () => ({ ok: true })
    } as unknown as SlackClient;

    const mockRunner = {
      getMemoryRepo: () => memoryRepo
    } as unknown as UnifiedAgentRunner;

    const coworker = new SlackCoworkerService(
      mockSlack,
      ledgerRepo,
      mockRunner,
      undefined,
      undefined,
      undefined,
      undefined,
      memoryRepo
    );

    // Approve staged1 -> positive trial recorded on gmail_send hypothesis (+0.5)
    await coworker.handleButtonInteraction({
      actions: [{ action_id: 'approve_action', value: staged1.id }],
      channel: { id: 'C123' },
      message: { ts: '111.222' },
      user: { id: 'U123' }
    });

    const afterApprove = memoryRepo.getRrsiByTarget(cand.id)!;
    assert.equal(afterApprove.positive_trials, 2);
    assert.ok(afterApprove.delta_score > 0);

    // Drop staged2 -> negative evidence recorded on candidates scoped to gmail_send
    await coworker.handleButtonInteraction({
      actions: [{ action_id: 'drop_action', value: staged2.id }],
      channel: { id: 'C123' },
      message: { ts: '111.333' },
      user: { id: 'U123' }
    });

    const candAfterDrop = memoryRepo.getCandidate(cand.id)!;
    assert.equal(candAfterDrop.status, 'rejected');
    const ledgerAfterDrop = memoryRepo.getRrsiByTarget(cand.id)!;
    assert.equal(ledgerAfterDrop.delta_score, -0.5);
    assert.equal(ledgerAfterDrop.negative_trials, 1);

    // A second drop drives delta_score <= -1.0, rejecting the ledger entry
    memoryRepo.recordNegativeEvidence('gmail_send');
    const ledgerRejected = memoryRepo.getRrsiByTarget(cand.id)!;
    assert.equal(ledgerRejected.status, 'rejected');
    assert.equal(ledgerRejected.accepted, 0);
  });

  it('4. Lasso (L1) Structural Pruning demotes unproductive learned facts while strictly preserving owner facts', () => {
    // 1. Add an owner fact (must NEVER be demoted)
    const ownerFact = memoryRepo.addFact('Always use British English spelling in board memos.', 'preferences', 'PREFERENCE', 1.0, 'owner');
    memoryRepo.recordRrsiProposal({
      componentType: 'memory_fact',
      targetId: ownerFact.id,
      hypothesis: 'Owner rule',
      diffText: ownerFact.statement,
      accepted: true
    });

    // 2. Add graduated learning and correction facts that subsequently accumulate negative trials
    const gradFact = memoryRepo.addFact('Include a postscript in outreach emails.', 'preferences', 'PREFERENCE', 1.0, 'graduated_learning');
    memoryRepo.recordRrsiProposal({
      componentType: 'memory_fact',
      targetId: gradFact.id,
      hypothesis: 'Graduated rule on gmail_send',
      diffText: gradFact.statement,
      accepted: true
    });

    const corrFact = memoryRepo.addFact('Do not use decorative dividers.', 'preferences', 'PREFERENCE', 0.9, 'correction');
    memoryRepo.recordRrsiProposal({
      componentType: 'memory_fact',
      targetId: corrFact.id,
      hypothesis: 'Correction on gmail_send',
      diffText: corrFact.statement,
      accepted: true
    });

    // Record negative trials on all so trials >= 3 and delta_score < 0
    for (let i = 0; i < 3; i++) {
      memoryRepo.recordRrsiTrial(ownerFact.id, -1.0);
      memoryRepo.recordRrsiTrial(gradFact.id, -1.0);
      memoryRepo.recordRrsiTrial(corrFact.id, -1.0);
    }

    const prunedCount = memoryRepo.pruneStaleCandidates(30);
    assert.ok(prunedCount >= 3, 'Should prune unproductive ledger entries');

    // Graduated and correction facts demoted to confidence 0.5 (excluded from getExecutiveFacts)
    const updatedGrad = memoryRepo.getFact(gradFact.id)!;
    assert.equal(updatedGrad.confidence, 0.5, 'Graduated fact demoted to 0.5');

    const updatedCorr = memoryRepo.getFact(corrFact.id)!;
    assert.equal(updatedCorr.confidence, 0.5, 'Correction fact demoted to 0.5');

    const execFacts = memoryRepo.getExecutiveFacts();
    assert.ok(!execFacts.some(f => f.id === gradFact.id), 'Demoted graduated fact must drop out of executive facts');
    assert.ok(!execFacts.some(f => f.id === corrFact.id), 'Demoted correction fact must drop out of executive facts');

    // Owner fact must strictly preserve confidence 1.0
    const updatedOwner = memoryRepo.getFact(ownerFact.id)!;
    assert.equal(updatedOwner.confidence, 1.0, 'Owner fact must never be demoted');
    assert.ok(execFacts.some(f => f.id === ownerFact.id), 'Owner fact must remain in executive facts');
  });

  it('5. memory_manage lists RRSI edit ledger when target is ledger', async () => {
    memoryRepo.recordCandidate('bullet_cap', 'Max 4 bullets per section', 'docs_create');
    const tools = createMemoryTools(memoryRepo);
    const manageTool = tools.find(t => t.name === 'memory_manage')!;
    assert.ok(manageTool, 'memory_manage tool should be found');

    const res: any = await manageTool.execute({ action: 'list', target: 'ledger' }, {} as any);
    assert.equal(res.target, 'ledger');
    assert.equal(res.count, 1);
    assert.equal(res.ledger[0].diff_text, 'Max 4 bullets per section');
    assert.equal(res.ledger[0].component_type, 'preference');
  });
});
