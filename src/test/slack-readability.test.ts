import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toSlackMrkdwn } from '../integrations/slack/format.js';
import { nowLine, zonedDayRange, zonedMidnight } from '../config/time.js';
import { compactEvent, compactThread, threadSummary } from '../integrations/google/compact.js';
import { createGoogleTools } from '../tools/google-tools.js';
import { SlackClient } from '../integrations/slack/client.js';

describe('Slack formatting', () => {
  it('turns the Markdown models write into Slack mrkdwn (the calendar reply as seen live)', () => {
    const md = '• **10:00 – 11:00** — **Online kuratorium**\n- **13:30** — [Meet](https://meet.google.com/x)\n## Notes\n~~old~~';
    assert.equal(
      toSlackMrkdwn(md),
      '• *10:00 – 11:00* — *Online kuratorium*\n• *13:30* — <https://meet.google.com/x|Meet>\n*Notes*\n~old~'
    );
  });

  it('leaves Slack-native text and code alone', () => {
    const native = '*Done* _now_ <https://x.io|link>\n```\n**not bold** [a](https://b.c)\n```\n`**x**`';
    assert.equal(toSlackMrkdwn(native), native);
  });

  it('is applied to every posted and updated message', async () => {
    const sent: any[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: any, init: any) => {
      sent.push(JSON.parse(init.body));
      return { json: async () => ({ ok: true, ts: '1' }) };
    }) as any;
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    try {
      const client = new SlackClient();
      await client.postMessage({ channel: 'C1', text: '**hi**' });
      await client.updateMessage({ channel: 'C1', ts: '1', text: '**bye**' });
    } finally {
      globalThis.fetch = original;
    }
    assert.deepEqual(sent.map(b => b.text), ['*hi*', '*bye*']);
  });
});

describe('Run clock', () => {
  it('tells the model the local date, time and tomorrow', () => {
    const line = nowLine(new Date('2026-10-14T18:54:00Z'), 'Europe/Warsaw');
    assert.match(line, /Wednesday, 14 October 2026 at 20:54/);
    assert.match(line, /2026-10-14, Europe\/Warsaw, UTC\+02:00/);
    assert.match(line, /Tomorrow is 2026-10-15/);
  });

  it('computes local day ranges across DST', () => {
    assert.equal(zonedMidnight('2026-10-15', 'Europe/Warsaw').toISOString(), '2026-10-14T22:00:00.000Z');
    assert.deepEqual(zonedDayRange('2026-10-25', 1, 'Europe/Warsaw'), {
      timeMin: '2026-10-24T22:00:00.000Z',
      timeMax: '2026-10-25T23:00:00.000Z'
    });
  });
});

const RAW_EVENT = {
  kind: 'calendar#event', etag: '"1"', id: 'ev1', status: 'confirmed', iCalUID: 'x@google.com',
  htmlLink: 'https://www.google.com/calendar/event?eid=abc',
  summary: 'Bolt - Recruiter Interview',
  description: '<p>Hi <span>Alex</span>,<br />See <a href="https://bolt.eu/job">Job Posting</a></p>',
  organizer: { email: 'mariana@bolt.eu' },
  start: { dateTime: '2026-10-15T14:00:00+02:00', timeZone: 'Europe/Tallinn' },
  end: { dateTime: '2026-10-15T14:30:00+02:00', timeZone: 'Europe/Tallinn' },
  attendees: [{ email: 'me@x.com', self: true, responseStatus: 'accepted' }],
  hangoutLink: 'https://meet.google.com/xbg',
  conferenceData: { entryPoints: [{ uri: 'tel:+372' }] },
  reminders: { useDefault: true }
};

