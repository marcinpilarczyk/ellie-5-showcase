import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeAppDatabase } from '../storage/schema.js';
import { ResultStore, RESULT_STORE_THRESHOLD, RESULT_PREVIEW_CHARS, MAX_SLICE_CHARS } from '../storage/result-store.js';

describe('ResultStore', () => {
  let db: DatabaseSync;
  let resultStore: ResultStore;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    initializeAppDatabase(db);
    resultStore = new ResultStore(db);
  });

  it('stores large string results exceeding threshold and returns preview handle', () => {
    const largeText = 'a'.repeat(RESULT_STORE_THRESHOLD + 700);
    const intercept = resultStore.intercept('test_run_1', 'read_doc', largeText);

    assert.equal(intercept.isStored, true);
    assert.ok(intercept.handle?.startsWith('res_'));
    assert.equal(intercept.totalChars, RESULT_STORE_THRESHOLD + 700);
    // What the model sees instead of the result is always smaller than what would have been stored
    assert.ok(JSON.stringify(intercept).length < RESULT_STORE_THRESHOLD);
    assert.ok(intercept.preview!.includes('a'.repeat(RESULT_PREVIEW_CHARS)), 'preview carries a usable head');

    const stored = resultStore.get(intercept.handle!);
    assert.ok(stored !== null);
    assert.equal(stored.content, largeText);
    assert.equal(stored.tool_name, 'read_doc');
  });

  it('does not store outputs under the threshold', () => {
    const smallText = 'Hello world';
    const intercept = resultStore.intercept('test_run_1', 'read_doc', smallText);
    assert.equal(intercept.isStored, false);
    assert.equal(intercept.raw, smallText);
  });

  it('reads slices correctly with startLine and endLine', () => {
    // Text above the threshold, on several lines
    const line = 'x'.repeat(1600);
    const content = [line + ' Line 1', line + ' Line 2', line + ' Line 3', line + ' Line 4', line + ' Line 5'].join('\n');
    const intercept = resultStore.intercept('test_run_2', 'fetch_data', content);
    assert.equal(intercept.isStored, true);

    const slice = resultStore.readSlice(intercept.handle!, { startLine: 2, endLine: 4 });
    assert.equal(slice.totalLines, 5);
    assert.ok(slice.slice.includes('Line 2'));
    assert.ok(slice.slice.includes('Line 4'));
  });

  it('queries tabular sheet data correctly', () => {
    // JSON array above the threshold
    const row = { name: 'Alice', role: 'Engineer', notes: 'x'.repeat(1600) };
    const row2 = { name: 'Bob', role: 'Designer', notes: 'x'.repeat(1600) };
    const row3 = { name: 'Charlie', role: 'Engineer', notes: 'x'.repeat(1600) };
    const row4 = { name: 'David', role: 'Product', notes: 'x'.repeat(1600) };
    const data = [row, row2, row3, row4];

    const intercept = resultStore.intercept('test_run_3', 'query_users', data);
    assert.equal(intercept.isStored, true);

    const filtered = resultStore.querySheet(intercept.handle!, {
      filterColumn: 'role',
      filterValue: 'Engineer'
    });

    assert.equal(filtered.totalRows, 4);
    assert.equal(filtered.matchedRows, 2);
    assert.equal(filtered.rows[0].name, 'Alice');
    assert.equal(filtered.rows[1].name, 'Charlie');
  });

  it('keeps the line breaks of text inside an object result, so line and query reads work', () => {
    // Any tool that returns { ...metadata, text } (pages, docs, emails)
    const filler = Array.from({ length: 300 }, (_, i) => `Similar job ${i}: somewhere else`);
    const page = [...filler.slice(0, 150), '## Requirements', '5+ years in enterprise onboarding', 'Fluent Polish', ...filler.slice(150)].join('\n');
    const intercept = resultStore.intercept('test_run_4', 'made_up_page_read', { url: 'https://example.test/job', status: 'SUCCESS', content: page });
    assert.equal(intercept.isStored, true);
    assert.ok(intercept.preview!.includes('url: https://example.test/job\n'));
    assert.ok(intercept.preview!.includes('\nSimilar job 0: somewhere else\nSimilar job 1:'), 'real line breaks, not \\n escapes');

    const hit = resultStore.readSlice(intercept.handle!, { query: 'requirements' });
    assert.ok(hit.totalLines > 300);
    assert.ok(hit.slice.includes('5+ years in enterprise onboarding'));
    assert.ok(hit.slice.length < 500, `query returns the neighbourhood, not the page (${hit.slice.length} chars)`);

    // Offsets continue exactly where the preview stopped
    const next = resultStore.readSlice(intercept.handle!, { offset: RESULT_PREVIEW_CHARS });
    assert.equal(next.totalChars, intercept.totalChars);
    assert.equal(next.slice.length, Math.min(MAX_SLICE_CHARS, intercept.totalChars! - RESULT_PREVIEW_CHARS));
    assert.equal(next.remainingChars, Math.max(0, intercept.totalChars! - RESULT_PREVIEW_CHARS - MAX_SLICE_CHARS));

    // sheet_query still gets the JSON
    assert.deepEqual(JSON.parse(resultStore.get(intercept.handle!)!.content).url, 'https://example.test/job');
  });
});
