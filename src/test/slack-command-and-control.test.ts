import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntime } from '../runtime/build-runtime.js';
import { COMMAND_AND_CONTROL_TOOL_NAMES } from '../types/tool.js';
import { parseGoogleResource } from '../storage/workspace-alias-repo.js';

describe('Slack Command & Control and /ops Upgrade Suite', { concurrency: 1 }, () => {
  const runtime = buildRuntime({
    appDbPath: ':memory:',
    ledgerDbPath: ':memory:'
  });
  runtime.routineRepo.upsertRoutine({
    id: 'test_seed_routine',
    title: 'Test Seed Routine',
    cron_schedule: '15 9 * * 1-5',
    destination: 'Slack',
    default_grant: ['result_read']
  });

  const dispatcher = runtime.dispatcher;

  const slackContext = {
    runId: 'slack_test_run',
    isInteractive: true,
    slackOrigin: {
      channel: 'D12345',
      user: 'U_OWNER',
      isDirectMessage: true
    },
    toolGrant: {
      allowedToolNames: new Set(dispatcher.getAllTools().map(t => t.name)),
      allowConsequential: true
    }
  };

  const backgroundContext = {
    runId: 'routine_bg_run',
    isInteractive: false,
    toolGrant: {
      allowedToolNames: new Set(['routine_manage', 'result_read']),
      allowConsequential: false
    }
  };

  describe('1. Security Guardrails & Tool Inventory', { concurrency: 1 }, () => {
    it('registers all 7 Command & Control tools in dispatcher', () => {
      for (const name of COMMAND_AND_CONTROL_TOOL_NAMES) {
        const tool = dispatcher.getTool(name);
        assert.ok(tool, `Expected C&C tool '${name}' to be registered.`);
      }
    });

    it('strictly DENIES Command & Control tools to background runs (isInteractive=false)', async () => {
      await assert.rejects(async () => {
        await dispatcher.dispatch('routine_manage', { action: 'list' }, backgroundContext);
      }, /\[Security Refusal\]/);
    });

    it('strictly DENIES non-direct-message Slack runs', async () => {
      const nonDmContext = {
        ...slackContext,
        slackOrigin: { channel: 'C_PUBLIC', user: 'U_OTHER', isDirectMessage: false }
      };
      await assert.rejects(async () => {
        await dispatcher.dispatch('routine_manage', { action: 'list' }, nonDmContext);
      }, /INTERACTIVE_SLACK/);
    });
  });

  describe('2. routine_manage & Routines Persistence', { concurrency: 1 }, () => {
    it('lists routines with destination and cadence', async () => {
      const res: any = await dispatcher.dispatch('routine_manage', { action: 'list' }, slackContext);
      let listData = res;
      if (res.isStored && res.handle) {
        const stored = runtime.resultStore.get(res.handle);
        assert.ok(stored);
        listData = JSON.parse(stored.content);
      }
      assert.ok(listData.count >= 1);
      const seed = listData.routines.find((r: any) => r.id === 'test_seed_routine');
      assert.ok(seed);
      assert.equal(seed.cadence, 'Mon-Fri 09:15');
      assert.equal(seed.destination, 'Slack');
    });

    it('creates a new routine in the database', async () => {
      const res: any = await dispatcher.dispatch('routine_manage', {
        action: 'create',
        routine_id: 'new_market_scan',
        title: 'New Market Scan',
        cron_schedule: '30 8 * * 1',
        destination: 'Sheet: Market Leads',
        description: 'Scan new EU market entries'
      }, slackContext);

      assert.equal(res.status, 'created');
      const inDb = runtime.routineRepo.getRoutine('new_market_scan');
      assert.ok(inDb);
      assert.equal(inDb?.destination, 'Sheet: Market Leads');

    });

    it('security guardrail: refuses routine creation with CONSEQUENTIAL tools', async () => {
      await assert.rejects(async () => {
        await dispatcher.dispatch('routine_manage', {
          action: 'create',
          routine_id: 'malicious_routine',
          title: 'Malicious Routine',
          cron_schedule: '0 0 * * *',
          tool_grant: ['gmail_send'] // CONSEQUENTIAL!
        }, slackContext);
      }, /Routines cannot add CONSEQUENTIAL tool 'gmail_send'/);
    });

    it('security guardrail: refuses routine creation with Command & Control tools', async () => {
      await assert.rejects(async () => {
        await dispatcher.dispatch('routine_manage', {
          action: 'create',
          routine_id: 'priv_esc_routine',
          title: 'Privilege Escalation Routine',
          cron_schedule: '0 0 * * *',
          tool_grant: ['routine_manage']
        }, slackContext);
      }, /Routines cannot add Command & Control tool 'routine_manage'/);
    });

    it('enables and disables a routine', async () => {
      await dispatcher.dispatch('routine_manage', {
        action: 'create',
        routine_id: 'routine_toggle_test',
        title: 'Toggle Routine Test',
        cron_schedule: '0 9 * * *'
      }, slackContext);

      await dispatcher.dispatch('routine_manage', {
        action: 'disable',
        routine_id: 'routine_toggle_test'
      }, slackContext);

      let inDb = runtime.routineRepo.getRoutine('routine_toggle_test');
      assert.equal(inDb?.is_active, 0);


      await dispatcher.dispatch('routine_manage', {
        action: 'enable',
        routine_id: 'routine_toggle_test'
      }, slackContext);

      inDb = runtime.routineRepo.getRoutine('routine_toggle_test');
      assert.equal(inDb?.is_active, 1);
    });

    it('updates schedule and prompt instructions', async () => {
      await dispatcher.dispatch('routine_manage', {
        action: 'create',
        routine_id: 'routine_update_test',
        title: 'Update Routine Test',
        cron_schedule: '30 8 * * 1'
      }, slackContext);

      await dispatcher.dispatch('routine_manage', {
        action: 'update_schedule',
        routine_id: 'routine_update_test',
        cron_schedule: '0 10 * * 1-5'
      }, slackContext);

      await dispatcher.dispatch('routine_manage', {
        action: 'update_instructions',
        routine_id: 'routine_update_test',
        description: 'Updated instructions for market scan'
      }, slackContext);

      const inDb = runtime.routineRepo.getRoutine('routine_update_test');
      assert.equal(inDb?.cron_schedule, '0 10 * * 1-5');
      assert.equal(inDb?.cadence_description, 'Mon-Fri 10:00');
      assert.equal(inDb?.description, 'Updated instructions for market scan');
    });

    it('deletes a routine', async () => {
      await dispatcher.dispatch('routine_manage', {
        action: 'create',
        routine_id: 'routine_delete_test',
        title: 'Delete Routine Test',
        cron_schedule: '0 12 * * *'
      }, slackContext);

      await dispatcher.dispatch('routine_manage', {
        action: 'delete',
        routine_id: 'routine_delete_test'
      }, slackContext);

      const inDb = runtime.routineRepo.getRoutine('routine_delete_test');
      assert.equal(inDb, null);

    });
  });

  describe('3. reminder_manage (Full Lifecycle)', { concurrency: 1 }, () => {
    let createdReminderId = '';

    it('creates a reminder', async () => {
      const res: any = await dispatcher.dispatch('reminder_manage', {
        action: 'create',
        title: 'Review advisory invoice',
        target_time: new Date(Date.now() + 3600000).toISOString()
      }, slackContext);

      assert.equal(res.status, 'created');
      assert.ok(res.id);
      createdReminderId = res.id;
    });

    it('lists reminders', async () => {
      const res: any = await dispatcher.dispatch('reminder_manage', {
        action: 'list',
        status_filter: 'PENDING'
      }, slackContext);

      assert.ok(res.count >= 1);
      assert.ok(res.reminders.some((r: any) => r.id === createdReminderId));
    });

    it('reschedules a reminder', async () => {
      const newTime = new Date(Date.now() + 7200000).toISOString();
      const res: any = await dispatcher.dispatch('reminder_manage', {
        action: 'reschedule',
        reminder_id: createdReminderId,
        target_time: newTime
      }, slackContext);

      assert.equal(res.status, 'rescheduled');
    });

    it('cancels and deletes a reminder', async () => {
      const cancelRes: any = await dispatcher.dispatch('reminder_manage', {
        action: 'cancel',
        reminder_id: createdReminderId
      }, slackContext);
      assert.equal(cancelRes.status, 'cancelled');

      const delRes: any = await dispatcher.dispatch('reminder_manage', {
        action: 'delete',
        reminder_id: createdReminderId
      }, slackContext);
      assert.equal(delRes.status, 'deleted');
    });
  });

  describe('4. nudge_settings_manage (Proactive Noise & Snooze)', { concurrency: 1 }, () => {
    it('sets snooze and holds non-urgent nudges', async () => {
      const until = new Date(Date.now() + 3600000);
      const res: any = await dispatcher.dispatch('nudge_settings_manage', {
        action: 'snooze',
        snooze_until: until.toISOString()
      }, slackContext);

      assert.equal(res.status, 'snoozed');

      // Test that non-urgent message is held
      const admission = runtime.nudgeGate.admit({
        source: 'test',
        priority: 'normal',
        text: 'Non-urgent update'
      });
      assert.equal(admission.decision.action, 'HOLD');
      assert.ok(admission.decision.reason?.includes('snoozed'));
    });

    it('unsnoozes proactive messages', async () => {
      const res: any = await dispatcher.dispatch('nudge_settings_manage', {
        action: 'unsnooze'
      }, slackContext);

      assert.equal(res.status, 'unsnoozed');
      const settings = runtime.nudgeGate.getSettings();
      assert.equal(settings.isSnoozed, false);
    });

    it('updates quiet hours and daily cap in SQLite', async () => {
      await dispatcher.dispatch('nudge_settings_manage', {
        action: 'set_quiet_hours',
        quiet_hours_start: 22,
        quiet_hours_end: 7
      }, slackContext);

      await dispatcher.dispatch('nudge_settings_manage', {
        action: 'set_daily_cap',
        daily_cap: 12
      }, slackContext);

      const settings = runtime.nudgeGate.getSettings();
      assert.equal(settings.quietHoursStart, 22);
      assert.equal(settings.quietHoursEnd, 7);
      assert.equal(settings.dailyCap, 12);
    });

    it('delivers held messages now', async () => {
      const res: any = await dispatcher.dispatch('nudge_settings_manage', {
        action: 'deliver_held_now'
      }, slackContext);

      assert.equal(res.status, 'delivered');
      assert.ok(res.deliveredCount >= 1);
    });
  });

  describe('5. memory_manage (Executive Rules & Facts)', { concurrency: 1 }, () => {
    let ruleId = '';

    it('adds a global rule', async () => {
      const res: any = await dispatcher.dispatch('memory_manage', {
        action: 'add_global_rule',
        statement: 'Always format connection notes under 300 characters',
        domain: 'rules'
      }, slackContext);

      assert.equal(res.status, 'rule_added');
      assert.ok(res.fact.id);
      ruleId = res.fact.id;
    });

    it('searches facts and candidates', async () => {
      const res: any = await dispatcher.dispatch('memory_manage', {
        action: 'search',
        query: '300 characters'
      }, slackContext);

      assert.ok(res.factsCount >= 1);
      assert.ok(res.facts.some((f: any) => f.id === ruleId));
    });

    it('edits a rule', async () => {
      const res: any = await dispatcher.dispatch('memory_manage', {
        action: 'edit',
        id: ruleId,
        statement: 'Always format connection notes under 280 characters'
      }, slackContext);

      assert.equal(res.status, 'fact_updated');
      const loaded = runtime.memoryRepo.getFact(ruleId);
      assert.equal(loaded?.statement, 'Always format connection notes under 280 characters');
    });

    it('deletes a rule (Forget that rule)', async () => {
      const res: any = await dispatcher.dispatch('memory_manage', {
        action: 'delete',
        id: ruleId
      }, slackContext);

      assert.equal(res.status, 'fact_deleted');
      const loaded = runtime.memoryRepo.getFact(ruleId);
      assert.equal(loaded, null);
    });
  });

  describe('6. queue_manage (Approval Queue Control)', { concurrency: 1 }, () => {
    let actionId = '';

    it('stages a draft action for testing', () => {
      const staged = runtime.ledgerRepo.stageProposal({
        actionType: 'gmail_send',
        payload: { to: 'prospect@test.com', subject: 'Intro', body: 'Draft body' },
        batchId: 'batch_test_queue'
      });
      actionId = staged.id;
    });

    it('lists staged actions', async () => {
      const res: any = await dispatcher.dispatch('queue_manage', {
        action: 'list_staged',
        batch_id: 'batch_test_queue'
      }, slackContext);

      assert.ok(res.count >= 1);
      assert.ok(res.actions.some((a: any) => a.id === actionId));
    });

    it('updates staged payload in place', async () => {
      const res: any = await dispatcher.dispatch('queue_manage', {
        action: 'update_staged_payload',
        action_id: actionId,
        payload: { to: 'prospect@test.com', subject: 'Revised Intro', body: 'Revised body' }
      }, slackContext);

      assert.equal(res.status, 'payload_updated');
      const loaded = runtime.ledgerRepo.get(actionId);
      const parsed = JSON.parse(loaded!.payload_json);
      assert.equal(parsed.subject, 'Revised Intro');
    });

    it('drops an action', async () => {
      const res: any = await dispatcher.dispatch('queue_manage', {
        action: 'drop_action',
        action_id: actionId,
        reason: 'Dropped via Slack command'
      }, slackContext);

      assert.equal(res.status, 'dropped');
      const loaded = runtime.ledgerRepo.get(actionId);
      assert.equal(loaded?.state, 'DENIED');
    });

    it('drops a batch', async () => {
      const staged2 = runtime.ledgerRepo.stageProposal({
        actionType: 'gmail_send',
        payload: { to: 'batch@test.com', body: 'Batch item' },
        batchId: 'batch_drop_test'
      });

      const res: any = await dispatcher.dispatch('queue_manage', {
        action: 'drop_batch',
        batch_id: 'batch_drop_test'
      }, slackContext);

      assert.equal(res.status, 'batch_dropped');
      assert.equal(res.droppedCount, 1);
      assert.equal(runtime.ledgerRepo.get(staged2.id)?.state, 'DENIED');
    });
  });

  describe('7. workspace_alias_manage (Dynamic Doc/Sheet IDs & URLs)', { concurrency: 1 }, () => {
    it('parses Google Sheets, Docs, and Folders URLs accurately', () => {
      const sheet = parseGoogleResource('https://docs.google.com/spreadsheets/d/1MOCK_SHEET_ID_FOR_UNIT_TESTING_1234567890abc/edit#gid=0');
      assert.equal(sheet.id, '1MOCK_SHEET_ID_FOR_UNIT_TESTING_1234567890abc');
      assert.equal(sheet.type, 'sheet');

      const doc = parseGoogleResource('https://docs.google.com/document/d/1MOCK_DOC_ID_FOR_UNIT_TESTING_1234567890abc/edit');
      assert.equal(doc.id, '1MOCK_DOC_ID_FOR_UNIT_TESTING_1234567890abc');
      assert.equal(doc.type, 'doc');
    });

    it('sets a new alias from a full Google Sheets URL', async () => {
      const url = 'https://docs.google.com/spreadsheets/d/1ABC_CUSTOM_TRACKER_XYZ/edit#gid=123';
      const res: any = await dispatcher.dispatch('workspace_alias_manage', {
        action: 'set',
        alias_key: 'job_tracker',
        resource_id_or_url: url
      }, slackContext);

      assert.equal(res.status, 'set');
      assert.equal(res.alias.resource_id, '1ABC_CUSTOM_TRACKER_XYZ');
      assert.equal(runtime.aliasRepo.resolveId('job_tracker'), '1ABC_CUSTOM_TRACKER_XYZ');
    });

    it('lists workspace aliases', async () => {
      const res: any = await dispatcher.dispatch('workspace_alias_manage', {
        action: 'list'
      }, slackContext);

      assert.ok(res.count >= 1);
      assert.ok(res.aliases.some((a: any) => a.alias_key === 'job_tracker'));
    });
  });

  describe('8. sentinel_manage & cost_and_budget_manage', { concurrency: 1 }, () => {
    it('lists sentinels, enables and disables sentinels', async () => {
      const listRes: any = await dispatcher.dispatch('sentinel_manage', { action: 'list' }, slackContext);
      assert.ok(listRes.count >= 3);

      const disRes: any = await dispatcher.dispatch('sentinel_manage', {
        action: 'disable',
        sentinel_id: 'gmail_sentinel'
      }, slackContext);
      assert.equal(disRes.status, 'disabled');

      const enRes: any = await dispatcher.dispatch('sentinel_manage', {
        action: 'enable',
        sentinel_id: 'gmail_sentinel'
      }, slackContext);
      assert.equal(enRes.status, 'enabled');
    });

    it('adds, lists, and removes VIP and ignore sender rules', async () => {
      const addRes: any = await dispatcher.dispatch('sentinel_manage', {
        action: 'add_rule',
        sentinel_id: 'gmail_sentinel',
        rule_type: 'vip',
        pattern: 'investor@firm.vc',
        reason: 'Key stakeholder'
      }, slackContext);

      assert.equal(addRes.status, 'rule_added');
      assert.ok(addRes.rule.id);

      const listRes: any = await dispatcher.dispatch('sentinel_manage', {
        action: 'list_rules',
        sentinel_id: 'gmail_sentinel'
      }, slackContext);
      assert.ok(listRes.rules.some((r: any) => r.pattern === 'investor@firm.vc'));

      const remRes: any = await dispatcher.dispatch('sentinel_manage', {
        action: 'remove_rule',
        rule_id: addRes.rule.id
      }, slackContext);
      assert.equal(remRes.status, 'rule_removed');
    });

    it('queries spend breakdown between Flash and the reasoning model', async () => {
      // Record sample usage
      runtime.costRepo.recordUsage({
        model: 'gemini-3.8-flash',
        source: 'slack',
        prompt_tokens: 500,
        cached_tokens: 100,
        thinking_tokens: 150,
        completion_tokens: 200,
        total_tokens: 700
      });
      runtime.costRepo.recordUsage({
        model: 'gemini-test-pro',
        source: 'slack',
        prompt_tokens: 1000,
        cached_tokens: 250,
        thinking_tokens: 500,
        completion_tokens: 400,
        total_tokens: 1400
      });

      const todayRes: any = await dispatcher.dispatch('cost_and_budget_manage', { action: 'today' }, slackContext);
      assert.equal(todayRes.window, 'today');
      assert.ok(todayRes.flash.callsCount >= 1);
      assert.ok(todayRes.reasoning.callsCount >= 1);
      assert.ok(todayRes.flash.estimatedCostUsd >= 0);
      assert.ok(todayRes.reasoning.estimatedCostUsd >= 0);
      assert.ok(todayRes.totalCostUsd > 0);
    });
  });
});
