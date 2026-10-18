import { ImapFlow } from 'imapflow';
import { simpleParser, ParsedMail } from 'mailparser';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { DatabaseSync } from 'node:sqlite';

export interface ProtonConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  allowSelfSigned?: boolean;
}

export interface ProtonInboundMessage {
  uid: number;
  messageId: string;
  threadId: string;
  fromEmail: string;
  fromName: string | null;
  to: string[];
  subject: string;
  date: Date;
  textBody: string;
  snippet: string;
}

export class ProtonMailClient {
  private config: ProtonConfig;

  constructor(customConfig?: Partial<ProtonConfig>, private readonly appDb?: DatabaseSync) {
    this.config = {
      host: customConfig?.host || process.env.PROTON_IMAP_HOST || '127.0.0.1',
      port: customConfig?.port || parseInt(process.env.PROTON_IMAP_PORT || '1143', 10),
      username: customConfig?.username || process.env.PROTON_USERNAME || '',
      password: customConfig?.password || process.env.PROTON_BRIDGE_PASSWORD || '',
      allowSelfSigned: customConfig?.allowSelfSigned ?? (process.env.PROTON_ALLOW_SELFSIGNED_TLS !== 'false')
    };

    if (this.appDb) {
      this.loadFromDb();
    }
  }

  public isEnabled(): boolean {
    return process.env.PROTON_ENABLED !== 'false' && Boolean(this.config.username && this.config.password);
  }

  private loadFromDb(): void {
    if (!this.appDb) return;
    try {
      const stmt = this.appDb.prepare("SELECT * FROM integrations WHERE provider = 'proton' AND status = 'connected'");
      const record = stmt.get() as any;
      if (record) {
        if (record.account_email && !this.config.username) {
          this.config.username = record.account_email;
        }
        if (record.access_token && !this.config.password) {
          this.config.password = record.access_token;
        }
      }
    } catch {}
  }

