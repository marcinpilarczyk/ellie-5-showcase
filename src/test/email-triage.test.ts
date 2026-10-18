import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLikelyAutomatedEmail } from '../scheduler/sentinels/email-triage.js';

describe('Deterministic Email Pre-Triage', () => {
  it('detects bulk mail via List-Unsubscribe header', () => {
    const isAuto = isLikelyAutomatedEmail({
      from: 'updates@service.com',
      subject: 'Weekly Digest',
      headers: {
        'list-unsubscribe': '<https://service.com/unsub>'
      }
    });
    assert.equal(isAuto, true);
  });

  it('detects automated emails via Precedence or Auto-Submitted headers', () => {
    const res1 = isLikelyAutomatedEmail({
      from: 'alerts@monitoring.com',
      subject: 'Disk status',
      headers: { 'precedence': 'bulk' }
    });
    assert.equal(res1, true);

    const res2 = isLikelyAutomatedEmail({
      from: 'ci@gitlab.com',
      subject: 'Build passed',
      headers: { 'auto-submitted': 'auto-generated' }
    });
    assert.equal(res2, true);
  });

  it('detects standard no-reply / notification senders', () => {
    const addresses = [
      'no-reply@company.com',
      'noreply@platform.org',
      'notifications@github.com',
      'newsletter@substack.com',
      'billing@saas.io',
      'invoices@vendor.net',
      'marketing@store.com'
    ];

    for (const addr of addresses) {
      const res = isLikelyAutomatedEmail({ from: addr, subject: 'Account news' });
      assert.equal(res, true, `Expected ${addr} to be classified as automated`);
    }
  });

  it('detects digest and automated newsletter subject patterns', () => {
    const subjects = [
      'Weekly newsletter: What you missed',
      'Your daily digest for Oct 17',
      'Donation receipt #12345',
      'Order confirmation - Reference 98765'
    ];

    for (const sub of subjects) {
      const res = isLikelyAutomatedEmail({ from: 'editor@curated.org', subject: sub });
      assert.equal(res, true, `Expected "${sub}" to be classified as automated`);
    }
  });

  it('NEVER flags security, 2FA, or password reset alerts as automated', () => {
    const securityEmails = [
      { from: 'security@google.com', subject: 'Security alert: new sign-in from Chrome' },
      { from: 'no-reply@accounts.google.com', subject: 'Your verification code is 123456' },
      { from: 'auth@service.com', subject: 'Reset your password' },
      { from: 'notifications@bank.com', subject: 'Important: suspicious activity detected on your account' }
    ];

    for (const email of securityEmails) {
      const res = isLikelyAutomatedEmail(email);
      assert.equal(res, false, `Security email "${email.subject}" must never be skipped`);
    }
  });

  it('NEVER flags VIP senders even if bulk headers or newsletter subjects are present', () => {
    const res = isLikelyAutomatedEmail({
      from: 'The Boss <boss@work.com>',
      subject: 'Weekly newsletter / notes from my desk',
      headers: { 'list-unsubscribe': '<https://work.com/unsub>' },
      isVip: true
    });

    assert.equal(res, false, 'VIP sender must bypass automated email triage');
  });

  it('passes genuine personal human correspondence for LLM triage', () => {
    const res = isLikelyAutomatedEmail({
      from: 'Alice Smith <alice.smith@client.com>',
      subject: 'Follow-up on yesterday’s proposal and next steps'
    });
    assert.equal(res, false);
  });
});
