import { OAuth2Client } from 'google-auth-library';
import type { gmail_v1, calendar_v3, sheets_v4, docs_v1, drive_v3 } from 'googleapis';
import { DatabaseSync } from 'node:sqlite';
import { appendRowByHeaders, SheetAppendRefusal } from '../../governance/sheet-append.js';
import { docPlainText } from './compact.js';

let _googleInstance: any = null;
async function getGoogle() {
  if (!_googleInstance) {
    const mod = await import('googleapis');
    _googleInstance = mod.google;
  }
  return _googleInstance;
}

export function googleRedirectUri(): string {
  const explicit = process.env.GOOGLE_WORKSPACE_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const base = process.env.ELLIE_PUBLIC_URL?.trim().replace(/\/+$/, '') || 'http://127.0.0.1:3001';
  return `${base}/api/integrations/google/callback`;
}

/** Scopes Ellie needs: mail (read, draft, send), Drive/Docs/Sheets, Calendar, and the account email. */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email'
];

export const KNOWN_TRACKERS = {
  prospects: {
    id: process.env.ELLIE_PROSPECT_TRACKER_ID?.trim() || 'prospect-tracker-id',
    name: 'Prospect Tracker',
    aliases: ['prospects', 'prospect_tracker']
  },
  targets: {
    id: process.env.ELLIE_TARGET_TRACKER_ID?.trim() || 'target-tracker-id',
    name: 'Targets Tracker',
    aliases: ['targets', 'target_tracker', 'job_search']
  }
} as const;

export class GoogleWorkspaceClient {
  private oauth2Client: any = null;

  constructor(private readonly appDb?: DatabaseSync) {}

  public getOAuthClient(): any {
    if (this.oauth2Client) return this.oauth2Client;

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = googleRedirectUri();

    if (!clientId || !clientSecret) {
      return null;
    }

    this.oauth2Client = new OAuth2Client(clientId, clientSecret, redirectUri);
    // Persist refreshed tokens, including after a fresh connect (not only when a row existed at boot)
    this.oauth2Client.on('tokens', (tokens: any) => {
      this.saveTokensToDb(tokens);
    });
    this.loadTokensFromDb();
    return this.oauth2Client;
  }

  public isConfigured(): boolean {
    return Boolean(this.getOAuthClient());
  }

  public isConnected(): boolean {
    const client = this.getOAuthClient();
    return Boolean(client && client.credentials && client.credentials.refresh_token);
  }

  private loadTokensFromDb(): void {
    if (!this.appDb || !this.oauth2Client) return;
    try {
      const stmt = this.appDb.prepare("SELECT * FROM integrations WHERE id = 'google_main'");
      const row = stmt.get() as any;
      if (row && (row.access_token || row.refresh_token)) {
        this.oauth2Client.setCredentials({
          access_token: row.access_token,
          refresh_token: row.refresh_token,
          expiry_date: row.token_expires_at ? new Date(row.token_expires_at).getTime() : undefined
        });
      }
    } catch {}
  }

  public saveTokensToDb(tokens: any, accountEmail?: string): void {
    if (!this.appDb) return;
    const now = new Date().toISOString();
    const expiryDate = tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null;

    try {
      const existing = this.appDb.prepare("SELECT * FROM integrations WHERE id = 'google_main'").get() as any;
      const email = accountEmail || existing?.account_email || process.env.GOOGLE_OPERATOR_EMAIL || 'owner';
      const refreshToken = tokens.refresh_token || existing?.refresh_token;

      this.appDb.prepare(`
        INSERT INTO integrations (
          id, provider, status, account_email, access_token, refresh_token, token_expires_at, updated_at
        ) VALUES ('google_main', 'google', 'connected', ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = 'connected',
          account_email = excluded.account_email,
          access_token = excluded.access_token,
          refresh_token = COALESCE(excluded.refresh_token, integrations.refresh_token),
          token_expires_at = excluded.token_expires_at,
          updated_at = excluded.updated_at
      `).run(email, tokens.access_token, refreshToken, expiryDate, now);
    } catch (err: any) {
      console.warn('[GoogleWorkspaceClient] Failed to persist OAuth tokens:', err.message);
    }
  }

