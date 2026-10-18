import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeAppDatabase } from '../storage/schema.js';
import { ResultStore } from '../storage/result-store.js';
import { ThreadCarryoverRepository } from '../storage/thread-carryover-repo.js';

const telemetry = { model: 'gemini-3.8-flash', promptTokens: 1, cachedTokens: 0, thinkingTokens: 0, candidatesTokens: 1, totalTokens: 2, durationMs: 1 };
const run = (runId: string, calls: Array<{ tool: string; params: any; result: any; handle?: string }>): any => ({
  runId, status: 'COMPLETED',
  output: { deliveryMode: 'SLACK_MESSAGE', finishStatus: 'DONE', summary: `done ${runId}` },
  toolCallsExecuted: calls.map(c => ({ ...c, durationMs: 1 })),
  handlesCreated: [], telemetry
});

describe('Thread carryover (every run in a thread, any tool)', () => {
  it('keeps a source read three runs ago reachable by handle, in full', () => {
    const db = new DatabaseSync(':memory:');
    initializeAppDatabase(db);
    const store = new ResultStore(db);
    const carryover = new ThreadCarryoverRepository(db, store);
    const posting = { title: 'Made-Up Role', description: 'Requirements: '.padEnd(1500, 'x') };

    carryover.save('C1:1', run('run_1', [{ tool: 'made_up_posting_read', params: { url: 'https://example.com/job/1' }, result: posting }]));
    carryover.save('C1:1', run('run_2', [{ tool: 'made_up_note_write', params: { text: 'draft' }, result: { id: 'doc_2' } }]));
    carryover.save('C1:1', run('run_3', [
      { tool: 'made_up_lookup', params: {}, result: { error: 'timed out' } },
      { tool: 'result_read', params: { handle: 'res_x' }, result: { slice: 'whatever' } }
    ]));
    carryover.save('C1:1', run('run_4', [{ tool: 'made_up_note_write', params: { text: 'draft' }, result: { id: 'doc_4' } }]));

    const summary = carryover.get('C1:1')!;
    const handle = summary.match(/made_up_posting_read\(.*\) -> stored as handle (\S+) .*\[earlier run run_1\]/)?.[1];
    assert.ok(handle, `the posting from run 1 is still listed with a handle:\n${summary}`);
    assert.equal(JSON.parse(store.get(handle!)!.content).description, posting.description, 'the handle holds the full result');

    assert.match(summary, /^Latest run run_4 ended with status DONE/);
    assert.equal((summary.match(/made_up_note_write/g) ?? []).length, 1, 'a call redone later replaces the earlier one');
    assert.match(summary, /doc_4/);
    assert.doesNotMatch(summary, /made_up_lookup/, 'an earlier failure is not carried');
    assert.doesNotMatch(summary, /- result_read\(/, 'readers are not carried');
  });

  it('keeps short results inline and stays within the size cap, dropping the oldest first', () => {
    const db = new DatabaseSync(':memory:');
    initializeAppDatabase(db);
    const carryover = new ThreadCarryoverRepository(db, new ResultStore(db));
    for (let i = 0; i < 40; i++) {
      carryover.save('C1:2', run(`run_${i}`, [{ tool: 'made_up_short', params: { i }, result: { ok: i } }]));
    }
    const summary = carryover.get('C1:2')!;
    assert.ok(summary.length <= 4000);
    assert.match(summary, /made_up_short\(\{"i":39\}\) -> \{"ok":39\}$/m);
    assert.doesNotMatch(summary, /\{"i":0\}/);
  });
});
