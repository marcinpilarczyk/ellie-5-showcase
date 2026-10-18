import { z } from 'zod';
import { ToolDefinition } from '../types/tool.js';
import { SlackClient } from '../integrations/slack/client.js';

export function createSlackTools(slackClient: SlackClient): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // 1. slack_search
  tools.push({
    name: 'slack_search',
    description: 'Searches the Slack workspace across messages, files, and channels using semantic search. Use to find prior discussions, decisions, documents, and shared links.',
    effectClass: 'READ',
    isAvailable: () => slackClient.isConfigured(),
    schema: z.object({
      query: z.string().describe('Search query (phrasing as a natural question triggers semantic search)'),
      limit: z.number().int().positive().optional().default(10).describe('Max results (max 20)'),
      content_types: z.array(z.enum(['messages', 'files', 'channels'])).optional().describe('Content types to search')
    }),
    execute: async (params, context) => {
      const res = await slackClient.searchAssistantContext({
        query: params.query,
        limit: params.limit,
        content_types: params.content_types
      });
      if (!res.ok) {
        return { error: res.error || 'Slack search failed' };
      }
      const messages = res.results?.messages || [];
      const files = res.results?.files || [];
      const channels = res.results?.channels || [];
      return {
        query: params.query,
        count: messages.length + files.length + channels.length,
        messages: messages.slice(0, params.limit || 10).map((m: any) => ({
          channel: m.channel_id,
          user: m.user,
          text: m.content || m.text,
          permalink: m.permalink,
          ts: m.message_ts || m.ts
        })),
        files: files.slice(0, 5).map((f: any) => ({
          name: f.name,
          title: f.title,
          filetype: f.filetype,
          permalink: f.permalink
        })),
        channels: channels.slice(0, 5).map((c: any) => ({
          id: c.id,
          name: c.name
        }))
      };
    }
  });

  // 2. slack_read_channel
  tools.push({
    name: 'slack_read_channel',
    description: 'Reads recent messages from a public or private Slack channel by channel ID (e.g., C012345).',
    effectClass: 'READ',
    isAvailable: () => slackClient.isConfigured(),
    schema: z.object({
      channel: z.string().describe('The channel ID to read'),
      limit: z.number().int().positive().optional().default(20).describe('Number of messages to retrieve (max 50)')
    }),
    execute: async (params) => {
      const messages = await slackClient.getConversationHistory(params.channel, Math.min(params.limit || 20, 50));
      return {
        channel: params.channel,
        count: messages.length,
        messages: messages.map((m: any) => ({
          user: m.user || m.bot_id,
          text: m.text,
          ts: m.ts,
          reply_count: m.reply_count,
          has_files: Boolean(m.files?.length)
        }))
      };
    }
  });

  // 3. slack_read_thread
  tools.push({
    name: 'slack_read_thread',
    description: 'Reads all replies in a specific Slack thread by channel and thread timestamp (thread_ts).',
    effectClass: 'READ',
    isAvailable: () => slackClient.isConfigured(),
    schema: z.object({
      channel: z.string().describe('The channel ID'),
      thread_ts: z.string().describe('The thread root timestamp (thread_ts)'),
      limit: z.number().int().positive().optional().default(30).describe('Max replies to fetch')
    }),
    execute: async (params) => {
      const messages = await slackClient.getConversationReplies(params.channel, params.thread_ts, params.limit || 30);
      return {
        channel: params.channel,
        thread_ts: params.thread_ts,
        count: messages.length,
        messages: messages.map((m: any) => ({
          user: m.user || m.bot_id,
          text: m.text,
          ts: m.ts
        }))
      };
    }
  });

  // 4. slack_canvas_create
  tools.push({
    name: 'slack_canvas_create',
    description: 'Creates a new Slack Canvas with Markdown content. Useful for briefings, research notes, and project overviews pinned inside Slack.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    isAvailable: () => slackClient.isConfigured(),
    schema: z.object({
      title: z.string().describe('Canvas title'),
      markdown: z.string().describe('Markdown formatted content for the canvas'),
      channel_id: z.string().optional().describe('Optional channel ID to bind this canvas to')
    }),
    ownerText: { kind: 'document', text: (p: any) => `${p.title}\n\n${p.markdown}`, field: 'markdown' },
    execute: async (params) => {
      const res = await slackClient.createCanvas({
        title: params.title,
        markdown: params.markdown,
        channel_id: params.channel_id
      });
      if (!res.ok) {
        return { ok: false, error: res.error || 'Failed to create Slack Canvas' };
      }
      return {
        ok: true,
        canvas_id: res.canvas_id,
        title: params.title
      };
    }
  });

  // 5. slack_canvas_update
  tools.push({
    name: 'slack_canvas_update',
    description: 'Updates an existing Slack Canvas by replacing or appending Markdown content.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    isAvailable: () => slackClient.isConfigured(),
    schema: z.object({
      canvas_id: z.string().describe('The ID of the Canvas to edit'),
      markdown: z.string().describe('The Markdown content to apply'),
      operation: z.enum(['replace', 'insert_at_end']).optional().default('replace').describe('Whether to replace existing content or append to the end')
    }),
    ownerText: { kind: 'document', text: (p: any) => p.markdown, field: 'markdown' },
    execute: async (params) => {
      const res = await slackClient.editCanvas({
        canvas_id: params.canvas_id,
        changes: [
          {
            operation: params.operation || 'replace',
            document_content: {
              type: 'markdown',
              markdown: params.markdown
            }
          }
        ]
      });
      if (!res.ok) {
        return { ok: false, error: res.error || 'Failed to update Slack Canvas' };
      }
      return {
        ok: true,
        canvas_id: params.canvas_id,
        operation: params.operation
      };
    }
  });

  // 6. slack_post_message (CONSEQUENTIAL)
  tools.push({
    name: 'slack_post_message',
    description: 'Posts a message to a public or private Slack channel or thread. Consequential: staged for owner approval before sending.',
    effectClass: 'CONSEQUENTIAL',
    isAvailable: () => slackClient.isConfigured(),
    schema: z.object({
      channel: z.string().describe('Target channel ID'),
      text: z.string().describe('Message text (supports Slack mrkdwn)'),
      thread_ts: z.string().optional().describe('Optional thread_ts to post as a reply')
    }),
    ownerText: { kind: 'message', text: (p: any) => p.text, field: 'text' },
    execute: async (params) => {
      const res = await slackClient.postMessage({
        channel: params.channel,
        text: params.text,
        thread_ts: params.thread_ts
      });
      if (!res.ok) {
        throw new Error(res.error || 'Failed to post message to Slack channel');
      }
      return {
        ok: true,
        channel: params.channel,
        ts: res.ts,
        thread_ts: params.thread_ts
      };
    },
    verify: async (params, lastKnownResult) => {
      const ts = lastKnownResult?.ts;
      if (!ts) {
        return { outcome: 'FAILED_SAFE', details: 'No message timestamp returned to verify.' };
      }
      const history = await slackClient.getConversationHistory(params.channel, 5);
      const found = history.some(m => m.ts === ts);
      if (found) {
        return { outcome: 'VERIFIED_SUCCESS', details: `Message ${ts} confirmed in channel ${params.channel}` };
      }
      return { outcome: 'RECONCILIATION_REQUIRED', reconciliationNotes: `Message ${ts} was posted but not seen in read-back` };
    }
  });

  return tools;
}
