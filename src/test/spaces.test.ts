import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../http/app.js';
import { buildRuntime, Runtime } from '../runtime/build-runtime.js';

describe('Spaces engine & Web UI hosting', () => {
  let runtime: Runtime;
  let server: Server;
  let baseUrl: string;
  const testDataDir = './.test-spaces-data';
  const token = 'test-control-plane-token-secret-999';

  before(async () => {
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }

    runtime = buildRuntime({
      dataDir: testDataDir
    });

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

  it('publishes a space via tool, verifies content on disk, and passes read-back (P7)', async () => {
    const spacePublishTool = runtime.dispatcher.getTool('space_publish');
    assert.ok(spacePublishTool, 'space_publish tool must be registered');

    const result: any = await runtime.dispatcher.dispatch('space_publish', {
      slug: 'marketing-reports',
      title: 'Marketing Performance Radar',
      description: 'Weekly breakdown across Amazon and Meta ads',
      category: 'radar',
      htmlContent: `<!doctype html><html><body><h1>Marketing Headline</h1></body></html>`
    }, {
      runId: 'run_test_space_1',
      isInteractive: true,
      toolGrant: { allowedToolNames: new Set(['space_publish']), allowConsequential: true }
    });

    assert.equal(result.readBack?.status, 'VERIFIED');
    assert.equal(result.ok, true);
    assert.equal(result.slug, 'marketing-reports');
    assert.equal(result.url, '/spaces/marketing-reports');

    // Confirm file exists on disk
    const content = runtime.spaceRepo.getContent('marketing-reports');
    assert.ok(content?.includes('<h1>Marketing Headline</h1>'));
  });

  it('lists published spaces via space_list tool', async () => {
    const listResult: any = await runtime.dispatcher.dispatch('space_list', {
      category: 'radar'
    }, {
      runId: 'run_test_space_2',
      isInteractive: true,
      toolGrant: { allowedToolNames: new Set(['space_list']), allowConsequential: true }
    });

    assert.equal(listResult.count, 1);
    assert.equal(listResult.spaces[0].slug, 'marketing-reports');
  });

  it('serves the published space at /spaces/:slug with Content-Type text/html', async () => {
    const res = await fetch(`${baseUrl}/spaces/marketing-reports`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const body = await res.text();
    assert.ok(body.includes('<h1>Marketing Headline</h1>'));
  });

  it('returns 404 friendly page when space does not exist', async () => {
    const res = await fetch(`${baseUrl}/spaces/nonexistent-slug`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.ok(body.includes('Space Not Found'));
  });

  it('lists spaces via REST API /api/spaces', async () => {
    const res = await fetch(`${baseUrl}/api/spaces`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.ok, true);
    assert.equal(data.count, 1);
    assert.equal(data.spaces[0].slug, 'marketing-reports');
    assert.equal(data.spaces[0].category, 'radar');
  });

  it('archives a space via /api/spaces/:slug/archive', async () => {
    const res = await fetch(`${baseUrl}/api/spaces/marketing-reports/archive`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.ok, true);
    assert.equal(data.space.status, 'archived');

    // Confirm active list no longer includes it
    const active = runtime.spaceRepo.list({ status: 'active' });
    assert.equal(active.length, 0);
  });
});