  private createClient(): ImapFlow {
    return new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: false, // Proton Mail Bridge uses STARTTLS on port 1143
      auth: {
        user: this.config.username,
        pass: this.config.password || ''
      },
      tls: {
        rejectUnauthorized: !this.config.allowSelfSigned
      },
      logger: false
    });
  }

  /**
   * Fast status query for cheap-detect sentinel without reading message bodies.
   */
  public async getMailboxStatus(mailbox = 'INBOX'): Promise<{ uidNext: number; unseen: number; messages: number }> {
    if (!this.isEnabled()) return { uidNext: 0, unseen: 0, messages: 0 };
    const client = this.createClient();
    await client.connect();
    try {
      const status = await client.status(mailbox, { uidNext: true, unseen: true, messages: true });
      if (!status) {
        return { uidNext: 0, unseen: 0, messages: 0 };
      }
      return {
        uidNext: status.uidNext || 0,
        unseen: status.unseen || 0,
        messages: status.messages || 0
      };
    } finally {
      await client.logout();
    }
  }

  public async listUnread(maxResults = 10): Promise<ProtonInboundMessage[]> {
    if (!this.isEnabled()) return [];
    return this.searchEmails('UNSEEN', maxResults);
  }

  public async searchEmails(query: string, maxResults = 10): Promise<ProtonInboundMessage[]> {
    if (!this.isEnabled()) return [];

    const client = this.createClient();
    await client.connect();
    const messages: ProtonInboundMessage[] = [];

    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        let searchQuery: any = { seen: false };
        if (query && query.toUpperCase() !== 'UNSEEN') {
          searchQuery = { or: [{ header: { subject: query } }, { from: query }, { body: query }] };
        }

        const searchResult = await client.search(searchQuery, { uid: true });
        const uids = Array.isArray(searchResult) ? searchResult.slice(-maxResults).reverse() : [];

        for (const uid of uids) {
          try {
            const messageData = await client.download(String(uid), undefined, { uid: true });
            if (!messageData || !messageData.content) continue;

            const parsed: ParsedMail = await simpleParser(messageData.content);
            const fromHeader = parsed.from?.value?.[0];
            const fromEmail = fromHeader?.address?.toLowerCase() || 'unknown@proton.me';
            const fromName = fromHeader?.name || null;

            const to: string[] = [];
            if (parsed.to) {
              const list = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
              for (const item of list) {
                for (const val of item.value || []) {
                  if (val.address) to.push(val.address.toLowerCase());
                }
              }
            }

            const subject = parsed.subject || '(no subject)';
            const textBody = parsed.text || '';
            const snippet = textBody.replace(/\s+/g, ' ').trim().slice(0, 200);
            const date = parsed.date || new Date();
            const messageId = parsed.messageId || `proton_${uid}_${date.getTime()}`;
            const inReplyTo = parsed.inReplyTo || '';
            const threadId = inReplyTo || messageId;

            messages.push({
              uid,
              messageId,
              threadId,
              fromEmail,
              fromName,
              to,
              subject,
              date,
              textBody,
              snippet
            });
          } catch {}
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }

    return messages;
  }

  public async readEmail(uid: number): Promise<ProtonInboundMessage | null> {
    if (!this.isEnabled()) return null;

    const client = this.createClient();
    await client.connect();

    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const messageData = await client.download(String(uid), undefined, { uid: true });
        if (!messageData || !messageData.content) return null;

        const parsed: ParsedMail = await simpleParser(messageData.content);
        const fromHeader = parsed.from?.value?.[0];
        const fromEmail = fromHeader?.address?.toLowerCase() || 'unknown@proton.me';
        const fromName = fromHeader?.name || null;

        const to: string[] = [];
        if (parsed.to) {
          const list = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
          for (const item of list) {
            for (const val of item.value || []) {
              if (val.address) to.push(val.address.toLowerCase());
            }
          }
        }

        const subject = parsed.subject || '(no subject)';
        const textBody = parsed.text || '';
        const snippet = textBody.replace(/\s+/g, ' ').trim().slice(0, 200);
        const date = parsed.date || new Date();
        const messageId = parsed.messageId || `proton_${uid}_${date.getTime()}`;
        const inReplyTo = parsed.inReplyTo || '';
        const threadId = inReplyTo || messageId;

        return {
          uid,
          messageId,
          threadId,
          fromEmail,
          fromName,
          to,
          subject,
          date,
          textBody,
          snippet
        };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  public async findDraft(subject: string): Promise<{ uid: number } | null> {
    if (!this.isEnabled()) return null;
    const client = this.createClient();
    await client.connect();
    try {
      const mailboxes = await client.list();
      const draftsMailbox = mailboxes.find(m => m.specialUse === '\\Drafts' || m.path.toLowerCase() === 'drafts')?.path || 'Drafts';
      const lock = await client.getMailboxLock(draftsMailbox);
      try {
        const uids = await client.search({ header: { subject } }, { uid: true });
        const list = Array.isArray(uids) ? uids : [];
        return list.length > 0 ? { uid: list[list.length - 1] } : null;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  public async createDraft(options: {
    to: string;
    subject: string;
    body: string;
    inReplyTo?: string;
  }): Promise<{ draftUid?: number }> {
    if (!this.isEnabled()) {
      throw new Error('Proton Mail Bridge is not configured or disabled.');
    }

    const transport = nodemailer.createTransport({
      streamTransport: true,
      buffer: true
    });

    const info = await transport.sendMail({
      from: this.config.username,
      to: options.to,
      subject: options.subject,
      text: options.body,
      inReplyTo: options.inReplyTo
    });

    const client = this.createClient();
    await client.connect();
    try {
      const mailboxes = await client.list();
      const draftsMailbox = mailboxes.find(m => m.specialUse === '\\Drafts' || m.path.toLowerCase() === 'drafts')?.path || 'Drafts';
      const appendResult = await client.append(
        draftsMailbox,
        info.message as Buffer,
        ['\\Draft', '\\Seen']
      );
      return { draftUid: appendResult ? appendResult.uid : undefined };
    } finally {
      await client.logout();
    }
  }

  public async sendEmail(params: {
    to: string;
    subject: string;
    body: string;
    inReplyTo?: string;
  }): Promise<{ messageId: string }> {
    if (!this.isEnabled()) {
      throw new Error('Proton Mail Bridge is not configured or disabled.');
    }

    const transporter = nodemailer.createTransport({
      host: this.config.host,
      port: parseInt(process.env.PROTON_SMTP_PORT || '1025', 10),
      secure: false,
      auth: {
        user: this.config.username,
        pass: this.config.password
      },
      tls: {
        rejectUnauthorized: !this.config.allowSelfSigned
      }
    });

    const info = await transporter.sendMail({
      from: this.config.username,
      to: params.to,
      subject: params.subject,
      text: params.body,
      inReplyTo: params.inReplyTo
    });

    return { messageId: info.messageId };
  }
}
