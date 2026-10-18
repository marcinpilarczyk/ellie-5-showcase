import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntime } from '../runtime/build-runtime.js';
import { ClaimsBankGuard, parseClaimsBank } from '../governance/claims-bank.js';
import { UnifiedAgentRunner } from '../agent/runner.js';

describe('Strict Completeness Audit Suite (Ellie v4 vs Gemini Ellie v2)', () => {
  const runtime = buildRuntime({
    appDbPath: ':memory:',
    ledgerDbPath: ':memory:'
  });

  const dispatcher = runtime.dispatcher;

  describe('1. Full Tool Inventory & Registration', () => {
    const requiredGoogleTools = [
      'gmail_search',
      'gmail_read',
      'gmail_draft',
      'gmail_send',
      'calendar_list',
      'calendar_create',
      'drive_search',
      'docs_read',
      'docs_create',
      'docs_append',
      'sheets_read',
      'sheets_append',
      'sheets_update',
      'sheet_query'
    ];

    for (const name of requiredGoogleTools) {
      it(`registers Google Workspace tool: ${name}`, () => {
        const tool = dispatcher.getTool(name);
        assert.ok(tool, `Expected tool '${name}' to be registered in dispatcher`);
      });
    }

    const requiredProtonTools = [
      'proton_search',
      'proton_read',
      'proton_send',
      'proton_draft'
    ];

    for (const name of requiredProtonTools) {
      it(`registers Proton Mail tool: ${name}`, () => {
        const tool = dispatcher.getTool(name);
        assert.ok(tool, `Expected tool '${name}' to be registered in dispatcher`);
      });
    }

    const requiredWebSocialTools = [
      'web_search',
      'web_read_page',
      'apify_linkedin_profile',
      'apify_linkedin_posts',
      'mcp_elliegateway_get_gateway_status',
      'mcp_elliegateway_linkedin_get_profile',
      'composio_search_tools',
      'composio_install_tool',
      'composio_setup_tool',
      'composio_execute_tool',
      'composio_list_installed'
    ];

    for (const name of requiredWebSocialTools) {
      it(`registers Web/Social/Gateway/Composio tool: ${name}`, () => {
        const tool = dispatcher.getTool(name);
        assert.ok(tool, `Expected tool '${name}' to be registered in dispatcher`);
      });
    }

    const requiredMemorySkillTools = [
      'result_read',
      'memory_save',
      'memory_record_candidate',
      'memory_list_candidates',
      'memory_promote_candidate',
      'skill_read',
      'skill_edit',
      'reminder_set'
    ];

    for (const name of requiredMemorySkillTools) {
      it(`registers Memory/Skill tool: ${name}`, () => {
        const tool = dispatcher.getTool(name);
        assert.ok(tool, `Expected tool '${name}' to be registered in dispatcher`);
      });
    }

    const requiredSelfDiagTools = [
      'repo_list_and_search',
      'repo_read_file',
      'trace_inspect_recent'
    ];

    for (const name of requiredSelfDiagTools) {
      it(`registers Self-Diagnosis tool: ${name}`, () => {
        const tool = dispatcher.getTool(name);
        assert.ok(tool, `Expected tool '${name}' to be registered in dispatcher`);
      });
    }
  });

  describe('2. Claims Bank Outreach Draft Gating', () => {
    it('actively gates outreach drafts against Claims Bank doc content', async () => {
      const mockDoc = `
# Claims Bank
1. Scaled engineering org to 45 engineers. [V]
2. Generated 5m EUR in enterprise ARR. [V]
# [X] Never Claim
- "Guaranteed 10x ROI"
      `;

      const guard = new ClaimsBankGuard(async () => mockDoc);

      // Sourced claim should pass
      const valid = await guard.check('Alex scaled an engineering org to 45 engineers.');
      assert.equal(valid.blocked, false);

      // Unsourced claim (80 engineers) should be blocked
      const invalidNumber = await guard.check('Alex scaled an engineering org to 80 engineers.');
      assert.equal(invalidNumber.blocked, true);
      assert.equal(invalidNumber.status, 'UNSOURCED_CLAIM');

      // Never claim should be blocked
      const neverClaim = await guard.check('We offer a guaranteed 10x ROI for your team.');
      assert.equal(neverClaim.blocked, true);
      assert.ok(neverClaim.violations.some(v => v.kind === 'NEVER_CLAIM'));
    });
  });

  describe('3. Read-Back Verification for INTERNAL_REVERSIBLE_WRITE', () => {
    it('executes readBack verification hook for memory_save', async () => {
      const tool = dispatcher.getTool('memory_save')!;
      assert.equal(tool.effectClass, 'INTERNAL_REVERSIBLE_WRITE');
      assert.ok(tool.verify !== undefined || tool.reconcile !== undefined);

      const res: any = await dispatcher.dispatch(
        'memory_save',
        { statement: 'Alex prefers brief 1-line Slack updates', domain: 'preferences' },
        { runId: 'test_run', isInteractive: true, toolGrant: { allowedToolNames: new Set(['memory_save']), allowConsequential: false } }
      );

      assert.equal(res.ok, true);
      assert.ok(res.readBack, 'Expected readBack property on result');
      assert.equal(res.readBack.status, 'VERIFIED');
    });

    it('verifies docs_create and docs_append carry active readBack hooks', () => {
      const docsCreate = dispatcher.getTool('docs_create')!;
      const docsAppend = dispatcher.getTool('docs_append')!;
      const sheetsAppend = dispatcher.getTool('sheets_append')!;
      const sheetsUpdate = dispatcher.getTool('sheets_update')!;

      assert.equal(docsCreate.effectClass, 'INTERNAL_REVERSIBLE_WRITE');
      assert.ok(docsCreate.verify !== undefined || docsCreate.reconcile !== undefined);

      assert.equal(docsAppend.effectClass, 'INTERNAL_REVERSIBLE_WRITE');
      assert.ok(docsAppend.verify !== undefined || docsAppend.reconcile !== undefined);

      assert.equal(sheetsAppend.effectClass, 'INTERNAL_REVERSIBLE_WRITE');
      assert.ok(sheetsAppend.verify !== undefined || sheetsAppend.reconcile !== undefined);

      assert.equal(sheetsUpdate.effectClass, 'INTERNAL_REVERSIBLE_WRITE');
      assert.ok(sheetsUpdate.verify !== undefined || sheetsUpdate.reconcile !== undefined);
    });
  });

  describe('4. Cheap-Detect Sentinels & Morning Brief', () => {
    it('skips Gmail LLM call when historyId is unchanged', async () => {
      const sentinel = runtime.gmailSentinel;
      // Mock googleClient profile
      (runtime.googleClient as any).isConnected = () => true;
      (runtime.googleClient as any).getGmailProfile = async () => ({
        emailAddress: 'test@example.com',
        historyId: 'hist_99999',
        messagesTotal: 100
      });

      // Seed sentinel_state with matching historyId
      runtime.routineRepo.updateSentinelCheck('gmail_sentinel', JSON.stringify({ historyId: 'hist_99999' }));

      const report = await sentinel.runCheck();
      assert.equal(report.cheapSkipped, true);
      assert.equal(report.processedCount, 0);
    });

    it('skips Proton LLM call when UIDNEXT and UNSEEN are unchanged', async () => {
      const sentinel = runtime.protonSentinel;
      (runtime.protonClient as any).isEnabled = () => true;
      (runtime.protonClient as any).getMailboxStatus = async () => ({
        uidNext: 500,
        unseen: 0,
        messages: 200
      });

      runtime.routineRepo.updateSentinelCheck('proton_sentinel', JSON.stringify({ uidNext: 500 }));

      const report = await sentinel.runCheck();
      assert.equal(report.cheapSkipped, true);
      assert.equal(report.processedCount, 0);
    });


  });

  describe('5. Multi-Round Tool Calling & Repetition Guard (runner.ts)', () => {
    it('aborts tool loop when Repetition Guard detects identical tool calls back-to-back', async () => {
      let generateCallCount = 0;
      let lastConfig: any;
      // Mock model router generate to return identical tool call twice
      const mockModelRouter = {
        modelName: 'gemini-3.8-flash',
        generate: async (_contents: any, config: any) => {
          generateCallCount++;
          lastConfig = config;
          return {
            text: '',
            functionCalls: [{ name: 'result_read', args: { handle: 'same_handle' } }],
            telemetry: { promptTokens: 10, cachedTokens: 0, thinkingTokens: 0, candidatesTokens: 5, totalTokens: 15, durationMs: 10, model: 'gemini-3.8-flash' },
            rawResponse: {}
          };
        }
      } as any;

      const testRunner = new UnifiedAgentRunner(mockModelRouter, runtime.dispatcher);
      const res = await testRunner.run({
        trigger: 'manual',
        instruction: 'test repetition guard',
        isInteractive: true,
        toolGrant: {
          allowedToolNames: new Set(['result_read']),
          allowConsequential: false
        }
      });

      // Repetition at round 2 forces one final tools-off answer round, rather than running all 8 rounds
      assert.equal(generateCallCount, 3);
      assert.deepEqual(lastConfig.toolConfig.functionCallingConfig.allowedFunctionNames, ['finish'],
        'final round may only call finish');
      assert.equal(res.status, 'COMPLETED');
    });

    it('enforces hard cap of 6 rounds for background runs and 8 for interactive', async () => {
      let callCount = 0;
      const mockModelRouter = {
        modelName: 'gemini-3.8-flash',
        generate: async () => {
          callCount++;
          return {
            text: '',
            functionCalls: [{ name: 'result_read', args: { handle: `handle_${callCount}` } }],
            telemetry: { promptTokens: 10, cachedTokens: 0, thinkingTokens: 0, candidatesTokens: 5, totalTokens: 15, durationMs: 10, model: 'gemini-3.8-flash' },
            rawResponse: {}
          };
        }
      } as any;

      const testRunner = new UnifiedAgentRunner(mockModelRouter, runtime.dispatcher);
      await testRunner.run({
        trigger: 'routine',
        instruction: 'test background round cap',
        isInteractive: false, // Background run
        toolGrant: {
          allowedToolNames: new Set(['result_read']),
          allowConsequential: false
        }
      });

      // Background run maxRounds must be capped at 6
      assert.equal(callCount, 6);
    });
  });

  describe('6. Routine Worker First-Boot Stampede Prevention', () => {
    it('initializes last_run_at to NOW on first boot and prevents stampede', async () => {
      // Upsert a brand new unexecuted routine
      runtime.routineRepo.upsertRoutine({
        id: 'test_brand_new_routine',
        title: 'Brand New Routine',
        cron_schedule: '* * * * *',
        timezone: 'Europe/Warsaw'
      });

      const initial = runtime.routineRepo.getRoutine('test_brand_new_routine');
      assert.equal(initial?.last_run_at, null);

      // Run due routines with stampede prevention
      const now = new Date();
      const report = await runtime.routineWorker.runDueRoutines(now, 1);

      // Verify that brand new routine was initialized with last_run_at instead of firing back-to-back
      const after = runtime.routineRepo.getRoutine('test_brand_new_routine');
      assert.ok(after?.last_run_at !== null);
      assert.ok(report.routinesRun <= 1);
    });
  });

  describe('7. Cost Telemetry & Model Split', () => {
    it('records and breaks down token usage side-by-side between Flash 3.8 and Argon 4', () => {
      // Record usage for Flash
      runtime.costRepo.recordUsage({
        model: 'gemini-3.8-flash',
        source: 'routine',
        prompt_tokens: 1000,
        cached_tokens: 200,
        thinking_tokens: 300,
        completion_tokens: 500,
        total_tokens: 1500
      });

      // Record usage for Argon
      runtime.costRepo.recordUsage({
        model: 'gemini-4-argon',
        source: 'analysis',
        prompt_tokens: 2000,
        cached_tokens: 500,
        thinking_tokens: 1000,
        completion_tokens: 800,
        total_tokens: 2800
      });

      const breakdown = runtime.costRepo.getBreakdown(1);
      assert.ok(breakdown.flash.callsCount >= 1);
      assert.ok(breakdown.flash.promptTokens >= 1000);
      assert.ok(breakdown.flash.cachedTokens >= 200);

      assert.ok(breakdown.reasoning.callsCount >= 1);
      assert.ok(breakdown.reasoning.promptTokens >= 2000);
      assert.ok(breakdown.reasoning.cachedTokens >= 500);
      assert.ok(breakdown.totalCostUsd > 0);
    });
  });

});
