import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { sanitizeContents, UnifiedAgentRunner, isUserQuestionOrPing } from '../agent/runner.js';
import { buildStaticSystemPrompt } from '../agent/prefix-builder.js';
import { SlackCoworkerService, SlackEventPayload } from '../integrations/slack/coworker.js';
import { SlackClient } from '../integrations/slack/client.js';
import { createSlackRouter } from '../http/routes/slack.js';
import { ownerConfig, setOwnerConfig, ownerIntro } from '../config/owner.js';

describe('Slack Conversational Memory & Event Dedup Suite', () => {

  describe('1. sanitizeContents Multi-turn Formatting', () => {
    it('drops orphan model turns from the start of conversation', () => {
      const raw: any[] = [
        { role: 'model', parts: [{ text: 'Hello' }] },
        { role: 'user', parts: [{ text: 'Hi' }] },
        { role: 'model', parts: [{ text: 'How can I help?' }] }
      ];
      const sanitized = sanitizeContents(raw);
      assert.equal(sanitized.length, 2);
      assert.equal(sanitized[0].role, 'user');
      assert.equal(sanitized[1].role, 'model');
    });

    it('merges consecutive turns of the same role into a single turn', () => {
      const raw: any[] = [
        { role: 'user', parts: [{ text: 'Part 1' }] },
        { role: 'user', parts: [{ text: 'Part 2' }] },
        { role: 'model', parts: [{ text: 'Reply 1' }] },
        { role: 'model', parts: [{ text: 'Reply 2' }] },
        { role: 'user', parts: [{ text: 'Follow up' }] }
      ];
      const sanitized = sanitizeContents(raw);
      assert.equal(sanitized.length, 3);
      assert.equal(sanitized[0].role, 'user');
      assert.equal(sanitized[0].parts.length, 2);
      assert.equal(sanitized[1].role, 'model');
      assert.equal(sanitized[1].parts.length, 2);
      assert.equal(sanitized[2].role, 'user');
    });

    it('returns empty array when input contains no valid parts', () => {
      const raw: any[] = [
        { role: 'model', parts: [] }
      ];
      const sanitized = sanitizeContents(raw);
      assert.equal(sanitized.length, 0);
    });
  });

  describe('2. SlackCoworkerService Thread History & Image Attachments', () => {
    let mockSlackClient: any;
    let mockLedgerRepo: any;
    let mockRunner: any;
    let lastRunnerOpts: any;

    beforeEach(() => {
      lastRunnerOpts = null;
      mockSlackClient = {
        isConfigured: () => true,
        addReaction: async () => ({ ok: true }),
        removeReaction: async () => ({ ok: true }),
        postMessage: async () => ({ ok: true, ts: '999.001' }),
        getConversationReplies: async (channel: string, threadTs: string) => {
          return [
            { ts: '100.001', user: 'U0OWNERTEST', text: 'Should I apply? linkedin.com/jobs/view/1234567890' },
            { ts: '100.002', bot_id: 'B0TESTBOT000', text: 'Yes, absolutely—this is an exceptionally strong match for your profile at Example Technologies Group.' },
            { ts: '100.003', user: 'U0OWNERTEST', text: 'use our resume framework' }
          ];
        },
        downloadFile: async (url: string) => {
          return {
            buffer: Buffer.from('fake-image-bytes'),
            mimeType: 'image/png'
          };
        }
      };

      mockLedgerRepo = {
        getLatestStagedByThreadTs: () => null,
        listStaged: () => [],
        listStagedByRun: () => []
      };

      mockRunner = {
        dispatcher: {
          getAllTools: () => [],
          getTool: () => null
        },
        run: async (opts: any) => {
          lastRunnerOpts = opts;
          return {
            runId: 'test_run',
            status: 'COMPLETED',
            output: {
              deliveryMode: 'SLACK_MESSAGE',
              coworkerHeadline: 'Tailored resume draft ready.',
              summary: 'Tailored resume draft ready.'
            },
            toolCallsExecuted: [],
            handlesCreated: [],
            telemetry: { promptTokens: 0, cachedTokens: 0, thinkingTokens: 0, candidatesTokens: 0, totalTokens: 0, model: 'test', durationMs: 0 }
          };
        }
      };
    });

    it('fetches thread history and passes conversationHistory to runner', async () => {
      const service = new SlackCoworkerService(
        mockSlackClient as unknown as SlackClient,
        mockLedgerRepo,
        mockRunner
      );

      const event: SlackEventPayload = {
        type: 'message',
        user: 'U0OWNERTEST',
        text: 'use our resume framework',
        ts: '100.003',
        thread_ts: '100.001',
        channel: 'C0TESTCHANNEL'
      };

      await service.handleUserMessage(event);

      assert.ok(lastRunnerOpts, 'Runner should have been invoked');
      assert.ok(lastRunnerOpts.conversationHistory, 'conversationHistory should be present');
      assert.equal(lastRunnerOpts.conversationHistory.length, 2, 'Should contain 2 prior turns (root user + bot reply)');
      assert.equal(lastRunnerOpts.conversationHistory[0].role, 'user');
      assert.equal(lastRunnerOpts.conversationHistory[0].parts[0].text, 'Should I apply? linkedin.com/jobs/view/1234567890');
      assert.equal(lastRunnerOpts.conversationHistory[1].role, 'model');
      assert.ok(lastRunnerOpts.conversationHistory[1].parts[0].text.includes('Example Technologies Group'));
    });

    it('downloads and passes image attachments as inlineData parts', async () => {
      const service = new SlackCoworkerService(
        mockSlackClient as unknown as SlackClient,
        mockLedgerRepo,
        mockRunner
      );

      const event: SlackEventPayload = {
        type: 'message',
        user: 'U0OWNERTEST',
        text: 'look at this DM screenshot',
        ts: '100.004',
        thread_ts: '100.001',
        channel: 'C0TESTCHANNEL',
        files: [
          {
            id: 'F123',
            name: 'colin_dm.png',
            mimetype: 'image/png',
            url_private_download: 'https://files.slack.com/colin_dm.png'
          }
        ]
      };

      await service.handleUserMessage(event);

      assert.ok(lastRunnerOpts, 'Runner should have been invoked');
      assert.ok(lastRunnerOpts.userParts, 'userParts should be populated');
      assert.equal(lastRunnerOpts.userParts.length, 2, 'Should contain text part and image part');
      assert.equal(lastRunnerOpts.userParts[0].text, 'look at this DM screenshot');
      assert.ok(lastRunnerOpts.userParts[1].inlineData, 'Image part should contain inlineData');
      assert.equal(lastRunnerOpts.userParts[1].inlineData.mimeType, 'image/png');
      assert.equal(lastRunnerOpts.userParts[1].inlineData.data, Buffer.from('fake-image-bytes').toString('base64'));
    });

    it('downloads, extracts and passes non-image XLSX attachments in userParts', async () => {
      const zip = new JSZip();
      zip.file(
        'xl/workbook.xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Pipeline" sheetId="1" r:id="rId1"/></sheets></workbook>'
      );
      zip.file(
        'xl/_rels/workbook.xml.rels',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'
      );
      zip.file(
        'xl/sharedStrings.xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst><si><t>Company</t></si><si><t>Acme Corp</t></si></sst>'
      );
      zip.file(
        'xl/worksheets/sheet1.xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>MRR</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>5000</v></c></row></sheetData></worksheet>'
      );
      const xlsxBuffer = await zip.generateAsync({ type: 'nodebuffer' });

      mockSlackClient.downloadFile = async (url: string) => {
        if (url.includes('pipeline.xlsx')) {
          return { buffer: xlsxBuffer, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
        }
        return null;
      };

      const service = new SlackCoworkerService(
        mockSlackClient as unknown as SlackClient,
        mockLedgerRepo,
        mockRunner
      );

      const event: SlackEventPayload = {
        type: 'message',
        user: 'U0OWNERTEST',
        text: 'review the latest pipeline sheet',
        ts: '100.005',
        channel: 'C0TESTCHANNEL',
        files: [
          {
            id: 'F_XLSX_1',
            name: 'pipeline.xlsx',
            mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            url_private_download: 'https://files.slack.com/pipeline.xlsx'
          }
        ]
      };

      await service.handleUserMessage(event);

      assert.ok(lastRunnerOpts, 'Runner should have been invoked');
      assert.ok(lastRunnerOpts.userParts, 'userParts should be populated');
      assert.equal(lastRunnerOpts.userParts.length, 2, 'Should contain user text part and extracted file part');
      assert.equal(lastRunnerOpts.userParts[0].text, 'review the latest pipeline sheet');
      const filePart = lastRunnerOpts.userParts[1];
      assert.ok(filePart.text, 'File part should contain extracted text');
      assert.ok(filePart.text.includes('[Attached Spreadsheet: pipeline.xlsx'));
      assert.ok(filePart.text.includes('### Sheet: "Pipeline"'));
      assert.ok(filePart.text.includes('Company'));
      assert.ok(filePart.text.includes('Acme Corp'));
      assert.ok(filePart.text.includes('5000'));
    });
  });

  describe('3. Slack Event Deduplication Route', () => {
    it('drops duplicate event within 5 minutes for identical client_msg_id', async () => {
      let handleCallCount = 0;
      const mockCoworkerService: any = {
        handleUserMessage: async () => {
          handleCallCount++;
        }
      };

      const secret = 'test-secret';
      process.env.SLACK_SIGNING_SECRET = secret;
      process.env.SLACK_OWNER_USER_ID = process.env.SLACK_OWNER_USER_ID || 'U0OWNERTEST';
      const router = createSlackRouter(mockCoworkerService);

      const routeLayer = (router as any).stack.find((s: any) => s.route?.path === '/events');
      assert.ok(routeLayer, 'Events route must exist');
      const handler = routeLayer.route.stack[0].handle;

      const eventBody1 = {
        type: 'event_callback',
        event_id: 'Ev12345',
        event: {
          type: 'message',
          user: process.env.SLACK_OWNER_USER_ID || 'U0OWNERTEST',
          text: '@Ellie Should I apply?',
          ts: '1791933382.630579',
          client_msg_id: 'client-uuid-1111',
          channel: 'C0TESTCHANNEL'
        }
      };

      const ts1 = String(Math.floor(Date.now() / 1000));
      const rawBody1 = JSON.stringify(eventBody1);
      const hmac1 = (await import('node:crypto')).createHmac('sha256', secret);
      hmac1.update(`v0:${ts1}:${rawBody1}`);
      const sig1 = `v0=${hmac1.digest('hex')}`;

      const fakeReq1: any = {
        headers: {
          'x-slack-request-timestamp': ts1,
          'x-slack-signature': sig1
        },
        body: eventBody1,
        rawBody: rawBody1
      };
      const fakeRes1: any = {
        status: () => fakeRes1,
        send: () => fakeRes1,
        json: () => fakeRes1
      };

      // Call 1 (message event)
      await handler(fakeReq1, fakeRes1);
      assert.equal(handleCallCount, 1, 'First event should be processed');

      // Call 2 (app_mention event with identical client_msg_id)
      const eventBody2 = {
        ...eventBody1,
        event: {
          ...eventBody1.event,
          type: 'app_mention'
        }
      };
      const ts2 = String(Math.floor(Date.now() / 1000));
      const rawBody2 = JSON.stringify(eventBody2);
      const hmac2 = (await import('node:crypto')).createHmac('sha256', secret);
      hmac2.update(`v0:${ts2}:${rawBody2}`);
      const sig2 = `v0=${hmac2.digest('hex')}`;

      const fakeReq2: any = {
        headers: {
          'x-slack-request-timestamp': ts2,
          'x-slack-signature': sig2
        },
        body: eventBody2,
        rawBody: rawBody2
      };
      const fakeRes2: any = {
        status: () => fakeRes2,
        send: () => fakeRes2,
        json: () => fakeRes2
      };

      await handler(fakeReq2, fakeRes2);
      assert.equal(handleCallCount, 1, 'Duplicate event must be ignored without second invocation');
    });
  });

  describe('4. Owner Intro & Verified Professional Record Grounding', () => {
    it('surfaces verified professional record and target roles in ownerIntro', () => {
      setOwnerConfig({
        about: 'B2B SaaS leader in Poland.',
        targetRoles: ['Implementation Director', 'Head of Customer Operations'],
        dealBreakers: ['No relocation outside Poland'],
        searchPhilosophy: 'High autonomy executive roles',
        professionalRecord: 'Led Google Cloud Marketplace Onboarding ($100M+ ARR); Senior Manager at Marqeta.'
      });

      const intro = ownerIntro();
      assert.ok(intro.includes('B2B SaaS leader in Poland.'));
      assert.ok(intro.includes('Target Roles: Implementation Director, Head of Customer Operations'));
      assert.ok(intro.includes('Deal Breakers: No relocation outside Poland'));
      assert.ok(intro.includes('VERIFIED PROFESSIONAL RECORD'));
      assert.ok(intro.includes('Google Cloud Marketplace Onboarding'));
      assert.ok(intro.includes('Marqeta'));
    });
  });

  describe('5. Conversational Responsiveness & Ghosting Prevention', () => {
    it('isUserQuestionOrPing correctly identifies conversational pings and questions', () => {
      assert.equal(isUserQuestionOrPing('?'), true);
      assert.equal(isUserQuestionOrPing('so?'), true);
      assert.equal(isUserQuestionOrPing('why are you not replying?'), true);
      assert.equal(isUserQuestionOrPing('what is the problem?'), true);
      assert.equal(isUserQuestionOrPing('status'), true);
      assert.equal(isUserQuestionOrPing('co jest?'), true);
      assert.equal(isUserQuestionOrPing('dlaczego milczysz?'), true);
      assert.equal(isUserQuestionOrPing('add this to sheet'), false);
      assert.equal(isUserQuestionOrPing('snooze routine morning'), false);
    });

    it('overrides SILENT and REACTION_ONLY to SLACK_MESSAGE when user asks a question', async () => {
      let postedMessage: any = null;
      const customSlackClient = {
        postMessage: async (msg: any) => {
          postedMessage = msg;
          return { ok: true, ts: '999.001' };
        },
        addReaction: async () => {},
        removeReaction: async () => {},
        getConversationReplies: async () => ({ messages: [] }),
        downloadFile: async () => null
      };

      const customRunner: any = {
        dispatcher: {
          getAllTools: () => [],
          getTool: () => null
        },
        run: async () => ({
          runId: 'question_run_1',
          status: 'COMPLETED',
          output: {
            deliveryMode: 'SILENT',
            summary: 'Investigated recent job posts.'
          },
          toolCallsExecuted: [
            { tool: 'web_search', params: {}, result: {}, durationMs: 50 }
          ],
          handlesCreated: [],
          telemetry: { promptTokens: 0, cachedTokens: 0, thinkingTokens: 0, candidatesTokens: 0, totalTokens: 0, model: 'test', durationMs: 0 }
        })
      };

      const mockLedgerRepo: any = {
        getLatestStagedByThreadTs: () => null,
        listStaged: () => [],
        listStagedByRun: () => []
      };

      const service = new SlackCoworkerService(
        customSlackClient as unknown as SlackClient,
        mockLedgerRepo,
        customRunner
      );

      const event: SlackEventPayload = {
        type: 'message',
        user: 'U0OWNERTEST',
        text: 'what is the problem?',
        ts: '100.005',
        channel: 'C0TESTCHANNEL'
      };

      await service.handleUserMessage(event);

      assert.ok(postedMessage, 'Must post a message to Slack even if runner returned SILENT');
      assert.ok(postedMessage.text.includes('Investigated') || postedMessage.text.includes('job posts'), 'Message text must be populated');
    });

    it('system prompt includes conversational responsiveness and drafting discipline', () => {
      const prompt = buildStaticSystemPrompt();
      assert.ok(prompt.includes('CONVERSATIONAL RESPONSIVENESS & ANSWERING QUESTIONS'));
      assert.ok(prompt.includes('STRICTLY FORBIDDEN'));
      assert.ok(prompt.includes('ARTIFACT CREATION & DRAFTING DISCIPLINE'));
      assert.ok(prompt.includes('docs_create'));
    });
  });

});

