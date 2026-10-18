import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeLedgerDatabase } from '../storage/schema.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';

describe('ActionLedgerRepository', () => {
  let db: DatabaseSync;
  let ledgerRepo: ActionLedgerRepository;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    initializeLedgerDatabase(db);
    ledgerRepo = new ActionLedgerRepository(db);
  });

  it('stages a proposal with stable hash calculation', () => {
    const payload = { to: 'founder@example.com', subject: 'Intro', body: 'Hello' };
    const staged = ledgerRepo.stageProposal({
      actionType: 'gmail_send',
      payload,
      slackThreadTs: '123456.789',
      batchId: 'batch_alpha'
    });

    assert.ok(staged.id.startsWith('act_'));
    assert.equal(staged.state, 'STAGED');
    assert.equal(staged.action_type, 'gmail_send');
    assert.ok(staged.payload_hash.length === 64);
    assert.equal(staged.batch_id, 'batch_alpha');
    assert.equal(staged.slack_thread_ts, '123456.789');

    const fetched = ledgerRepo.get(staged.id);
    assert.ok(fetched !== null);
    assert.equal(fetched.payload_hash, staged.payload_hash);
  });

  it('updates staged payload in-place for in-thread revisions', () => {
    const staged = ledgerRepo.stageProposal({
      actionType: 'gmail_send',
      payload: { to: 'founder@example.com', body: 'Original draft' },
      slackThreadTs: '111.222'
    });

    const revisedPayload = { to: 'founder@example.com', body: 'Revised shorter draft in Polish' };
    const updated = ledgerRepo.updateStagedPayload(staged.id, revisedPayload, 'owner');

    assert.equal(updated.state, 'STAGED');
    assert.notEqual(updated.payload_hash, staged.payload_hash);

    const fetched = ledgerRepo.getLatestStagedByThreadTs('111.222');
    assert.ok(fetched !== null);
    assert.deepEqual(JSON.parse(fetched.payload_json), revisedPayload);
  });

  it('atomically claims action from APPROVED state preventing double execution', () => {
    const staged = ledgerRepo.stageProposal({
      actionType: 'gmail_send',
      payload: { to: 'test@example.com' }
    });

    // Must be approved first before claimForExecution
    const approved = ledgerRepo.approveAction(staged.id, 'owner');
    assert.equal(approved.state, 'APPROVED');

    const claimed1 = ledgerRepo.claimForExecution(staged.id, 'worker_1');
    assert.equal(claimed1, true);

    const claimed2 = ledgerRepo.claimForExecution(staged.id, 'worker_2');
    assert.equal(claimed2, false);

    const record = ledgerRepo.get(staged.id);
    assert.equal(record?.state, 'EXECUTING');
    assert.equal(record?.execution_attempts, 1);
  });

  it('transitions through verified and denied states', () => {
    const staged = ledgerRepo.stageProposal({
      actionType: 'proton_send',
      payload: { to: 'sec@example.com' }
    });

    ledgerRepo.approveAction(staged.id, 'owner');
    ledgerRepo.claimForExecution(staged.id, 'worker');
    ledgerRepo.confirmProvider(staged.id, 'worker');
    ledgerRepo.markVerified(staged.id, 'verifier');

    const verifiedRecord = ledgerRepo.get(staged.id);
    assert.equal(verifiedRecord?.state, 'VERIFIED');

    const staged2 = ledgerRepo.stageProposal({
      actionType: 'proton_send',
      payload: { to: 'drop@example.com' }
    });
    const denied = ledgerRepo.denyAction(staged2.id, 'owner', 'Not needed');
    assert.equal(denied.state, 'DENIED');
  });
});