  // --- Gmail ---

  public async getGmailProfile(): Promise<{ emailAddress: string; historyId: string; messagesTotal: number }> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const gmail = google.gmail({ version: 'v1', auth });
    const res = await gmail.users.getProfile({ userId: 'me' });
    return {
      emailAddress: res.data.emailAddress || '',
      historyId: res.data.historyId || '',
      messagesTotal: res.data.messagesTotal || 0
    };
  }

  public async listGmailThreads(query = 'is:unread', maxResults = 10): Promise<any[]> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const gmail = google.gmail({ version: 'v1', auth });
    const res = await gmail.users.threads.list({ userId: 'me', q: query, maxResults });
    return res.data.threads || [];
  }

  /** Matching threads with sender, subject, date and snippet (one metadata call per thread, in parallel). */
  public async searchGmailThreads(query = 'is:unread', maxResults = 10): Promise<any[]> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const gmail = google.gmail({ version: 'v1', auth });
    const res = await gmail.users.threads.list({ userId: 'me', q: query, maxResults });
    const ids = (res.data.threads || []).map((t: any) => t.id as string).filter(Boolean);
    return Promise.all(ids.map(async (id: string) => (await gmail.users.threads.get({
      userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date']
    })).data));
  }

  /** Search emails returning id, threadId, subject, and snippet for lightweight context lookups. */
  public async searchEmails(query = 'is:unread', maxResults = 10): Promise<Array<{ id: string; threadId: string; subject: string; snippet: string }>> {
    const threads = await this.searchGmailThreads(query, maxResults);
    return threads.map((t: any) => {
      const firstMsg = t.messages?.[0] || {};
      const headers = firstMsg.payload?.headers || [];
      const subjectHeader = headers.find((h: any) => h.name?.toLowerCase() === 'subject');
      return {
        id: t.id,
        threadId: t.id,
        subject: subjectHeader?.value || t.snippet || '',
        snippet: t.snippet || firstMsg.snippet || ''
      };
    });
  }

  public async getGmailThread(threadId: string): Promise<any> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const gmail = google.gmail({ version: 'v1', auth });
    const res = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
    return res.data;
  }

  public async getGmailDraft(draftId: string): Promise<any> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const gmail = google.gmail({ version: 'v1', auth });
    const res = await gmail.users.drafts.get({ userId: 'me', id: draftId, format: 'full' });
    return res.data;
  }

  public async createGmailDraft(params: {
    to: string;
    subject: string;
    body: string;
    threadId?: string;
  }): Promise<{ draftId: string; threadId?: string }> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const gmail = google.gmail({ version: 'v1', auth });

    const raw = Buffer.from(
      `To: ${params.to}\r\n` +
      `Subject: ${params.subject}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
      `${params.body}`
    ).toString('base64url');

    const res = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          raw,
          threadId: params.threadId
        }
      }
    });

    return { draftId: res.data.id!, threadId: res.data.message?.threadId || undefined };
  }

  public async sendGmailMessage(params: {
    to: string;
    subject: string;
    body: string;
    threadId?: string;
  }): Promise<{ messageId: string; threadId?: string }> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const gmail = google.gmail({ version: 'v1', auth });

    const raw = Buffer.from(
      `To: ${params.to}\r\n` +
      `Subject: ${params.subject}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
      `${params.body}`
    ).toString('base64url');

    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw,
        threadId: params.threadId
      }
    });

    return { messageId: res.data.id!, threadId: res.data.threadId || undefined };
  }

  // --- Sheets ---

  public async readSheetRange(spreadsheetId: string, range: string): Promise<{ values: any[][] }> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    return { values: res.data.values || [] };
  }

  public async appendSheetRows(spreadsheetId: string, range: string, values: any[][]): Promise<{
    updatedRange?: string;
    updatedRows: number;
  }> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values }
    });
    return {
      updatedRange: res.data.updates?.updatedRange || undefined,
      updatedRows: res.data.updates?.updatedRows || 0
    };
  }

  public async appendRowByHeaders(params: {
    spreadsheetId: string;
    range: string;
    row: Record<string, unknown>;
    headerRow?: number;
  }): Promise<{ updatedRange?: string; updatedRows: number; mapping: Record<string, any>; headerRow: number }> {
    return appendRowByHeaders(this, params);
  }

  public async updateSheetRange(spreadsheetId: string, range: string, values: any[][]): Promise<{
    updatedRange?: string;
    updatedRows: number;
    updatedColumns: number;
    updatedCells: number;
  }> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });
    return {
      updatedRange: res.data.updatedRange || undefined,
      updatedRows: res.data.updatedRows || 0,
      updatedColumns: res.data.updatedColumns || 0,
      updatedCells: res.data.updatedCells || 0
    };
  }

  // --- Docs & Drive ---

  public async readDoc(documentId: string): Promise<string> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const docs = google.docs({ version: 'v1', auth });
    const res = await docs.documents.get({ documentId, includeTabsContent: true });
    return docPlainText(res.data);
  }

  public async createDoc(title: string, bodyText: string): Promise<{ documentId: string }> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const docs = google.docs({ version: 'v1', auth });
    const createRes = await docs.documents.create({ requestBody: { title } });
    const documentId = createRes.data.documentId!;

    if (bodyText) {
      await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [
            {
              insertText: {
                location: { index: 1 },
                text: bodyText
              }
            }
          ]
        }
      });
    }

    return { documentId };
  }

  public async replaceDocContent(documentId: string, text: string): Promise<{ documentId: string; success: boolean }> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const docs = google.docs({ version: 'v1', auth });
    const doc = await docs.documents.get({ documentId });
    const content = doc.data.body?.content || [];
    const lastIndex = content.length > 0 ? (content[content.length - 1].endIndex ?? 1) : 1;
    const requests: any[] = [];
    if (lastIndex > 2) {
      requests.push({
        deleteContentRange: {
          range: { startIndex: 1, endIndex: lastIndex - 1 }
        }
      });
    }
    if (text) {
      requests.push({
        insertText: {
          location: { index: 1 },
          text: text
        }
      });
    }
    if (requests.length > 0) {
      await docs.documents.batchUpdate({
        documentId,
        requestBody: { requests }
      });
    }
    return { documentId, success: true };
  }

  public async createDocInFolder(title: string, bodyText: string, folderId?: string): Promise<{ documentId: string }> {
    const res = await this.createDoc(title, bodyText);
    if (folderId) {
      const auth = this.getOAuthClient();
      if (auth) {
        try {
          const google = await getGoogle();
          const drive = google.drive({ version: 'v3', auth });
          await drive.files.update({
            fileId: res.documentId,
            addParents: folderId,
            fields: 'id, parents'
          });
        } catch {}
      }
    }
    return res;
  }

  public async appendToDoc(documentId: string, text: string): Promise<{ documentId: string; success: boolean }> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const docs = google.docs({ version: 'v1', auth });
    await docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [
          {
            insertText: {
              endOfSegmentLocation: {},
              text: text.endsWith('\n') ? text : `${text}\n`
            }
          }
        ]
      }
    });
    return { documentId, success: true };
  }

  public async searchDriveFiles(query: string, maxResults = 10): Promise<any[]> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const drive = google.drive({ version: 'v3', auth });
    const res = await drive.files.list({
      q: query,
      pageSize: maxResults,
      fields: 'files(id, name, mimeType, modifiedTime, webViewLink)'
    });
    return res.data.files || [];
  }

  public async getDriveFileMeta(fileId: string): Promise<any> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const drive = google.drive({ version: 'v3', auth });
    const res = await drive.files.get({ fileId, fields: 'id, name, mimeType, modifiedTime, webViewLink, size' });
    return res.data;
  }

  public async getParentFolderId(fileId: string): Promise<string | undefined> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const drive = google.drive({ version: 'v3', auth });
    const res = await drive.files.get({ fileId, fields: 'parents' });
    return res.data.parents?.[0] ?? undefined;
  }

  /** Google Docs in a folder and the subfolders `descend` allows (by name and depth, root = 0), with their folder path. */
  public async listFolderDocs(
    folderId: string,
    descend: (folderName: string, depth: number) => boolean = () => true,
    maxDepth = 3,
    limit = 80
  ): Promise<Array<{ id: string; title: string; path: string; modifiedTime?: string }>> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const drive = google.drive({ version: 'v3', auth });
    const out: Array<{ id: string; title: string; path: string; modifiedTime?: string }> = [];
    const walk = async (id: string, path: string, depth: number): Promise<void> => {
      let pageToken: string | undefined;
      do {
        const res = await drive.files.list({
          q: `'${id}' in parents and trashed = false`,
          pageSize: 100,
          pageToken,
          fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)'
        });
        for (const f of res.data.files || []) {
          if (out.length >= limit) return;
          if (f.mimeType === 'application/vnd.google-apps.document') {
            out.push({ id: f.id!, title: f.name ?? f.id!, path, modifiedTime: f.modifiedTime ?? undefined });
          } else if (f.mimeType === 'application/vnd.google-apps.folder' && depth < maxDepth && descend(f.name ?? '', depth)) {
            await walk(f.id!, `${path}/${f.name}`, depth + 1);
          }
        }
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken && out.length < limit);
    };
    await walk(folderId, '', 0);
    return out;
  }

  /** The folder at `path` (segments separated by '/') under rootId, creating missing folders. */
  public async ensureFolderPath(rootId: string, path: string): Promise<string> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const drive = google.drive({ version: 'v3', auth });
    let parent = rootId;
    for (const name of path.split('/').map(s => s.trim()).filter(Boolean)) {
      const q = `'${parent}' in parents and mimeType = 'application/vnd.google-apps.folder' and name = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and trashed = false`;
      const res = await drive.files.list({ q, pageSize: 1, fields: 'files(id)' });
      const found = res.data.files?.[0]?.id;
      if (found) {
        parent = found;
        continue;
      }
      const created = await drive.files.create({
        requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] },
        fields: 'id'
      });
      parent = created.data.id!;
    }
    return parent;
  }

  /** Uploads a file as-is (no conversion to a Google format). */
  public async uploadFile(name: string, mimeType: string, data: Buffer, parentId: string): Promise<{ id: string; name: string; webViewLink?: string }> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const drive = google.drive({ version: 'v3', auth });
    const { Readable } = await import('node:stream');
    const res = await drive.files.create({
      requestBody: { name, parents: [parentId] },
      media: { mimeType, body: Readable.from(data) },
      fields: 'id, name, webViewLink'
    });
    return { id: res.data.id!, name: res.data.name ?? name, webViewLink: res.data.webViewLink ?? undefined };
  }

  /** The bytes of a stored (non-Google-format) file. */
  public async downloadFile(fileId: string): Promise<Buffer> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const drive = google.drive({ version: 'v3', auth });
    const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
    return Buffer.from(res.data as ArrayBuffer);
  }

  // --- Calendar ---

  public async listCalendarEvents(timeMin?: string, timeMax?: string, maxResults = 15): Promise<any[]> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const calendar = google.calendar({ version: 'v3', auth });
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMin || new Date().toISOString(),
      timeMax,
      maxResults,
      singleEvents: true,
      orderBy: 'startTime'
    });
    return res.data.items || [];
  }

  public async createCalendarEvent(params: {
    summary: string;
    description?: string;
    startIso: string;
    endIso: string;
    attendees?: string[];
  }): Promise<{ eventId: string; htmlLink?: string }> {
    const auth = this.getOAuthClient();
    if (!auth) throw new Error('Google Workspace is not connected.');
    const google = await getGoogle();
    const calendar = google.calendar({ version: 'v3', auth });
    const res = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: params.summary,
        description: params.description,
        start: { dateTime: params.startIso },
        end: { dateTime: params.endIso },
        attendees: params.attendees?.map(email => ({ email }))
      }
    });
    return { eventId: res.data.id!, htmlLink: res.data.htmlLink || undefined };
  }
}
