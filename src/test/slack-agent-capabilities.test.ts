import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SlackClient } from '../integrations/slack/client.js';
import {
  SlackStatusReporter,
  SlackCoworkerService,
  resolveInteractiveSlackGrant,
  SLACK_WORKSPACE_TOOL_NAMES
} from '../integrations/slack/coworker.js';
import { createSlackTools } from '../tools/slack-tools.js';
import { createSlackRouter } from '../http/routes/slack.js';

describe('Slack AI Agent Capabilities Suite', () => {

  describe('1. SlackClient Agent & Canvas Methods', () => {
    let capturedCalls: Array<{ url: string; body: any }>;
    let client: SlackClient;

    beforeEach(() => {
      capturedCalls = [];
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      process.env.SLACK_CHANNEL_ID = 'C123TEST';
      client = new SlackClient({
        botToken: 'xoxb-test-token',
        signingSecret: 'test-secret',
        defaultChannel: 'C123TEST'
      });

      // Intercept fetch
      (globalThis as any).fetch = async (url: string, init?: any) => {
        const body = init?.body ? JSON.parse(init.body) : undefined;
        capturedCalls.push({ url, body });

        if (url.endsWith('chat.startStream')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, ts: '1700000000.100' })
          };
        }
        if (url.endsWith('canvases.create')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, canvas_id: 'F123CANVAS' })
          };
        }
        if (url.endsWith('assistant.search.context')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              results: {
                messages: [{ id: 'msg_1', text: 'Important meeting notes', channel: 'C123' }]
              }
            })
          };
        }
        if (url.endsWith('conversations.history')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              messages: [{ ts: '1700000000.200', text: 'Hello from channel' }]
            })
          };
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true })
        };
      };
    });

    it('setSessionStatus calls agents.sessions.setStatus with correct payload', async () => {
      const res = await client.setSessionStatus({
        channel: 'C123',
        thread_ts: '1700000000.001',
        status: 'processing'
      });
      assert.equal(res.ok, true);
      assert.equal(capturedCalls.length, 1);
      assert.ok(capturedCalls[0].url.includes('agents.sessions.setStatus') || capturedCalls[0].url.includes('assistant.threads.setStatus'));
      assert.equal(capturedCalls[0].body.channel_id, 'C123');
      assert.equal(capturedCalls[0].body.thread_ts, '1700000000.001');
      assert.equal(capturedCalls[0].body.status, 'processing');
    });

    it('renameSession calls agents.sessions.rename with title truncated if necessary', async () => {
      const res = await client.renameSession({
        channel: 'C123',
        thread_ts: '1700000000.001',
        title: 'Q4 Strategy Discussion'
      });
      assert.equal(res.ok, true);
      assert.equal(capturedCalls.length, 1);
      assert.ok(capturedCalls[0].url.includes('agents.sessions.rename') || capturedCalls[0].url.includes('assistant.threads.setTitle'));
      assert.equal(capturedCalls[0].body.title, 'Q4 Strategy Discussion');
    });

    it('setSuggestedPrompts calls assistant.threads.setSuggestedPrompts with prompts list', async () => {
      const prompts = [
        { title: 'Morning Brief', message: 'What is on my calendar today?' }
      ];
      const res = await client.setSuggestedPrompts({
        channel_id: 'C123',
        prompts
      });
      assert.equal(res.ok, true);
      assert.equal(capturedCalls.length, 1);
      assert.ok(capturedCalls[0].url.includes('assistant.threads.setSuggestedPrompts'));
      assert.deepEqual(capturedCalls[0].body.prompts, prompts);
    });

    it('startStream, appendStream, and stopStream format calls according to Slack streaming API', async () => {
      const startRes = await client.startStream({
        channel: 'C123',
        thread_ts: '1700000000.001',
        task_display_mode: 'plan'
      });
      assert.equal(startRes.ok, true);
      assert.equal(startRes.ts, '1700000000.100');

      await client.appendStream({
        channel: 'C123',
        ts: '1700000000.100',
        chunks: [{ type: 'task', id: 'task_1', text: 'Reading docs', status: 'in_progress' }]
      });

      await client.stopStream({
        channel: 'C123',
        ts: '1700000000.100',
        markdown_text: 'All done.',
        session_status: 'active'
      });

      assert.equal(capturedCalls.length, 3);
      assert.ok(capturedCalls[0].url.includes('chat.startStream'));
      assert.equal(capturedCalls[0].body.task_display_mode, 'plan');

      assert.ok(capturedCalls[1].url.includes('chat.appendStream'));
      assert.equal(capturedCalls[1].body.chunks[0].id, 'task_1');

      assert.ok(capturedCalls[2].url.includes('chat.stopStream'));
      assert.equal(capturedCalls[2].body.markdown_text, 'All done.');
      assert.equal(capturedCalls[2].body.session_status, 'active');
    });

    it('searchAssistantContext calls assistant.search.context and returns results', async () => {
      const res = await client.searchAssistantContext({ query: 'meeting notes' });
      assert.equal(res.ok, true);
      assert.equal(res.results.messages.length, 1);
      assert.equal(res.results.messages[0].text, 'Important meeting notes');
    });

    it('canvases.create and canvases.edit interact with Slack canvas APIs', async () => {
      const createRes = await client.createCanvas({
        title: 'Project Roadmap',
        markdown: '# Roadmap 2026'
      });
      assert.equal(createRes.ok, true);
      assert.equal(createRes.canvas_id, 'F123CANVAS');

      const editRes = await client.editCanvas({
        canvas_id: 'F123CANVAS',
        changes: [{ operation: 'replace', document_content: { type: 'markdown', markdown: '# Updated' } }]
      });
      assert.equal(editRes.ok, true);
    });
  });

  describe('2. SlackStatusReporter Plan Mode Streaming vs Fallback', () => {
    it('uses chat stream plan mode when startStream succeeds', async () => {
      const streamChunks: any[] = [];
      let stopStreamArgs: any = null;

      const mockSlack: any = {
        startStream: async () => ({ ok: true, ts: 'stream.001' }),
        appendStream: async (args: any) => {
          streamChunks.push(...args.chunks);
          return { ok: true };
        },
        stopStream: async (args: any) => {
          stopStreamArgs = args;
          return { ok: true };
        }
      };

      const reporter = new SlackStatusReporter(mockSlack, 'C123', 'thread.001', 0);
      const initialized = await reporter.initStream();
      assert.equal(initialized, true);
      assert.equal(reporter.isStreaming(), true);

      reporter.step('calendar_list');
      reporter.step('gmail_draft');
      const finished = await reporter.finish('Here is your daily plan.', 'active');

      assert.equal(finished, true);
      assert.equal(stopStreamArgs.ts, 'stream.001');
      assert.equal(stopStreamArgs.markdown_text, 'Here is your daily plan.');
      assert.equal(stopStreamArgs.session_status, 'active');
      assert.ok(streamChunks.some(c => c.text?.includes('calendar')));
      assert.ok(streamChunks.some(c => c.status === 'complete'));
    });

    it('falls back to chat.update when streaming is unavailable', async () => {
      let postedText = '';
      let updatedText = '';

      const mockSlack: any = {
        startStream: async () => ({ ok: false, error: 'not_allowed' }),
        postMessage: async (args: any) => {
          postedText = args.text;
          return { ok: true, ts: 'msg.001' };
        },
        updateMessage: async (args: any) => {
          updatedText = args.text;
          return { ok: true, ts: args.ts };
        }
      };

      const reporter = new SlackStatusReporter(mockSlack, 'C123', 'thread.001', 0);
      const initialized = await reporter.initStream();
      assert.equal(initialized, false);
      assert.equal(reporter.isStreaming(), false);

      reporter.step('web_search');
      // allow synchronous queue flush
      await new Promise(r => setTimeout(r, 60));
      assert.ok(postedText.includes('web_search') || postedText.includes('Searching'));

      const finished = await reporter.finish('Here are the results.', 'active');
      assert.equal(finished, true);
      assert.equal(updatedText, 'Here are the results.');
    });
  });

  describe('3. SlackCoworkerService Agent Lifecycle & Context Handling', () => {
    let mockSlack: any;
    let mockLedger: any;
    let mockRunner: any;
    let coworkerService: SlackCoworkerService;

    beforeEach(() => {
      mockSlack = {
        isConfigured: () => true,
        setSessionStatus: async () => ({ ok: true }),
        renameSession: async () => ({ ok: true }),
        setSuggestedPrompts: async () => ({ ok: true }),
        postMessage: async () => ({ ok: true, ts: 'post.001' }),
        addReaction: async () => ({ ok: true }),
        removeReaction: async () => ({ ok: true }),
        getConversationReplies: async () => []
      };
      mockLedger = {
        listStagedByRun: () => [],
        getLatestStagedByThreadTs: () => null
      };
      mockRunner = {
        run: async () => ({
          status: 'SUCCESS',
          output: {
            deliveryMode: 'SLACK_MESSAGE',
            slackMessage: 'Done!'
          }
        })
      };

      coworkerService = new SlackCoworkerService(
        mockSlack,
        mockLedger,
        mockRunner as any
      );
    });

    it('handleSessionStopped aborts active runs and resets status to active', async () => {
      let statusSet: string | null = null;
      let postedMsg: string | null = null;

      mockSlack.setSessionStatus = async (args: any) => {
        statusSet = args.status;
        return { ok: true };
      };
      mockSlack.postMessage = async (args: any) => {
        postedMsg = args.text;
        return { ok: true };
      };

      await coworkerService.handleSessionStopped({
        channel: 'C123',
        thread_ts: 'thread.001'
      });

      assert.equal(statusSet, 'active');
      assert.equal(postedMsg, '⏹️ Stopped.');
    });

    it('handleAppHomeOpened provides contextual suggested prompts', async () => {
      let setPrompts: any = null;
      mockSlack.setSuggestedPrompts = async (args: any) => {
        setPrompts = args.prompts;
        return { ok: true };
      };

      await coworkerService.handleAppHomeOpened({
        user: 'U_OWNER',
        channel: 'D_DIRECT',
        tab: 'messages'
      });

      assert.ok(Array.isArray(setPrompts));
      assert.ok(setPrompts.length >= 3);
      assert.ok(setPrompts[0].title);
      assert.ok(setPrompts[0].message);
    });

    it('handleAppContextChanged tracks user view context and injects into userParts', async () => {
      coworkerService.handleAppContextChanged({
        user: 'U_OWNER',
        context: {
          channel_id: 'C_DEV_CHANNEL',
          thread_ts: 'thread.999'
        }
      });

      const tracked = coworkerService.getActiveContext('U_OWNER');
      assert.equal(tracked.channel_id, 'C_DEV_CHANNEL');
      assert.equal(tracked.thread_ts, 'thread.999');

      let interceptedUserParts: any[] = [];
      mockRunner.run = async (opts: any) => {
        interceptedUserParts = opts.userParts;
        return {
          status: 'SUCCESS',
          output: {
            deliveryMode: 'SLACK_MESSAGE',
            slackMessage: 'Got context'
          }
        };
      };

      await coworkerService.handleUserMessage({
        type: 'message',
        user: 'U_OWNER',
        text: 'Summarize what people are talking about in this channel',
        ts: '1700000000.500',
        channel: 'D_DIRECT'
      });

      const contextPart = interceptedUserParts.find(p => typeof p.text === 'string' && p.text.includes('User Active Slack View Context'));
      assert.ok(contextPart, 'Should contain active Slack view context in userParts');
      assert.ok(contextPart.text.includes('C_DEV_CHANNEL'));
    });
  });

  describe('4. Tool Grants & Workspace Tools', () => {
    it('resolveInteractiveSlackGrant grants SLACK_WORKSPACE_TOOL_NAMES on relevant query', () => {
      const grant = resolveInteractiveSlackGrant({
        userText: 'Search Slack channels for the deployment notes and canvas',
        allAvailableTools: Array.from(SLACK_WORKSPACE_TOOL_NAMES)
      });

      assert.ok(grant.has('slack_search'));
      assert.ok(grant.has('slack_read_channel'));
      assert.ok(grant.has('slack_canvas_create'));
    });

    it('createSlackTools registers and executes Slack workspace tools with proper effect classes', async () => {
      const fakeSlackClient: any = {
        isConfigured: () => true,
        searchAssistantContext: async (opts: any) => ({
          ok: true,
          results: {
            messages: [{ channel_id: 'C123', user: 'U1', text: 'match', permalink: '', ts: '100' }]
          }
        }),
        getConversationHistory: async (ch: string, limit: number) => [{ ts: '100', text: 'msg' }],
        getConversationReplies: async (ch: string, th: string) => [{ ts: '100', text: 'reply' }],
        createCanvas: async (p: any) => ({ ok: true, canvas_id: 'C_NEW' }),
        editCanvas: async (p: any) => ({ ok: true }),
        postMessage: async (p: any) => ({ ok: true, ts: 'msg.staged' })
      };

      const tools = createSlackTools(fakeSlackClient);
      const toolMap = new Map(tools.map(t => [t.name, t]));

      assert.equal(toolMap.get('slack_search')?.effectClass, 'READ');
      assert.equal(toolMap.get('slack_read_channel')?.effectClass, 'READ');
      assert.equal(toolMap.get('slack_read_thread')?.effectClass, 'READ');
      assert.equal(toolMap.get('slack_canvas_create')?.effectClass, 'INTERNAL_REVERSIBLE_WRITE');
      assert.equal(toolMap.get('slack_canvas_update')?.effectClass, 'INTERNAL_REVERSIBLE_WRITE');
      assert.equal(toolMap.get('slack_post_message')?.effectClass, 'CONSEQUENTIAL');

      // Verify execution
      const searchRes: any = await toolMap.get('slack_search')?.execute({ query: 'test' }, {} as any);
      assert.equal(searchRes.count, 1);

      const canvasRes: any = await toolMap.get('slack_canvas_create')?.execute({ title: 'Briefing', markdown: '# Notes' }, {} as any);
      assert.equal(canvasRes.ok, true);
      assert.equal(canvasRes.canvas_id, 'C_NEW');

      const postTool = toolMap.get('slack_post_message')!;
      const postRes: any = await postTool.execute({ channel: 'C123', text: 'Hello team' }, {} as any);
      assert.equal(postRes.ok, true);
      assert.equal(postRes.ts, 'msg.staged');

      // Verify read-back verification hook
      const verifyRes = await postTool.verify?.({ channel: 'C123', text: 'Hello team' }, { ts: '100' });
      assert.equal(verifyRes?.outcome, 'VERIFIED_SUCCESS');
    });
  });

  describe('5. Slack HTTP Event Router for Agent Events', () => {
    const ownerId = 'U_OWNER_ID';
    const signingSecret = 'router-test-secret';

    let dispatchedStopped: any = null;
    let dispatchedHome: any = null;
    let dispatchedContext: any = null;

    const mockCoworker: any = {
      handleSessionStopped: async (ev: any) => { dispatchedStopped = ev; },
      handleAppHomeOpened: async (ev: any) => { dispatchedHome = ev; },
      handleAppContextChanged: (ev: any) => { dispatchedContext = ev; },
      handleUserMessage: async () => {}
    };

    beforeEach(() => {
      process.env.SLACK_OWNER_USER_ID = ownerId;
      process.env.SLACK_SIGNING_SECRET = signingSecret;
      dispatchedStopped = null;
      dispatchedHome = null;
      dispatchedContext = null;
    });

    function makeSignedReq(body: any, timestamp = Math.floor(Date.now() / 1000).toString()) {
      const rawBody = JSON.stringify(body);
      const hmac = crypto.createHmac('sha256', signingSecret);
      hmac.update(`v0:${timestamp}:${rawBody}`);
      const signature = `v0=${hmac.digest('hex')}`;
      let statusCode = 200;
      let sentData: any = null;

      const req: any = {
        headers: {
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature
        },
        body,
        rawBody
      };

      const res: any = {
        status: (code: number) => {
          statusCode = code;
          return res;
        },
        send: (d: any) => { sentData = d; },
        json: (d: any) => { sentData = d; }
      };

      return { req, res, getStatus: () => statusCode, getData: () => sentData };
    }

    it('routes agent_session_stopped from owner to coworkerService', async () => {
      const router = createSlackRouter(mockCoworker);
      const handle = (router as any).stack.find((s: any) => s.route?.path === '/events')?.route?.stack[0]?.handle;

      const body = {
        event_id: 'ev_stop_1',
        event: {
          type: 'agent_session_stopped',
          channel: 'C_SESSION',
          thread_ts: '1700000000.999',
          user: ownerId
        }
      };

      const { req, res, getStatus } = makeSignedReq(body);
      await handle(req, res);

      assert.equal(getStatus(), 200);
      assert.ok(dispatchedStopped);
      assert.equal(dispatchedStopped.channel, 'C_SESSION');
      assert.equal(dispatchedStopped.thread_ts, '1700000000.999');
      assert.equal(dispatchedStopped.user, ownerId);
    });

    it('routes app_context_changed from owner to coworkerService', async () => {
      const router = createSlackRouter(mockCoworker);
      const handle = (router as any).stack.find((s: any) => s.route?.path === '/events')?.route?.stack[0]?.handle;

      const body = {
        event_id: 'ev_ctx_1',
        event: {
          type: 'app_context_changed',
          user: ownerId,
          context: {
            channel_id: 'C_VIEWING_CHANNEL'
          }
        }
      };

      const { req, res, getStatus } = makeSignedReq(body);
      await handle(req, res);

      assert.equal(getStatus(), 200);
      assert.ok(dispatchedContext);
      assert.equal(dispatchedContext.user, ownerId);
      assert.equal(dispatchedContext.context.channel_id, 'C_VIEWING_CHANNEL');
    });

    it('fails closed and ignores agent events from non-owner', async () => {
      const router = createSlackRouter(mockCoworker);
      const handle = (router as any).stack.find((s: any) => s.route?.path === '/events')?.route?.stack[0]?.handle;

      const body = {
        event_id: 'ev_stop_attacker',
        event: {
          type: 'agent_session_stopped',
          channel: 'C_SESSION',
          thread_ts: '1700000000.999',
          user: 'U_ATTACKER'
        }
      };

      const { req, res, getStatus } = makeSignedReq(body);
      await handle(req, res);

      assert.equal(getStatus(), 200);
      assert.equal(dispatchedStopped, null, 'Must ignore non-owner event');
    });
  });
});
