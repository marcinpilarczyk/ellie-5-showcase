import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CORE_INTERACTIVE_TOOL_NAMES,
  DOCUMENT_TOOL_NAMES,
  IMAGE_TOOL_NAMES,
  MANAGEMENT_TOOL_NAMES,
  DIAGNOSTIC_TOOL_NAMES,
  COMPOSIO_TOOL_NAMES,
  resolveInteractiveSlackGrant,
  SlackCoworkerService,
  SlackEventPayload
} from '../integrations/slack/coworker.js';

describe('P4: Per-run tool grants for Slack runs', () => {
  const allAvailableTools = [
    ...CORE_INTERACTIVE_TOOL_NAMES,
    ...DOCUMENT_TOOL_NAMES,
    ...IMAGE_TOOL_NAMES,
    ...MANAGEMENT_TOOL_NAMES,
    ...DIAGNOSTIC_TOOL_NAMES,
    ...COMPOSIO_TOOL_NAMES,
    'composio_github_create_issue'
  ];

  it('scopes everyday conversational questions to CORE assistant tools only', () => {
    const grant = resolveInteractiveSlackGrant({
      userText: "what's on my calendar tomorrow morning?",
      allAvailableTools
    });

    // Core tools are present
    assert.ok(grant.has('calendar_list'));
    assert.ok(grant.has('calendar_get_event'));
    assert.ok(grant.has('gmail_get_thread'));
    assert.ok(grant.has('web_search'));
    assert.ok(grant.has('waiting_track'));
    assert.ok(grant.has('space_publish'));
    assert.ok(grant.has('delegate_subtask'));

    // Specialized tool clusters are NOT granted (fewer wrong choices, smaller prompts)
    assert.equal(grant.has('repo_read_file'), false);
    assert.equal(grant.has('trace_inspect_recent'), false);
    assert.equal(grant.has('vps_inspect'), false);
    assert.equal(grant.has('routine_manage'), false);
    assert.equal(grant.has('cost_and_budget_manage'), false);
    assert.equal(grant.has('document_render'), false);
    assert.equal(grant.has('owner_sources_read'), false);
    assert.equal(grant.has('image_generate'), false);
    assert.equal(grant.has('composio_install_tool'), false);
  });

  it('grants DOCUMENT_TOOL_NAMES when the user asks to tailor a resume, write a doc, or evaluate a job', () => {
    const grant = resolveInteractiveSlackGrant({
      userText: 'make a tailored resume and cover letter for this PM role',
      allAvailableTools
    });

    // Core tools
    assert.ok(grant.has('calendar_list'));
    assert.ok(grant.has('web_search'));

    // Document tools
    assert.ok(grant.has('document_render'));
    assert.ok(grant.has('visual_document_render'));
    assert.ok(grant.has('owner_sources_read'));
    assert.ok(grant.has('owner_text_check'));
    assert.ok(grant.has('docs_create'));
    assert.ok(grant.has('drive_search'));
    assert.ok(grant.has('job_evaluate'));

    // Diagnostics and Management tools still excluded
    assert.equal(grant.has('repo_read_file'), false);
    assert.equal(grant.has('trace_inspect_recent'), false);
    assert.equal(grant.has('routine_manage'), false);
  });

  it('grants DIAGNOSTIC_TOOL_NAMES when the user inquires about errors, failures, traces, or VPS state', () => {
    const grant = resolveInteractiveSlackGrant({
      userText: 'why did the morning routine fail? please inspect the recent error trace and check VPS logs',
      allAvailableTools
    });

    assert.ok(grant.has('trace_inspect_recent'));
    assert.ok(grant.has('trace_inspect_run'));
    assert.ok(grant.has('repo_list_and_search'));
    assert.ok(grant.has('repo_read_file'));
    assert.ok(grant.has('vps_inspect'));

    // Document rendering and image tools not granted
    assert.equal(grant.has('document_render'), false);
    assert.equal(grant.has('image_generate'), false);
  });

  it('grants MANAGEMENT_TOOL_NAMES when the user issues routine, reminder, or cost commands', () => {
    const grant = resolveInteractiveSlackGrant({
      userText: 'how much did we spend today on Flash vs Argon? Also please snooze routine morning_brief',
      allAvailableTools
    });

    assert.ok(grant.has('cost_and_budget_manage'));
    assert.ok(grant.has('routine_manage'));
    assert.ok(grant.has('reminder_manage'));
    assert.ok(grant.has('nudge_settings_manage'));

    assert.equal(grant.has('document_render'), false);
    assert.equal(grant.has('repo_read_file'), false);
  });

  it('grants IMAGE_TOOL_NAMES when images are requested or attached', () => {
    // 1. Text request
    const textGrant = resolveInteractiveSlackGrant({
      userText: 'generate an illustration of a robot sipping coffee in 16:9',
      allAvailableTools
    });
    assert.ok(textGrant.has('image_generate'));
    assert.ok(textGrant.has('image_edit'));
    assert.ok(textGrant.has('image_describe'));

    // 2. Attached image file
    const attachedGrant = resolveInteractiveSlackGrant({
      userText: 'what do you think of this layout?',
      allAvailableTools,
      hasAttachedImages: true
    });
    assert.ok(attachedGrant.has('image_describe'));
    assert.ok(attachedGrant.has('image_edit'));
  });

  it('grants COMPOSIO_TOOL_NAMES when third-party tools or integrations are requested', () => {
    const grant = resolveInteractiveSlackGrant({
      userText: 'find a free tool on composio to manage github issues and pull requests',
      allAvailableTools
    });

    assert.ok(grant.has('composio_search_free_tools'));
    assert.ok(grant.has('composio_install_tool'));
    assert.ok(grant.has('composio_setup_tool'));
    assert.ok(grant.has('composio_execute_tool'));
    assert.ok(grant.has('composio_github_create_issue'));
  });

  it('grants all available tools when user explicitly invokes /all-tools', () => {
    const grant = resolveInteractiveSlackGrant({
      userText: '/all-tools inspect and update everything',
      allAvailableTools
    });

    assert.equal(grant.size, allAvailableTools.length);
  });

  it('infers document intent from prior thread history even on brief follow-ups', () => {
    const grant = resolveInteractiveSlackGrant({
      userText: 'now proceed with drafting it',
      conversationHistory: [
        { role: 'user', parts: [{ text: 'Here is the job posting for Senior PM at Allegro: https://example.com/job' }] },
        { role: 'model', parts: [{ text: 'I reviewed the job posting. Should I prepare a tailored resume?' }] }
      ],
      allAvailableTools
    });

    assert.ok(grant.has('document_render'));
    assert.ok(grant.has('owner_sources_read'));
    assert.ok(grant.has('owner_text_check'));
  });

  it('SlackCoworkerService pre-warms cache and executes runner with identical scoped toolGrant', async () => {
    let warmedGrant: any;
    let executedGrant: any;

    const fakeSlack: any = {
      isConfigured: () => true,
      defaultChannel: 'C_TEST',
      addReaction: async () => {},
      removeReaction: async () => {},
      postMessage: async () => ({ ok: true, ts: 'msg_ts' })
    };

    const fakeLedger: any = {
      listStagedByRun: () => [],
      getLatestStagedByThreadTs: () => null
    };

    const mockTools = allAvailableTools.map(name => ({ name }));
    const fakeDispatcher: any = {
      getAllTools: () => mockTools
    };

    const fakeRunner: any = {
      getDispatcher: () => fakeDispatcher,
      warmInteractiveCache: (grant: any) => {
        warmedGrant = grant;
      },
      run: async (opts: any) => {
        executedGrant = opts.toolGrant;
        return {
          runId: 'test_run_1',
          status: 'COMPLETED',
          output: { deliveryMode: 'SLACK_MESSAGE', coworkerHeadline: 'Here is your calendar.' }
        };
      }
    };

    const coworker = new SlackCoworkerService(fakeSlack, fakeLedger, fakeRunner);

    const event: SlackEventPayload = {
      type: 'message',
      user: 'U_OWNER',
      text: 'what is on my schedule today?',
      ts: '1792080000.123',
      channel: 'C_TEST'
    };

    await coworker.handleUserMessage(event);

    assert.ok(warmedGrant, 'warmInteractiveCache should have been called');
    assert.ok(executedGrant, 'runner.run should have been called');
    // Verify byte-stable cache compatibility: warmed tool set equals executed tool set
    assert.deepEqual(Array.from(warmedGrant.allowedToolNames).sort(), Array.from(executedGrant.allowedToolNames).sort());
    // Verify that calendar tools were granted while diagnostic tools were withheld
    assert.ok(executedGrant.allowedToolNames.has('calendar_list'));
    assert.equal(executedGrant.allowedToolNames.has('repo_read_file'), false);
    assert.equal(executedGrant.allowedToolNames.has('trace_inspect_recent'), false);
  });
});
