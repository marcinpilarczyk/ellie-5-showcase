import { toSlackMrkdwn } from './format.js';

/** Converts mrkdwn text objects inside Block Kit blocks (cards carry model-written text too). */
function formatBlocks(blocks?: any[]): any[] | undefined {
  if (!blocks) return blocks;
  const walk = (node: any): any => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out: any = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v);
    if (out.type === 'mrkdwn' && typeof out.text === 'string') out.text = toSlackMrkdwn(out.text);
    return out;
  };
  return walk(blocks);
}

export interface PostMessageOptions {
  channel?: string;
  text: string;
  blocks?: any[];
  thread_ts?: string;
}

export interface SlackApiResponse {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
}

export class SlackClient {
  private readonly token?: string;
  public readonly defaultChannel: string;

  constructor(tokenOrOptions?: string | { botToken?: string; signingSecret?: string; defaultChannel?: string }, defaultChannel?: string) {
    if (typeof tokenOrOptions === 'object' && tokenOrOptions !== null) {
      this.token = tokenOrOptions.botToken || process.env.SLACK_BOT_TOKEN;
      this.defaultChannel = tokenOrOptions.defaultChannel || process.env.SLACK_CHANNEL_ID || '';
    } else {
      this.token = tokenOrOptions || process.env.SLACK_BOT_TOKEN;
      this.defaultChannel = defaultChannel || process.env.SLACK_CHANNEL_ID || '';
    }
  }

  public isConfigured(): boolean {
    return Boolean(this.token && this.token.startsWith('xoxb-'));
  }

