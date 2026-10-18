import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { createApp } from '../http/app.js';
import { buildRuntime, Runtime } from '../runtime/build-runtime.js';

describe('HTTP API & control page endpoints', () => {
  let runtime: Runtime;
  let server: Server;
  let baseUrl: string;
  const token = 'test-control-plane-token-secret-999';

  before(async () => {
    runtime = buildRuntime({
      dataDir: './.test-data'
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
  });

  it('permits unauthenticated access to /api/health', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.status, 'ok');
    assert.equal(data.version, '5.0.0');
  });

  it('rejects unauthenticated requests to protected endpoints with 401', async () => {
    const res = await fetch(`${baseUrl}/api/queue`);
    assert.equal(res.status, 401);
  });

  it('permits authenticated requests to /api/queue with Bearer token', async () => {
    const res = await fetch(`${baseUrl}/api/queue`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.items));
  });

  it('does not trust forgeable Tailscale / forwarding headers on the public port', async () => {
    const res = await fetch(`${baseUrl}/api/queue`, {
      headers: {
        'x-forwarded-host': 'vps.tailnet.example.com:10000',
        'x-forwarded-for': '100.64.0.1',
        'x-forwarded-port': '10000',
        'tailscale-user-login': 'owner@example.com'
      }
    });
    assert.equal(res.status, 401);
  });

  it('auto-authenticates requests arriving on the private tailnet listener', async () => {
    const app = createApp(runtime);
    const privateServer: Server = await new Promise(resolve => {
      const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
    });
    try {
      const port = (privateServer.address() as any).port;
      app.locals.trustedPorts.add(port);
      const res = await fetch(`http://127.0.0.1:${port}/api/queue`);
      assert.equal(res.status, 200);
      const data = await res.json() as any;
      assert.equal(data.ok, true);
      assert.ok(Array.isArray(data.items));
    } finally {
      await new Promise<void>(resolve => privateServer.close(() => resolve()));
    }
  });

  it('supports listing routines and sentinels via /api/ops', async () => {
    const resRoutines = await fetch(`${baseUrl}/api/ops/routines`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    assert.equal(resRoutines.status, 200);
    const routinesData = await resRoutines.json() as any;
    assert.equal(routinesData.ok, true);

    const resSentinels = await fetch(`${baseUrl}/api/ops/sentinels`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    assert.equal(resSentinels.status, 200);
    const sentinelsData = await resSentinels.json() as any;
    assert.equal(sentinelsData.ok, true);
    assert.ok(Array.isArray(sentinelsData.sentinels));
  });

  it('serves mobile control plane status at /', async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.deepEqual(data, {
      ok: true,
      service: 'ellie-v5-control-plane',
      ui: 'android'
    });
  });

  it('serves web UI dashboard at / when requested by browser', async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('Ellie · Chief of Staff'));
  });

  it('serves web UI at /web and dashboard subpages', async () => {
    for (const page of ['/web', '/routines', '/runs', '/costs', '/settings']) {
      const res = await fetch(`${baseUrl}${page}`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('Ellie · Chief of Staff'));
    }
  });

  it('returns live admin status via /api/ops/status', async () => {
    const res = await fetch(`${baseUrl}/api/ops/status`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.ok, true);
    assert.equal(typeof data.googleConnected, 'boolean');
    assert.equal(typeof data.slackConfigured, 'boolean');
    assert.equal(typeof data.protonConfigured, 'boolean');
    assert.equal(typeof data.flashModel, 'string');
    assert.equal(typeof data.reasoningModel, 'string');
    assert.equal(typeof data.activeRoutinesCount, 'number');
    assert.equal(typeof data.sentinelsCount, 'number');
    assert.equal(typeof data.stagedQueueCount, 'number');
    assert.ok(data.timestamp);
  });

  it('returns voice capabilities and model config via /api/voice/status', async () => {
    const res = await fetch(`${baseUrl}/api/voice/status`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.ok, true);
    assert.ok(data.flashModel);
    assert.ok(data.transcribeModel);
    assert.ok(data.ttsModel);
    assert.ok(data.liveModel);
    assert.equal(typeof data.activeSessions, 'number');
  });

  it('validates input and processes a turn via /api/voice/turn', async () => {
    // Missing input returns 400
    const emptyRes = await fetch(`${baseUrl}/api/voice/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });
    assert.equal(emptyRes.status, 400);

    // Mock runner and model router methods for turn processing
    runtime.runner.run = async (opts: any) => ({
      runId: 'voice_turn_run_123',
      status: 'COMPLETED',
      output: {
        deliveryMode: 'SLACK_MESSAGE',
        finishStatus: 'DONE',
        slackMessage: 'Spoken reply from Ellie',
        coworkerHeadline: 'Spoken reply from Ellie',
        summary: 'Voice turn completed'
      },
      toolCallsExecuted: [],
      handlesCreated: [],
      telemetry: {
        model: 'gemini-3.8-flash',
        promptTokens: 10,
        cachedTokens: 0,
        thinkingTokens: 0,
        candidatesTokens: 10,
        totalTokens: 20,
        durationMs: 50
      },
      wallMs: 50
    });

    runtime.modelRouter.synthesizeSpeech = async () => ({
      audioBase64: 'bW9ja19zcGVlY2hfYXVkaW8=',
      mimeType: 'audio/wav'
    });

    runtime.modelRouter.transcribeAudio = async () => ({
      text: 'Transcribed voice instruction',
      telemetry: {
        model: 'gemini-3.5-transcribe',
        promptTokens: 5,
        cachedTokens: 0,
        thinkingTokens: 0,
        candidatesTokens: 5,
        totalTokens: 10,
        durationMs: 25
      }
    });

    // Test text turn
    const textRes = await fetch(`${baseUrl}/api/voice/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: 'What are my top priorities today?',
        speakReply: true
      })
    });
    assert.equal(textRes.status, 200);
    const textData = await textRes.json() as any;
    assert.equal(textData.ok, true);
    assert.equal(textData.transcript, 'What are my top priorities today?');
    assert.equal(textData.replyText, 'Spoken reply from Ellie');
    assert.equal(textData.audioBase64, 'bW9ja19zcGVlY2hfYXVkaW8=');
    assert.equal(textData.audioMimeType, 'audio/wav');
    assert.ok(textData.sessionId);

    // Test audioBase64 turn (auto-transcribed)
    const audioRes = await fetch(`${baseUrl}/api/voice/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        audioBase64: 'bW9ja19pbmJvdW5kX2F1ZGlv',
        mimeType: 'audio/mp4',
        sessionId: textData.sessionId
      })
    });
    assert.equal(audioRes.status, 200);
    const audioData = await audioRes.json() as any;
    assert.equal(audioData.ok, true);
    assert.equal(audioData.transcript, 'Transcribed voice instruction');
    assert.equal(audioData.sessionId, textData.sessionId);
  });

  it('validates input and processes meeting ingestion via /api/voice/meeting', async () => {
    // Missing input returns 400
    const emptyRes = await fetch(`${baseUrl}/api/voice/meeting`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });
    assert.equal(emptyRes.status, 400);

    // Test transcript ingestion
    const transcriptRes = await fetch(`${baseUrl}/api/voice/meeting`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        transcript: 'Speaker 1: We agreed to launch next week.\nSpeaker 2: I will finalize the documentation.',
        title: 'Weekly Sync',
        durationSeconds: 1800,
        postToSlack: false
      })
    });
    assert.equal(transcriptRes.status, 200);
    const transcriptData = await transcriptRes.json() as any;
    assert.equal(transcriptData.ok, true);
    assert.equal(transcriptData.title, 'Weekly Sync');
    assert.ok(transcriptData.summary);
    assert.equal(transcriptData.runId, 'voice_turn_run_123');

    // Test audioBase64 meeting note (auto-transcribed)
    const audioRes = await fetch(`${baseUrl}/api/voice/meeting`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        audioBase64: 'bW9ja19tZWV0aW5nX2F1ZGlv',
        mimeType: 'audio/m4a',
        title: 'Brainstorm Session',
        postToSlack: false
      })
    });
    assert.equal(audioRes.status, 200);
    const audioData = await audioRes.json() as any;
    assert.equal(audioData.ok, true);
    assert.equal(audioData.title, 'Brainstorm Session');
    assert.equal(audioData.transcript, 'Transcribed voice instruction');
  });
});