describe('Compact Google results', () => {
  it('keeps what a reader needs from a calendar event', () => {
    assert.deepEqual(compactEvent(RAW_EVENT), {
      id: 'ev1',
      title: 'Bolt - Recruiter Interview',
      start: '2026-10-15T14:00:00+02:00',
      end: '2026-10-15T14:30:00+02:00',
      meetLink: 'https://meet.google.com/xbg',
      organizer: 'mariana@bolt.eu',
      myResponse: 'accepted',
      description: 'Hi Alex,\nSee Job Posting (https://bolt.eu/job)',
      link: 'https://www.google.com/calendar/event?eid=abc'
    });
  });

  it('calendar_list with a date asks Google for that local day and stays under the Result Store threshold', async () => {
    let asked: any[] = [];
    const google: any = {
      isConnected: () => true,
      listCalendarEvents: async (...args: any[]) => { asked = args; return [RAW_EVENT, RAW_EVENT, RAW_EVENT]; }
    };
    const tool = createGoogleTools(google).find(t => t.name === 'calendar_list')!;
    const result: any = await tool.execute(tool.schema.parse({ date: '2026-10-15' }), {} as any);
    assert.deepEqual(asked, ['2026-10-14T22:00:00.000Z', '2026-10-15T22:00:00.000Z', 25]);
    assert.equal(result.count, 3);
    assert.ok(JSON.stringify(result).length < 1800, `compact result is ${JSON.stringify(result).length} chars`);
  });

  it('decodes Gmail bodies instead of returning base64 payloads', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    const thread = compactThread({
      id: 't1',
      messages: [{
        id: 'm1', labelIds: ['UNREAD'], snippet: 'Hello',
        payload: {
          headers: [{ name: 'From', value: 'A <a@x.com>' }, { name: 'To', value: 'me@x.com' }, { name: 'Subject', value: 'Hi' }, { name: 'Date', value: 'Wed' }],
          parts: [
            { mimeType: 'text/plain', body: { data: b64('Hello there\r\nBest') } },
            { mimeType: 'text/html', body: { data: b64('<p>Hello there</p>') } },
            { mimeType: 'application/pdf', filename: 'cv.pdf', body: { attachmentId: 'att1' } }
          ]
        }
      }]
    });
    assert.deepEqual(thread.messages[0], {
      id: 'm1', from: 'A <a@x.com>', to: 'me@x.com', date: 'Wed', subject: 'Hi', unread: true,
      body: 'Hello there\nBest', attachments: ['cv.pdf']
    });
    assert.equal(threadSummary({ id: 't1', messages: [{ snippet: 'Hello', payload: { headers: [{ name: 'Subject', value: 'Hi' }] } }] }).subject, 'Hi');
  });
});

describe('Any tool, any integration (class-level guards)', () => {
  const ctx = (name: string) => ({ runId: 'run_x', isInteractive: true, toolGrant: { allowedToolNames: new Set([name, 'result_read']), allowConsequential: false } });

  it('slims every READ result: envelope keys, nulls, base64 and HTML go; meaning stays', async () => {
    const { ToolDispatcher } = await import('../governance/dispatcher.js');
    const { z } = await import('zod');
    const dispatcher = new ToolDispatcher();
    dispatcher.registerTool({
      name: 'some_future_api', description: 'x', effectClass: 'READ', schema: z.object({}),
      execute: async () => ({
        kind: 'api#item', etag: '"9"', title: 'Kept', note: null, reminders: [], count: 0,
        blob: Buffer.from('%PDF-1.7 binary attachment '.repeat(12)).toString('base64'),
        plain: 'x'.repeat(300),
        body: `<p>Hello <a href="https://x.io">there</a></p>${'<br>'.repeat(60)}<div>end</div>`
      })
    });
    const result: any = await dispatcher.dispatch('some_future_api', {}, ctx('some_future_api') as any);
    assert.deepEqual(result, {
      title: 'Kept', reminders: [], count: 0,
      blob: '[binary data, 432 chars omitted]',
      plain: 'x'.repeat(300),
      body: 'Hello there (https://x.io)\n\nend'
    });
  });

  it('never stores what result_read returns (no handles pointing at handles)', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { initializeAppDatabase } = await import('../storage/schema.js');
    const { ResultStore, RESULT_STORE_THRESHOLD } = await import('../storage/result-store.js');
    const { ToolDispatcher } = await import('../governance/dispatcher.js');
    const { createResultReadTool } = await import('../tools/result-tools.js');
    const db = new DatabaseSync(':memory:');
    initializeAppDatabase(db);
    const store = new ResultStore(db);
    const dispatcher = new ToolDispatcher(undefined, store);
    dispatcher.registerTool(createResultReadTool(store));
    const stored = store.intercept('run_x', 'big', 'line\n'.repeat(RESULT_STORE_THRESHOLD));
    const read: any = await dispatcher.dispatch('result_read', { handle: stored.handle, maxChars: 10000 }, ctx('x') as any);
    assert.equal(read.isStored, undefined);
    assert.equal(read.slice.length, 10000);
  });

  it('formats model text inside card blocks too', async () => {
    const sent: any[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_u: any, init: any) => { sent.push(JSON.parse(init.body)); return { json: async () => ({ ok: true }) }; }) as any;
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    try {
      await new SlackClient().postMessage({ channel: 'C1', text: 'card', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '**Subject:** Hi' } }] });
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(sent[0].blocks[0].text.text, '*Subject:* Hi');
  });
});
