import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createJobEvaluationTools } from '../tools/job-evaluate-tool.js';
import { ModelRouter, ModelCallConfig, ModelCallResponse } from '../models/model-router.js';

describe('JEV job_evaluate tool', () => {
  it('calls reasoning model (ANALYSIS tier) and returns structured decision with coworker summary', async () => {
    let tierUsed = '';
    let promptCaptured = '';
    let responseSchemaUsed: any = null;

    const mockRouter = {
      generate: async (prompt: string, config: ModelCallConfig): Promise<ModelCallResponse> => {
        tierUsed = config.tier;
        promptCaptured = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
        responseSchemaUsed = config.responseSchema;

        const fakeDecision = {
          verdict: 'APPLY',
          priority: 'HIGH',
          overallFitScore: 8.8,
          bottomLine: 'Direct match for VP of AI operations role; proven leadership across cloud and ML infrastructure.',
          scores: {
            leadershipAndScope: 9.0,
            technicalGenAiFit: 9.5,
            compensationAndTerms: 8.0,
            dealBreakerRisk: 0.0
          },
          keyMatches: [
            { requirement: '10+ years scaling technical teams', dossierEvidence: 'Led 60+ engineers across multiple distributed orgs.' },
            { requirement: 'Hands-on GenAI agent operations', dossierEvidence: 'Built and governed enterprise agent pipelines.' }
          ],
          frictionPoints: [
            { point: 'Hybrid requirement in Berlin', severity: 'CAVEAT', handlingStrategy: 'Clarify travel cadence upfront during initial screening.' }
          ],
          positioningHook: 'Position as a pragmatic transformation leader who bridges architecture with measurable business outcomes.'
        };

        return {
          text: JSON.stringify(fakeDecision),
          telemetry: {
            model: 'gemini-4-argon',
            promptTokens: 2500,
            cachedTokens: 0,
            thinkingTokens: 400,
            candidatesTokens: 350,
            totalTokens: 3250,
            durationMs: 4500
          }
        };
      }
    } as unknown as ModelRouter;

    const [tool] = createJobEvaluationTools(mockRouter);
    assert.equal(tool.name, 'job_evaluate');
    assert.equal(tool.effectClass, 'READ');

    const fakeCtx: any = { runId: 'test_run' };
    const result: any = await tool.execute({
      job_text: 'Looking for a VP of AI Transformation to scale operations and lead engineering org.'
    }, fakeCtx);

    // 1. Verify tier was explicitly ANALYSIS (gemini-4-argon)
    assert.equal(tierUsed, 'ANALYSIS');
    assert.ok(responseSchemaUsed !== null);

    // 2. Verify structured decision is returned cleanly
    assert.equal(result.decision.verdict, 'APPLY');
    assert.equal(result.decision.overallFitScore, 8.8);
    assert.equal(result.decision.priority, 'HIGH');
    assert.equal(result.modelUsed, 'gemini-4-argon');

    // 3. Verify coworker summary is formatted for Slack
    assert.match(result.coworkerSummary, /✅ \*Job Fit Evaluation: APPLY\*/);
    assert.match(result.coworkerSummary, /8\.8\/10/);
    assert.match(result.coworkerSummary, /VP of AI operations role/);
    assert.match(result.coworkerSummary, /Key Proof Points:/);
    assert.match(result.coworkerSummary, /Positioning Hook:/);
  });

  it('fails cleanly when neither url nor job_text is provided', async () => {
    const mockRouter = { generate: async () => ({}) } as unknown as ModelRouter;
    const [tool] = createJobEvaluationTools(mockRouter);

    await assert.rejects(
      async () => await tool.execute({}, {} as any),
      /Either url or job_text must be provided/
    );
  });
});
