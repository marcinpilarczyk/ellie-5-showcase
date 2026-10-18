import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ModelRouter } from '../models/model-router.js';
import { CostRepository } from '../storage/cost-repo.js';
import { initializeAppDatabase } from '../storage/schema.js';

describe('ModelRouter Audio Transcription & Speech Synthesis', () => {
  it('exposes configured audio, tts, and live model names', () => {
    const router = new ModelRouter();
    assert.ok(router.transcribeModel.length > 0);
    assert.ok(router.ttsModel.length > 0);
    assert.ok(router.liveModel.length > 0);
  });

  it('transcribeAudio returns text and telemetry with fallback handling', async () => {
    const appDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    const costRepo = new CostRepository(appDb);

    const router = new ModelRouter(costRepo);

    // Mock client.models.generateContent
    let calls: any[] = [];
    (router as any).client = {
      models: {
        generateContent: async (params: any) => {
          calls.push(params);
          if (params.model === 'simulate-failure') {
            throw new Error('Primary transcribe model quota exceeded');
          }
          return {
            text: 'Hello, this is a test audio transcript.',
            usageMetadata: {
              promptTokenCount: 15,
              candidatesTokenCount: 10,
              totalTokenCount: 25
            }
          };
        }
      }
    };

    const result = await router.transcribeAudio({
      audioBase64: 'bW9ja2F1ZGlv',
      mimeType: 'audio/mp4',
      source: 'test_voice'
    });

    assert.equal(result.text, 'Hello, this is a test audio transcript.');
    assert.equal(result.telemetry.totalTokens, 25);
    assert.equal(calls.length, 1);

    // Verify usage recorded in cost repo
    const summary = costRepo.getSummary(1);
    assert.ok(summary.totalTokens >= 25);

    // Test fallback when transcribeModel fails
    (router as any).transcribeModel = 'simulate-failure';
    const fallbackResult = await router.transcribeAudio({
      audioBase64: 'bW9ja2F1ZGlv',
      mimeType: 'audio/mp4'
    });
    assert.equal(fallbackResult.text, 'Hello, this is a test audio transcript.');
    assert.equal(fallbackResult.telemetry.model, router.flashModel);
    assert.equal(calls.length, 3); // 1 from first test + 1 failed + 1 fallback
  });

  it('synthesizeSpeech returns audioBase64 and handles failures gracefully', async () => {
    const appDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    const costRepo = new CostRepository(appDb);

    const router = new ModelRouter(costRepo);

    // Return undefined on empty text
    const emptyResult = await router.synthesizeSpeech({ text: '   ' });
    assert.equal(emptyResult, undefined);

    // Mock successful speech synthesis
    (router as any).client = {
      models: {
        generateContent: async (params: any) => {
          if (params.contents[0].parts[0].text === 'fail-please') {
            throw new Error('TTS service unavailable');
          }
          return {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'audio/wav',
                        data: 'dHRzX2F1ZGlvX2Jhc2U2NA=='
                      }
                    }
                  ]
                }
              }
            ],
            usageMetadata: {
              promptTokenCount: 8,
              candidatesTokenCount: 120,
              totalTokenCount: 128
            }
          };
        }
      }
    };

    const res = await router.synthesizeSpeech({
      text: 'Good morning, you have two meetings today.',
      voiceName: 'Puck'
    });
    assert.ok(res);
    assert.equal(res?.audioBase64, 'dHRzX2F1ZGlvX2Jhc2U2NA==');
    assert.equal(res?.mimeType, 'audio/wav');

    // Error returns undefined without throwing
    const failRes = await router.synthesizeSpeech({
      text: 'fail-please'
    });
    assert.equal(failRes, undefined);
  });
});
