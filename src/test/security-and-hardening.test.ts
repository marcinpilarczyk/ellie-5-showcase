import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isBlockedUrl } from '../tools/web-tools.js';
import { inferComposioEffectClass } from '../integrations/composio/client.js';
import { compactParametersSchema } from '../tools/composio-tools.js';
import { processOverdueWaitingItems } from '../wake.js';
import { createApp } from '../http/app.js';
import { buildRuntime, Runtime } from '../runtime/build-runtime.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { WaitingRepository } from '../storage/waiting-repo.js';
import { initializeAppDatabase, initializeLedgerDatabase } from '../storage/schema.js';

describe('Security & Hardening Suite', () => {
  describe('SSRF Protection (isBlockedUrl)', () => {
    it('blocks loopback IPv4 and localhost', () => {
      assert.ok(isBlockedUrl('http://127.0.0.1:3002'), 'Must block 127.0.0.1');
      assert.ok(isBlockedUrl('http://localhost'), 'Must block localhost');
      assert.ok(isBlockedUrl('http://localhost:8080'), 'Must block localhost with port');
      assert.ok(isBlockedUrl('http://sub.localhost'), 'Must block *.localhost');
    });

    it('blocks link-local and cloud metadata addresses', () => {
      assert.ok(isBlockedUrl('http://169.254.169.254'), 'Must block 169.254.169.254');
      assert.ok(isBlockedUrl('http://169.254.1.1'), 'Must block 169.254.0.0/16');
    });

    it('blocks private IPv4 ranges and unspecified address', () => {
      assert.ok(isBlockedUrl('http://10.0.0.1'), 'Must block 10.0.0.0/8');
      assert.ok(isBlockedUrl('http://172.16.0.1'), 'Must block 172.16.0.0/12');
      assert.ok(isBlockedUrl('http://172.31.255.255'), 'Must block 172.31.255.255');
      assert.ok(isBlockedUrl('http://192.168.1.1'), 'Must block 192.168.0.0/16');
      assert.ok(isBlockedUrl('http://0.0.0.0'), 'Must block 0.0.0.0');
    });

    it('blocks loopback and private IPv6 ranges', () => {
      assert.ok(isBlockedUrl('http://[::1]'), 'Must block ::1');
      assert.ok(isBlockedUrl('http://[::]'), 'Must block ::');
      assert.ok(isBlockedUrl('http://[fc00::1]'), 'Must block fc00::/7');
      assert.ok(isBlockedUrl('http://[fe80::1]'), 'Must block fe80::/10');
    });

    it('blocks internal hostnames and non-http protocols', () => {
      assert.ok(isBlockedUrl('http://service.local'), 'Must block *.local');
      assert.ok(isBlockedUrl('http://metadata.internal'), 'Must block *.internal');
      assert.ok(isBlockedUrl('ftp://example.com'), 'Must block ftp://');
      assert.ok(isBlockedUrl('file:///etc/passwd'), 'Must block file://');
    });

    it('allows public HTTPS URLs', () => {
      assert.equal(isBlockedUrl('https://example.com'), null);
      assert.equal(isBlockedUrl('https://api.github.com/repos'), null);
      assert.equal(isBlockedUrl('http://example.com:8080/path?query=1'), null);
    });
  });

  describe('Composio Effect-Class Inference & Token Optimization', () => {
    it('inferComposioEffectClass("GMAIL_CREATE_AND_GET_DRAFT") returns "CONSEQUENTIAL"', () => {
      assert.equal(inferComposioEffectClass('GMAIL_CREATE_AND_GET_DRAFT'), 'CONSEQUENTIAL');
    });

    it('defaults unknown tool slugs to "CONSEQUENTIAL"', () => {
      assert.equal(inferComposioEffectClass('CUSTOM_ACTION_WITHOUT_STANDARD_VERB'), 'CONSEQUENTIAL');
    });

    it('correctly classifies pure read verbs as "READ"', () => {
      assert.equal(inferComposioEffectClass('GITHUB_GET_REPO'), 'READ');
      assert.equal(inferComposioEffectClass('SLACK_LIST_CHANNELS'), 'READ');
    });

    it('compactParametersSchema preserves required and truncates long descriptions', () => {
      const longDesc = 'A'.repeat(200);
      const schema = {
        type: 'object',
        required: ['target'],
        properties: {
          target: {
            type: 'string',
            description: longDesc
          },
          mode: {
            type: 'string',
            enum: ['fast', 'slow'],
            description: 'Short desc'
          }
        }
      };

      const compacted: any = compactParametersSchema(schema);
      assert.equal(compacted.type, 'object');
      assert.deepEqual(compacted.required, ['target']);
      assert.equal(compacted.properties.target.type, 'string');
      assert.equal(compacted.properties.target.description.length, 120);
      assert.deepEqual(compacted.properties.mode.enum, ['fast', 'slow']);
    });
  });

  describe('Space Sandboxing CSP Header', () => {
    let runtime: Runtime;
    let server: Server;
    let baseUrl: string;
    const testDataDir = './.test-security-spaces-data';

    before(async () => {
      if (fs.existsSync(testDataDir)) {
        fs.rmSync(testDataDir, { recursive: true, force: true });
      }

      runtime = buildRuntime({ dataDir: testDataDir });
      const app = createApp(runtime);
      await new Promise<void>((resolve) => {
        server = app.listen(0, '127.0.0.1', () => {
          const addr = server.address() as any;
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    after(async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      runtime.dbManager.close();
      if (fs.existsSync(testDataDir)) {
        fs.rmSync(testDataDir, { recursive: true, force: true });
      }
    });

    it('GET /spaces/:slug returns Content-Security-Policy with sandbox allow-scripts', async () => {
      // Create a test space
      runtime.spaceRepo.upsert({
        slug: 'security-test-radar',
        title: 'Security Radar',
        description: 'Test space',
        category: 'radar'
      });
      runtime.spaceRepo.saveContent('security-test-radar', '<html><body>Radar Content</body></html>');

      const res = await fetch(`${baseUrl}/spaces/security-test-radar`, {
        headers: { Authorization: `Bearer ${process.env.ELLIE_CONTROL_PLANE_TOKEN || 'test-control-plane-token-secret-999'}` }
      });
      assert.equal(res.status, 200);
      const csp = res.headers.get('Content-Security-Policy');
      assert.ok(csp, 'CSP header must be present');
      assert.ok(csp.includes('sandbox allow-scripts'), 'CSP must include sandbox allow-scripts');
      assert.ok(csp.includes("connect-src 'none'"), "CSP must include connect-src 'none'");
    });

    it('GET /spaces/:slug escapes slug in 404 response', async () => {
      const maliciousSlug = '<script>alert(1)</script>';
      const res = await fetch(`${baseUrl}/spaces/${encodeURIComponent(maliciousSlug)}`, {
        headers: { Authorization: `Bearer ${process.env.ELLIE_CONTROL_PLANE_TOKEN || 'test-control-plane-token-secret-999'}` }
      });
      assert.equal(res.status, 404);
      const body = await res.text();
      assert.ok(!body.includes('<script>alert(1)</script>'), 'Raw HTML tag must not appear in 404 response');
      assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'Slug must be escaped in 404 response');
    });
  });

  describe('processOverdueWaitingItems NudgeGate Protection', () => {
    let appDb: DatabaseSync;
    let ledgerDb: DatabaseSync;
    let waitingRepo: WaitingRepository;
    let ledgerRepo: ActionLedgerRepository;

    before(() => {
      appDb = new DatabaseSync(':memory:');
      ledgerDb = new DatabaseSync(':memory:');
      initializeAppDatabase(appDb);
      initializeLedgerDatabase(ledgerDb);
      waitingRepo = new WaitingRepository(appDb);
      ledgerRepo = new ActionLedgerRepository(ledgerDb);
    });

    after(() => {
      try { appDb.close(); } catch {}
      try { ledgerDb.close(); } catch {}
    });

    it('does not mark a waiting item as nudged or stage a ledger proposal when nudgeGate drops/snoozes the nudge', async () => {
      const pastDue = new Date(Date.now() - 3600_000).toISOString();
      const item = waitingRepo.track({
        counterparty: 'Blocked Partner <partner@blocked.com>',
        subject: 'Overdue contract review',
        channel: 'email',
        due_at: pastDue
      });
      assert.equal(item.status, 'open');

      const mockNudgeGateDrop: any = {
        evaluate: () => ({ decision: { action: 'DROP', reason: 'Daily cap reached' } })
      };

      const nudged = await processOverdueWaitingItems({
        waitingRepo,
        ledgerRepo,
        nudgeGate: mockNudgeGateDrop
      });

      assert.equal(nudged, 0, 'No items should be nudged when gate drops');

      // Verify item remains open and was not nudged
      const fetched = waitingRepo.get(item.id);
      assert.equal(fetched?.status, 'open', 'Item status must remain open');

      // Verify no proposal was staged
      const staged = ledgerRepo.get(`followup_${item.id}`);
      assert.equal(staged, null, 'No ledger proposal should be staged');
    });
  });
});