  private async callApi(endpoint: string, payload: Record<string, any>): Promise<SlackApiResponse> {
    if (!this.token) {
      return { ok: false, error: 'SLACK_BOT_TOKEN is not configured' };
    }

    try {
      const res = await fetch(`https://slack.com/api/${endpoint}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json() as SlackApiResponse;
      return data;
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  public async postMessage(opts: PostMessageOptions): Promise<SlackApiResponse> {
    const channel = opts.channel || this.defaultChannel;
    return this.callApi('chat.postMessage', {
      channel,
      text: toSlackMrkdwn(opts.text),
      blocks: formatBlocks(opts.blocks),
      thread_ts: opts.thread_ts
    });
  }

  public async updateMessage(opts: { channel: string; ts: string; text: string; blocks?: any[] }): Promise<SlackApiResponse> {
    return this.callApi('chat.update', {
      channel: opts.channel,
      ts: opts.ts,
      text: toSlackMrkdwn(opts.text),
      blocks: formatBlocks(opts.blocks)
    });
  }

  public async addReaction(opts: { channel: string; timestamp: string; name: string }): Promise<SlackApiResponse> {
    return this.callApi('reactions.add', {
      channel: opts.channel,
      timestamp: opts.timestamp,
      name: opts.name
    });
  }

  public async removeReaction(opts: { channel: string; timestamp: string; name: string }): Promise<SlackApiResponse> {
    return this.callApi('reactions.remove', {
      channel: opts.channel,
      timestamp: opts.timestamp,
      name: opts.name
    });
  }

  public async getConversationReplies(channel: string, threadTs: string, limit = 50): Promise<Array<{ user?: string; bot_id?: string; text?: string; ts?: string; files?: any[] }>> {
    if (!this.token) return [];
    try {
      const res = await fetch(`https://slack.com/api/conversations.replies?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs)}&limit=${limit}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json; charset=utf-8'
        }
      });
      const data = await res.json() as any;
      if (!data.ok) {
        console.warn('[SlackClient] conversations.replies returned error:', data.error);
        return [];
      }
      return data.messages || [];
    } catch (err: any) {
      console.warn('[SlackClient] Exception fetching conversation replies:', err.message);
      return [];
    }
  }

  public async downloadFile(fileUrl: string, maxBytes = 20 * 1024 * 1024): Promise<{ buffer: Buffer; mimeType?: string } | null> {
    if (!this.token) {
      console.warn('[SlackClient] Cannot download file: token is not configured.');
      return null;
    }
    try {
      const res = await fetch(fileUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.token}`
        }
      });
      if (!res.ok) {
        console.error(`[SlackClient] File download failed with status ${res.status}: ${res.statusText}`);
        return null;
      }
      const arrayBuffer = await res.arrayBuffer();
      if (arrayBuffer.byteLength > maxBytes) {
        console.warn(`[SlackClient] File exceeds max size (${arrayBuffer.byteLength} > ${maxBytes})`);
        return null;
      }
      const buffer = Buffer.from(arrayBuffer);
      const mimeType = res.headers.get('content-type') || undefined;
      return { buffer, mimeType };
    } catch (err: any) {
      console.error('[SlackClient] Exception downloading file:', err.message);
      return null;
    }
  }

  public async uploadFile(opts: {
    buffer: Buffer;
    filename: string;
    title?: string;
    channel?: string;
    thread_ts?: string;
    initial_comment?: string;
  }): Promise<{ ok: boolean; file_id?: string; permalink?: string; error?: string }> {
    if (!this.token) {
      return { ok: false, error: 'SLACK_BOT_TOKEN is not configured' };
    }
    const channel = opts.channel || this.defaultChannel;
    if (!channel) {
      return { ok: false, error: 'No Slack channel specified or defaultChannel configured' };
    }

    try {
      // 1. Get pre-signed external upload URL
      const urlParams = new URLSearchParams({
        filename: opts.filename,
        length: opts.buffer.byteLength.toString()
      });
      const getUrlRes = await fetch(`https://slack.com/api/files.getUploadURLExternal?${urlParams.toString()}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.token}`
        }
      });
      const getUrlData = await getUrlRes.json() as any;
      if (!getUrlData.ok) {
        return { ok: false, error: `files.getUploadURLExternal failed: ${getUrlData.error}` };
      }

      const { upload_url, file_id } = getUrlData;

      // 2. Upload file bytes to the pre-signed URL
      const uploadRes = await fetch(upload_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        body: opts.buffer
      });
      if (!uploadRes.ok) {
        return { ok: false, error: `Upload to pre-signed URL failed with status ${uploadRes.status}` };
      }

      // 3. Complete the upload and share to channel/thread
      const completePayload: Record<string, any> = {
        files: [
          {
            id: file_id,
            title: opts.title || opts.filename
          }
        ],
        channel_id: channel
      };
      if (opts.thread_ts) {
        completePayload.thread_ts = opts.thread_ts;
      }
      if (opts.initial_comment) {
        completePayload.initial_comment = opts.initial_comment;
      }

      const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify(completePayload)
      });
      const completeData = await completeRes.json() as any;
      if (!completeData.ok) {
        return { ok: false, error: `files.completeUploadExternal failed: ${completeData.error}` };
      }

      const fileObj = completeData.files?.[0];
      return {
        ok: true,
        file_id,
        permalink: fileObj?.permalink
      };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Set agent session lifecycle status: 'processing', 'active', 'suspended', 'closed'.
   * Falls back to assistant.threads.setStatus if agents.sessions is not yet enabled.
   */
  public async setSessionStatus(opts: {
    channel?: string;
    channel_id?: string;
    thread_ts: string;
    status: 'processing' | 'active' | 'suspended' | 'closed';
    title?: string;
    icon_emoji?: string;
    username?: string;
  }): Promise<SlackApiResponse> {
    const channelId = opts.channel_id || opts.channel || '';
    const payload: Record<string, any> = {
      channel_id: channelId,
      thread_ts: opts.thread_ts,
      status: opts.status
    };
    if (opts.title) payload.title = opts.title;
    if (opts.icon_emoji) payload.icon_emoji = opts.icon_emoji;
    if (opts.username) payload.username = opts.username;

    const res = await this.callApi('agents.sessions.setStatus', payload);
    if (!res.ok && res.error === 'unknown_method') {
      // Compatibility fallback
      return this.callApi('assistant.threads.setStatus', {
        channel_id: channelId,
        thread_ts: opts.thread_ts,
        status: opts.status === 'processing' ? 'Working on it…' : ''
      });
    }
    return res;
  }

  /**
   * Rename an agent session.
   * Falls back to assistant.threads.setTitle if agents.sessions is not yet enabled.
   */
  public async renameSession(opts: {
    channel?: string;
    channel_id?: string;
    thread_ts: string;
    title: string;
  }): Promise<SlackApiResponse> {
    const channelId = opts.channel_id || opts.channel || '';
    const payload = {
      channel_id: channelId,
      thread_ts: opts.thread_ts,
      title: opts.title
    };
    const res = await this.callApi('agents.sessions.rename', payload);
    if (!res.ok && res.error === 'unknown_method') {
      return this.callApi('assistant.threads.setTitle', {
        channel_id: channelId,
        thread_ts: opts.thread_ts,
        title: opts.title
      });
    }
    return res;
  }

  /**
   * Set dynamic suggested prompts for the user in the Agent tab or thread.
   */
  public async setSuggestedPrompts(opts: {
    channel?: string;
    channel_id?: string;
    thread_ts?: string;
    title?: string;
    prompts: Array<{ title: string; message: string }>;
  }): Promise<SlackApiResponse> {
    const channelId = opts.channel_id || opts.channel || '';
    return this.callApi('assistant.threads.setSuggestedPrompts', {
      channel_id: channelId,
      thread_ts: opts.thread_ts,
      title: opts.title || 'Try these prompts:',
      prompts: opts.prompts
    });
  }

  /**
   * Start a streaming response with task plan mode.
   */
  public async startStream(opts: {
    channel: string;
    thread_ts: string;
    task_display_mode?: 'plan';
    markdown_text?: string;
    recipient_user_id?: string;
    recipient_team_id?: string;
  }): Promise<SlackApiResponse> {
    const payload: Record<string, any> = {
      channel: opts.channel,
      thread_ts: opts.thread_ts
    };
    if (opts.task_display_mode) payload.task_display_mode = opts.task_display_mode;
    if (opts.markdown_text) payload.markdown_text = toSlackMrkdwn(opts.markdown_text);
    if (opts.recipient_user_id) payload.recipient_user_id = opts.recipient_user_id;
    if (opts.recipient_team_id) payload.recipient_team_id = opts.recipient_team_id;
    return this.callApi('chat.startStream', payload);
  }

  /**
   * Append task chunks or markdown text to an active stream.
   */
  public async appendStream(opts: {
    channel: string;
    ts: string;
    chunks?: Array<{
      type: 'task' | 'markdown_text';
      id?: string;
      text?: string;
      status?: 'pending' | 'in_progress' | 'complete';
    }>;
    markdown_text?: string;
  }): Promise<SlackApiResponse> {
    const payload: Record<string, any> = {
      channel: opts.channel,
      ts: opts.ts
    };
    if (opts.chunks) payload.chunks = opts.chunks;
    if (opts.markdown_text) payload.markdown_text = toSlackMrkdwn(opts.markdown_text);
    return this.callApi('chat.appendStream', payload);
  }

  /**
   * Stop an active stream and finalize output and session status.
   */
  public async stopStream(opts: {
    channel: string;
    ts: string;
    markdown_text?: string;
    session_status?: 'active' | 'suspended' | 'closed';
  }): Promise<SlackApiResponse> {
    const payload: Record<string, any> = {
      channel: opts.channel,
      ts: opts.ts
    };
    if (opts.markdown_text) payload.markdown_text = toSlackMrkdwn(opts.markdown_text);
    if (opts.session_status) payload.session_status = opts.session_status;
    return this.callApi('chat.stopStream', payload);
  }

  /**
   * Cross-workspace semantic search for AI agents.
   * Searches across messages, files, and channels using enterprise permissions.
   */
  public async searchAssistantContext(opts: {
    query: string;
    action_token?: string;
    content_types?: string[];
    channel_types?: string[];
    include_context_messages?: boolean;
    limit?: number;
  }): Promise<{ ok: boolean; results?: any; error?: string }> {
    const payload: Record<string, any> = {
      query: opts.query,
      content_types: opts.content_types || ['messages', 'files', 'channels'],
      channel_types: opts.channel_types || ['public_channel', 'private_channel'],
      include_context_messages: opts.include_context_messages ?? true,
      limit: Math.min(opts.limit || 10, 20)
    };
    if (opts.action_token) payload.action_token = opts.action_token;
    const res = await this.callApi('assistant.search.context', payload);
    return res as any;
  }

  /**
   * Fetch recent message history from a channel.
   */
  public async getConversationHistory(channel: string, limit = 20, oldest?: string): Promise<Array<{ user?: string; bot_id?: string; text?: string; ts?: string; files?: any[] }>> {
    if (!this.token) return [];
    try {
      let url = `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channel)}&limit=${limit}`;
      if (oldest) url += `&oldest=${encodeURIComponent(oldest)}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json; charset=utf-8'
        }
      });
      const data = await res.json() as any;
      if (!data.ok) {
        console.warn('[SlackClient] conversations.history returned error:', data.error);
        return [];
      }
      return data.messages || [];
    } catch (err: any) {
      console.warn('[SlackClient] Exception fetching conversation history:', err.message);
      return [];
    }
  }

  /**
   * Create a new Slack Canvas with Markdown content.
   */
  public async createCanvas(opts: {
    title: string;
    markdown: string;
    channel_id?: string;
  }): Promise<{ ok: boolean; canvas_id?: string; error?: string }> {
    const payload: Record<string, any> = {
      title: opts.title,
      document_content: {
        type: 'markdown',
        markdown: opts.markdown
      }
    };
    if (opts.channel_id) {
      payload.channel_id = opts.channel_id;
    }
    const res = await this.callApi('canvases.create', payload);
    return res as any;
  }

  /**
   * Edit an existing Slack Canvas.
   */
  public async editCanvas(opts: {
    canvas_id: string;
    changes: Array<{
      operation: 'replace' | 'insert_at_end';
      document_content: { type: 'markdown'; markdown: string };
    }>;
  }): Promise<{ ok: boolean; error?: string }> {
    const res = await this.callApi('canvases.edit', {
      canvas_id: opts.canvas_id,
      changes: opts.changes
    });
    return res as any;
  }
}
