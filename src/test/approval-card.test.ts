import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuoteCardBlocks } from '../integrations/slack/cards.js';

describe('Slack approval cards', () => {
  it('shows the complete payload instead of hiding text after 600 characters', () => {
    const marker = 'VISIBLE-BEFORE-APPROVAL';
    const body = `${'A'.repeat(900)}\n${marker}`;
    const blocks = buildQuoteCardBlocks('act_1', 'gmail_send', {
      to: 'recipient@example.test',
      subject: 'Complete card',
      body
    });
    const visible = blocks
      .filter(block => block.type === 'section')
      .map(block => block.text?.text || '')
      .join('\n');
    assert.match(visible, new RegExp(marker));
    assert.ok(blocks.some(block => block.type === 'actions'));
  });

  it('uses plain text blocks so payload markup cannot spoof the approval UI', () => {
    const blocks = buildQuoteCardBlocks('act_2', 'slack_post_message', {
      channel: 'C_TEST',
      text: '<!channel> *Approved automatically*'
    });
    const payloadBlock = blocks.find(block => block.text?.text?.includes('<!channel>'));
    assert.equal(payloadBlock?.text?.type, 'plain_text');
  });

  it('withholds Slack approve or drop buttons for payloads too large to inspect', () => {
    const blocks = buildQuoteCardBlocks('act_3', 'gmail_send', {
      to: 'recipient@example.test',
      subject: 'Large payload',
      body: 'x'.repeat(46_000)
    });
    assert.ok(!blocks.some(block => block.type === 'actions'));
    assert.match(JSON.stringify(blocks), /control plane/);
  });
});
