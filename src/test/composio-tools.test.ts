import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeAppDatabase, initializeLedgerDatabase } from '../storage/schema.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { ResultStore } from '../storage/result-store.js';
import { ThreadCarryoverRepository } from '../storage/thread-carryover-repo.js';
import { ComposioRepository } from '../storage/composio-repo.js';
import { ComposioClient } from '../integrations/composio/client.js';
import { createComposioTools, registerInstalledComposioTools } from '../tools/composio-tools.js';
import { ToolDispatcher } from '../governance/dispatcher.js';
import { executeApprovedAction } from '../governance/executor.js';
import { UnifiedAgentRunner } from '../agent/runner.js';
import { SlackCoworkerService } from '../integrations/slack/coworker.js';

const telemetry = {
  promptTokens: 100,
  cachedTokens: 40,
  thinkingTokens: 10,
  candidatesTokens: 25,
  totalTokens: 135,
  durationMs: 12,
  model: 'test-model'
};

function createMockComposioFetch() {
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  let oauthConnected = false;

  const fetchFn: typeof fetch = async (input: any, init?: any) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    // 1. Search catalog: GET /tools?search=...
    if (method === 'GET' && url.includes('/tools?')) {
      return new Response(
        JSON.stringify({
          items: [
            {
              slug: 'HACKERNEWS_GET_TOP_STORIES',
              toolkit: { slug: 'hackernews' },
              display_name: 'Get HackerNews Top Stories',
              description: 'Fetches current top stories from HackerNews for free without authentication.',
              no_auth: true,
              auth_schemes: [],
              input_parameters: {
                type: 'object',
                properties: {
                  limit: { type: 'number', description: 'Number of stories to fetch' }
                }
              }
            },
            {
              slug: 'PAID_ENTERPRISE_SCRAPER_RUN',
              toolkit: { slug: 'enterprise_scraper' },
              display_name: 'Enterprise Paid Scraper',
              description: 'Requires paid enterprise plan.',
              is_paid: true,
              pricing_tier: 'enterprise',
              auth_schemes: ['API_KEY'],
              input_parameters: { type: 'object', properties: {} }
            },
            {
              slug: 'GITHUB_CREATE_ISSUE',
              toolkit: { slug: 'github' },
              display_name: 'Create GitHub Issue',
              description: 'Creates an issue in a GitHub repository.',
              auth_schemes: ['OAUTH2'],
              input_parameters: {
                type: 'object',
                properties: {
                  owner: { type: 'string' },
                  repo: { type: 'string' },
                  title: { type: 'string' }
                },
                required: ['owner', 'repo', 'title']
              }
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 2. Get single tool: GET /tools/{slug}
    if (method === 'GET' && url.includes('/tools/HACKERNEWS_GET_TOP_STORIES')) {
      return new Response(
        JSON.stringify({
          slug: 'HACKERNEWS_GET_TOP_STORIES',
          toolkit: { slug: 'hackernews' },
          display_name: 'Get HackerNews Top Stories',
          description: 'Fetches current top stories from HackerNews for free without authentication.',
          no_auth: true,
          auth_schemes: [],
          input_parameters: {
            type: 'object',
            properties: {
              limit: { type: 'number', description: 'Number of stories to fetch' }
            }
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (method === 'GET' && url.includes('/tools/GITHUB_CREATE_ISSUE')) {
      return new Response(
        JSON.stringify({
          slug: 'GITHUB_CREATE_ISSUE',
          toolkit: { slug: 'github' },
          display_name: 'Create GitHub Issue',
          description: 'Creates an issue in a GitHub repository.',
          auth_schemes: ['OAUTH2'],
          input_parameters: {
            type: 'object',
            properties: {
              owner: { type: 'string' },
              repo: { type: 'string' },
              title: { type: 'string' }
            },
            required: ['owner', 'repo', 'title']
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (method === 'GET' && url.includes('/tools/PAID_ENTERPRISE_SCRAPER_RUN')) {
      return new Response(
        JSON.stringify({
          slug: 'PAID_ENTERPRISE_SCRAPER_RUN',
          toolkit: { slug: 'enterprise_scraper' },
          display_name: 'Enterprise Paid Scraper',
          description: 'Requires paid enterprise plan.',
          is_paid: true,
          pricing_tier: 'enterprise',
          auth_schemes: ['API_KEY']
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 3. Connected accounts check: GET /connected_accounts
    if (method === 'GET' && url.includes('/connected_accounts')) {
      if (oauthConnected) {
        return new Response(
          JSON.stringify({
            items: [{ id: 'conn_gh_123', toolkit_slug: 'github', status: 'ACTIVE' }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 4. Create OAuth link session: POST /connected_accounts/link
    if (method === 'POST' && url.includes('/connected_accounts/link')) {
      return new Response(
        JSON.stringify({
          id: 'conn_gh_pending',
          status: 'INITIATED',
          redirect_url: 'https://backend.composio.dev/connect/github/session-xyz'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 5. Execute tool: POST /tools/execute/HACKERNEWS_GET_TOP_STORIES
    if (method === 'POST' && url.includes('/tools/execute/HACKERNEWS_GET_TOP_STORIES')) {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            response_data: {
              stories: [
                { id: 101, title: 'SQLite 3.50 Released', points: 412 },
                { id: 102, title: 'Composio Dynamic Agent Tooling', points: 289 }
              ]
            }
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ error: `Unhandled mock route: ${method} ${url}` }), { status: 404 });
  };

  return {
    fetchFn,
    calls,
    setOAuthConnected: (val: boolean) => {
      oauthConnected = val;
    }
  };
}

describe('Composio Integration (search free tools → propose install → approve → set up → finish task)', () => {
  it('searches Composio catalog and filters to free tools by default', async () => {
    const appDb = new DatabaseSync(':memory:');
    const ledgerDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    initializeLedgerDatabase(ledgerDb);

    const repo = new ComposioRepository(appDb);
    const ledgerRepo = new ActionLedgerRepository(ledgerDb);
    const dispatcher = new ToolDispatcher(ledgerRepo);
    const mock = createMockComposioFetch();
    const client = new ComposioClient({ apiKey: 'comp_test_key', fetchFn: mock.fetchFn });

    createComposioTools({ client, repo, dispatcher }).forEach(t => dispatcher.registerTool(t));

    const res: any = await dispatcher.dispatch(
      'composio_search_tools',
      { query: 'hackernews', freeOnly: true },
      {
        runId: 'run_search_1',
        isInteractive: true,
        toolGrant: { allowedToolNames: new Set(['composio_search_tools']), allowConsequential: false }
      }
    );

    assert.equal(res.status, 'SUCCESS');
    // Paid tool PAID_ENTERPRISE_SCRAPER_RUN is filtered out
    assert.equal(res.tools.some((t: any) => t.toolSlug === 'PAID_ENTERPRISE_SCRAPER_RUN'), false);
    const hn = res.tools.find((t: any) => t.toolSlug === 'HACKERNEWS_GET_TOP_STORIES');
    assert.ok(hn);
    assert.equal(hn.isFree, true);
    assert.equal(hn.authMode, 'NONE');
    assert.equal(hn.registeredToolName, 'composio_hackernews_get_top_stories');
    assert.equal(hn.alreadyInstalled, false);
  });

  it('refuses to execute an uninstalled tool and refuses paid tool installation', async () => {
    const appDb = new DatabaseSync(':memory:');
    const ledgerDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    initializeLedgerDatabase(ledgerDb);

    const repo = new ComposioRepository(appDb);
    const ledgerRepo = new ActionLedgerRepository(ledgerDb);
    const dispatcher = new ToolDispatcher(ledgerRepo);
    const mock = createMockComposioFetch();
    const client = new ComposioClient({ apiKey: 'comp_test_key', fetchFn: mock.fetchFn });

    createComposioTools({ client, repo, dispatcher }).forEach(t => dispatcher.registerTool(t));

    // 1. Uninstalled tool execution must fail closed
    await assert.rejects(
      dispatcher.dispatch(
        'composio_execute_tool',
        { toolSlug: 'HACKERNEWS_GET_TOP_STORIES', arguments: { limit: 2 } },
        {
          runId: 'run_uninstalled',
          isInteractive: true,
          toolGrant: { allowedToolNames: new Set(['composio_execute_tool']), allowConsequential: false }
        }
      ),
      /not installed/i
    );

    // 2. Paid tool installation is refused when executed
    const stagedPaid: any = await dispatcher.dispatch(
      'composio_install_tool',
      {
        toolSlug: 'PAID_ENTERPRISE_SCRAPER_RUN',
        reason: 'Scrape enterprise data',
        pendingTask: 'Run enterprise scrape'
      },
      {
        runId: 'run_paid',
        isInteractive: true,
        toolGrant: { allowedToolNames: new Set(['composio_install_tool']), allowConsequential: true }
      }
    );
    assert.equal(stagedPaid.status, 'STAGED_FOR_APPROVAL');

    const paidOutcome = await executeApprovedAction(stagedPaid.actionId, { ledgerRepo, dispatcher });
    assert.equal(paidOutcome.ok, false);
    assert.equal(paidOutcome.status, 'FAILED_SAFE');
    assert.match(paidOutcome.message, /Only free Composio tools may be installed/i);
  });

  it('completes the full end-to-end flow: missing tool → search Composio → stage install → owner approves → installs, sets up, and finishes the task in Slack', async () => {
    const appDb = new DatabaseSync(':memory:');
    const ledgerDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    initializeLedgerDatabase(ledgerDb);

    const repo = new ComposioRepository(appDb);
    const ledgerRepo = new ActionLedgerRepository(ledgerDb);
    const resultStore = new ResultStore(appDb);
    const carryover = new ThreadCarryoverRepository(appDb, resultStore);
    const dispatcher = new ToolDispatcher(ledgerRepo, resultStore);
    const mock = createMockComposioFetch();
    const client = new ComposioClient({ apiKey: 'comp_test_key', fetchFn: mock.fetchFn });

    createComposioTools({ client, repo, dispatcher }).forEach(t => dispatcher.registerTool(t));

    // Scripted model turns:
    // Turn 1 (initial user request): Ellie lacks a HackerNews tool, so she calls composio_search_tools
    // Turn 2: Ellie sees HACKERNEWS_GET_TOP_STORIES (free, no_auth) and calls composio_install_tool (which stages for approval)
    // Turn 3: Ellie finishes initial run explaining she proposed installing HACKERNEWS_GET_TOP_STORIES
    // --- Owner clicks [Approve] on the Slack quote card ---
    // Turn 4 (post-approval continuation run): Ellie calls the newly installed composio_hackernews_get_top_stories tool
    // Turn 5: Ellie finishes with the top HackerNews stories summary!
    let modelTurn = 0;
    const mockModelRouter: any = {
      modelName: 'test-model',
      warmPrefixCache: () => {},
      generate: async () => {
        modelTurn++;
        if (modelTurn === 1) {
          return {
            text: '',
            functionCalls: [
              { name: 'composio_search_tools', args: { query: 'hackernews top stories', freeOnly: true } }
            ],
            telemetry,
            rawResponse: {}
          };
        }
        if (modelTurn === 2) {
          return {
            text: '',
            functionCalls: [
              {
                name: 'composio_install_tool',
                args: {
                  toolSlug: 'HACKERNEWS_GET_TOP_STORIES',
                  toolkitSlug: 'hackernews',
                  authMode: 'NONE',
                  reason: 'Fetch top stories from HackerNews',
                  pendingTask: 'Get the top 2 stories on HackerNews and list their titles and points.'
                }
              }
            ],
            telemetry,
            rawResponse: {}
          };
        }
        if (modelTurn === 3) {
          return {
            text: '',
            functionCalls: [
              {
                name: 'finish',
                args: {
                  status: 'DONE',
                  message: 'I found a free HackerNews tool on Composio (`HACKERNEWS_GET_TOP_STORIES`) and staged it for your approval below.'
                }
              }
            ],
            telemetry,
            rawResponse: {}
          };
        }
        if (modelTurn === 4) {
          // Post-approval continuation run: the newly installed tool is now registered and granted!
          return {
            text: '',
            functionCalls: [
              {
                name: 'composio_hackernews_get_top_stories',
                args: { limit: 2 }
              }
            ],
            telemetry,
            rawResponse: {}
          };
        }
        return {
          text: '',
          functionCalls: [
            {
              name: 'finish',
              args: {
                status: 'DONE',
                message: 'Top 2 HackerNews stories: 1) SQLite 3.50 Released (412 points), 2) Composio Dynamic Agent Tooling (289 points).'
              }
            }
          ],
          telemetry,
          rawResponse: {}
        };
      }
    };

    const runner = new UnifiedAgentRunner(mockModelRouter, dispatcher);
    const postedMessages: any[] = [];
    const updatedMessages: any[] = [];

    const mockSlack: any = {
      isConfigured: () => true,
      defaultChannel: 'C_MAIN',
      postMessage: async (msg: any) => {
        const ts = `msg_${postedMessages.length + 1}.0`;
        postedMessages.push({ ...msg, ts });
        return { ok: true, ts, channel: msg.channel };
      },
      updateMessage: async (msg: any) => {
        updatedMessages.push(msg);
        return { ok: true, ts: msg.ts };
      },
      addReaction: async () => ({ ok: true }),
      removeReaction: async () => ({ ok: true }),
      getConversationReplies: async () => []
    };

    const coworker = new SlackCoworkerService(
      mockSlack,
      ledgerRepo,
      runner,
      undefined,
      (actionId, actor) => executeApprovedAction(actionId, { ledgerRepo, dispatcher, actor }),
      carryover
    );

    // 1. User sends request in Slack
    await coworker.handleUserMessage({
      type: 'message',
      channel: 'C_MAIN',
      ts: '500.1',
      thread_ts: '500.1',
      user: 'U_OWNER',
      text: 'Get the top 2 stories on HackerNews and list their titles and points.'
    });

    // Verify composio_install_tool was staged and a Slack quote card was posted
    const stagedList = ledgerRepo.listStaged();
    assert.equal(stagedList.length, 1);
    assert.equal(stagedList[0].action_type, 'composio_install_tool');

    const cardPost = postedMessages.find(m => Array.isArray(m.blocks) && m.blocks.length > 0);
    assert.ok(cardPost, 'Expected an approval quote card to be posted in Slack');
    assert.match(JSON.stringify(cardPost.blocks), /HACKERNEWS_GET_TOP_STORIES/);

    // Tool is NOT installed before approval
    assert.equal(repo.getTool('HACKERNEWS_GET_TOP_STORIES'), null);
    assert.equal(dispatcher.getTool('composio_hackernews_get_top_stories'), undefined);

    // 2. Owner clicks [Approve] on the Slack quote card
    await coworker.handleButtonInteraction({
      actions: [{ action_id: 'approve_action', value: stagedList[0].id }],
      channel: { id: 'C_MAIN' },
      message: { ts: cardPost.ts, thread_ts: '500.1' },
      user: { id: 'U_OWNER' }
    });

    // Verify tool is now installed in SQLite, verified in ledger, and registered in ToolDispatcher
    const ledgerAfter = ledgerRepo.get(stagedList[0].id)!;
    assert.equal(ledgerAfter.state, 'VERIFIED');

    const installedTool = repo.getTool('HACKERNEWS_GET_TOP_STORIES');
    assert.ok(installedTool);
    assert.equal(installedTool.connection_status, 'READY');
    assert.equal(installedTool.pending_task, null, 'pending_task should be cleared once executed');

    const dynamicTool = dispatcher.getTool('composio_hackernews_get_top_stories');
    assert.ok(dynamicTool, 'Expected composio_hackernews_get_top_stories to be dynamically registered in ToolDispatcher');

    // Verify the continuation run automatically executed the tool and posted the final answer in the Slack thread!
    assert.equal(modelTurn, 5);
    const finalMessage = postedMessages[postedMessages.length - 1];
    assert.equal(finalMessage.thread_ts, '500.1');
    assert.match(finalMessage.text, /SQLite 3\.50 Released/);
    assert.match(finalMessage.text, /412 points/);
  });

  it('handles OAuth setup flow when an installed tool requires authentication before execution', async () => {
    const appDb = new DatabaseSync(':memory:');
    const ledgerDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    initializeLedgerDatabase(ledgerDb);

    const repo = new ComposioRepository(appDb);
    const ledgerRepo = new ActionLedgerRepository(ledgerDb);
    const dispatcher = new ToolDispatcher(ledgerRepo);
    const mock = createMockComposioFetch();
    const client = new ComposioClient({ apiKey: 'comp_test_key', fetchFn: mock.fetchFn });

    createComposioTools({ client, repo, dispatcher }).forEach(t => dispatcher.registerTool(t));

    // Stage and approve GITHUB_CREATE_ISSUE (requires OAuth2, not yet connected)
    const staged: any = await dispatcher.dispatch(
      'composio_install_tool',
      {
        toolSlug: 'GITHUB_CREATE_ISSUE',
        toolkitSlug: 'github',
        authMode: 'OAUTH2',
        reason: 'Create an issue on GitHub',
        pendingTask: 'Create issue "Bug in login" on owner/repo'
      },
      {
        runId: 'run_gh_install',
        isInteractive: true,
        slackOrigin: { channel: 'C_GH', threadTs: '700.1', isDirectMessage: true },
        toolGrant: { allowedToolNames: new Set(['composio_install_tool']), allowConsequential: true }
      }
    );

    const postedMessages: any[] = [];
    const mockSlack: any = {
      isConfigured: () => true,
      defaultChannel: 'C_GH',
      postMessage: async (msg: any) => {
        postedMessages.push(msg);
        return { ok: true, ts: '700.2' };
      },
      updateMessage: async () => ({ ok: true })
    };

    const coworker = new SlackCoworkerService(
      mockSlack,
      ledgerRepo,
      {} as any,
      undefined,
      (actionId, actor) => executeApprovedAction(actionId, { ledgerRepo, dispatcher, actor })
    );

    await coworker.handleButtonInteraction({
      actions: [{ action_id: 'approve_action', value: staged.actionId }],
      channel: { id: 'C_GH' },
      message: { ts: '700.2', thread_ts: '700.1' },
      user: { id: 'U_OWNER' }
    });

    const installed = repo.getTool('GITHUB_CREATE_ISSUE');
    assert.ok(installed);
    assert.equal(installed.connection_status, 'PENDING_AUTH');
    assert.equal(installed.auth_redirect_url, 'https://backend.composio.dev/connect/github/session-xyz');

    // Verify Slack posted the OAuth connect link to the thread
    assert.equal(postedMessages.length, 1);
    assert.match(postedMessages[0].text, /https:\/\/backend\.composio\.dev\/connect\/github\/session-xyz/);

    // Simulate owner completing OAuth in browser and calling composio_setup_tool
    mock.setOAuthConnected(true);
    const setupRes: any = await dispatcher.dispatch(
      'composio_setup_tool',
      { toolSlug: 'GITHUB_CREATE_ISSUE' },
      {
        runId: 'run_gh_setup',
        isInteractive: true,
        toolGrant: { allowedToolNames: new Set(['composio_setup_tool']), allowConsequential: false }
      }
    );
    assert.equal(setupRes.connectionStatus, 'READY');
    assert.equal(setupRes.connectedAccountId, 'conn_gh_123');
    assert.equal(repo.getTool('GITHUB_CREATE_ISSUE')?.connection_status, 'READY');
  });

  it('re-registers installed SQLite tools automatically on subsequent boot', () => {
    const appDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);

    const repo = new ComposioRepository(appDb);
    repo.upsertTool({
      toolSlug: 'HACKERNEWS_GET_TOP_STORIES',
      toolkitSlug: 'hackernews',
      displayName: 'Get HackerNews Top Stories',
      description: 'Fetches top stories',
      authMode: 'NONE',
      isFree: true,
      effectClass: 'READ',
      parametersSchema: { type: 'object', properties: { limit: { type: 'number' } } },
      connectionStatus: 'READY'
    });

    const dispatcher = new ToolDispatcher();
    const client = new ComposioClient({ apiKey: 'comp_test_key' });
    registerInstalledComposioTools(dispatcher, client, repo);

    const registered = dispatcher.getTool('composio_hackernews_get_top_stories');
    assert.ok(registered);
    assert.equal(registered.effectClass, 'READ');
  });
});
