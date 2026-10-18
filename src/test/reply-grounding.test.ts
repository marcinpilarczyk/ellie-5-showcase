import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { groundReply } from '../governance/reply-grounding.js';

const ID = '1W0abcdefghijklmnopqrstuvwxyz0123456789AB';
const ok: any = [{ tool: 'docs_create', params: {}, result: { documentId: ID }, durationMs: 1 }];

describe('groundReply', () => {
  it('keeps a link whose id came from a tool result', () => {
    const t = `I've created [Resume](https://docs.google.com/document/d/${ID}/edit)`;
    assert.equal(groundReply(t, ok), t);
  });
  it('withholds truncated or invented links', () => {
    const out = groundReply('I\'ve created [Resume](https://docs.google.com/document/d/1W0', ok)!;
    assert.ok(out.includes('link withheld'));
    assert.ok(!out.includes('d/1W0'));
  });
  it('flags a done-claim with no successful write', () => {
    const out = groundReply("I've created your resume.", [])!;
    assert.ok(out.includes('not done'));
  });
  it('recognizes document_render and visual_document_render as successful create tools', () => {
    const docxOk: any = [{ tool: 'document_render', params: {}, result: { ok: true, webViewLink: 'https://drive.google.com/file/d/xyz' }, durationMs: 1 }];
    const outDocx = groundReply("I've created your resume.", docxOk)!;
    assert.ok(!outDocx.includes('not done'));

    const visualOk: any = [{ tool: 'visual_document_render', params: {}, result: { ok: true, pdfLink: 'https://drive.google.com/file/d/xyz' }, durationMs: 1 }];
    const outVisual = groundReply("I've generated the one-pager infographic.", visualOk)!;
    assert.ok(!outVisual.includes('not done'));
  });
});
