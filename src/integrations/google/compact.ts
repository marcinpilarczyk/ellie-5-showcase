/**
 * Google API responses reduced to what a reader needs. Raw Calendar and Gmail payloads are
 * 1-2k characters per item of ids, etags and base64; handing them to the model made it page
 * through the Result Store instead of answering.
 */

const MAX_DESCRIPTION = 400;
const MAX_BODY = 4000;

export function stripHtml(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text;
}

export interface CompactEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay?: true;
  location?: string;
  meetLink?: string;
  organizer?: string;
  attendees?: string[];
  myResponse?: string;
  description?: string;
  link?: string;
}

export function compactEvent(e: any): CompactEvent {
  const self = (e.attendees || []).find((a: any) => a.self);
  const others = (e.attendees || []).filter((a: any) => !a.self && !a.resource);
  const out: CompactEvent = {
    id: e.id,
    title: e.summary || '(no title)',
    start: e.start?.dateTime || e.start?.date || '',
    end: e.end?.dateTime || e.end?.date || ''
  };
  if (!e.start?.dateTime && e.start?.date) out.allDay = true;
  if (e.location) out.location = e.location;
  if (e.hangoutLink) out.meetLink = e.hangoutLink;
  if (e.organizer?.email && !e.organizer.self) out.organizer = e.organizer.displayName || e.organizer.email;
  if (others.length) {
    const attendees: string[] = others.slice(0, 10).map((a: any) => `${a.displayName || a.email} (${a.responseStatus || 'unknown'})`);
    if (others.length > 10) attendees.push(`+${others.length - 10} more`);
    out.attendees = attendees;
  }
  if (self?.responseStatus) out.myResponse = self.responseStatus;
  if (e.description) out.description = clip(stripHtml(e.description), MAX_DESCRIPTION);
  if (e.htmlLink) out.link = e.htmlLink;
  return out;
}

function header(headers: Array<{ name?: string; value?: string }> | undefined, name: string): string {
  return headers?.find(h => h.name?.toLowerCase() === name)?.value || '';
}

function decode(data?: string): string {
  return data ? Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') : '';
}

function collectParts(part: any, out: { plain: string[]; html: string[]; attachments: string[] }): void {
  if (!part) return;
  if (part.filename && part.body?.attachmentId) out.attachments.push(part.filename);
  else if (part.mimeType === 'text/plain' && part.body?.data) out.plain.push(decode(part.body.data));
  else if (part.mimeType === 'text/html' && part.body?.data) out.html.push(decode(part.body.data));
  for (const child of part.parts || []) collectParts(child, out);
}

/** Readable text of one Gmail message: plain text if present, else the HTML part stripped. */
export function messageText(payload: any): { body: string; attachments: string[] } {
  const out = { plain: [] as string[], html: [] as string[], attachments: [] as string[] };
  collectParts(payload, out);
  const body = out.plain.length ? out.plain.join('\n') : stripHtml(out.html.join('\n'));
  return { body: body.replace(/\r\n/g, '\n').trim(), attachments: out.attachments };
}

export function compactThread(thread: any): any {
  const messages = (thread.messages || []).map((m: any) => {
    const h = m.payload?.headers;
    const { body, attachments } = messageText(m.payload);
    return {
      id: m.id,
      from: header(h, 'from'),
      to: header(h, 'to'),
      ...(header(h, 'cc') ? { cc: header(h, 'cc') } : {}),
      date: header(h, 'date'),
      subject: header(h, 'subject'),
      ...(m.labelIds?.includes('UNREAD') ? { unread: true } : {}),
      body: clip(body || m.snippet || '', MAX_BODY),
      ...(attachments.length ? { attachments } : {})
    };
  });
  return { threadId: thread.id, messageCount: messages.length, messages };
}

/** Thread list row from a `format: 'metadata'` thread: who, what, when. */
export function threadSummary(thread: any): any {
  const msgs = thread.messages || [];
  const last = msgs[msgs.length - 1];
  const h = last?.payload?.headers;
  return {
    threadId: thread.id,
    from: header(h, 'from'),
    subject: header(msgs[0]?.payload?.headers, 'subject') || header(h, 'subject'),
    date: header(h, 'date'),
    messageCount: msgs.length,
    ...(msgs.some((m: any) => m.labelIds?.includes('UNREAD')) ? { unread: true } : {}),
    snippet: last?.snippet || thread.snippet || ''
  };
}

/** Text of a Docs structural-element list: paragraphs as written, each table row as one "a | b | c" line. */
function structuralText(content: any[] | undefined): string {
  let text = '';
  for (const elem of content || []) {
    if (elem.paragraph?.elements) {
      for (const pe of elem.paragraph.elements) {
        if (pe.textRun?.content) text += pe.textRun.content;
      }
    } else if (elem.table?.tableRows) {
      for (const row of elem.table.tableRows) {
        const cells = (row.tableCells || []).map((cell: any) => structuralText(cell.content).replace(/\s*\n\s*/g, ' ').trim());
        if (cells.some((c: string) => c)) text += `${cells.join(' | ')}\n`;
      }
    }
  }
  return text;
}

function flattenTabs(tabs: any[] | undefined): any[] {
  return (tabs || []).flatMap(tab => [tab, ...flattenTabs(tab.childTabs)]);
}

/**
 * Plain text of a Google Doc (fetched with includeTabsContent). Every Doc read goes through this,
 * so tables and extra tabs are never silently dropped. A one-tab Doc reads exactly as its body.
 */
export function docPlainText(doc: any): string {
  const tabs = flattenTabs(doc?.tabs).filter(t => t.documentTab?.body);
  if (tabs.length === 0) return structuralText(doc?.body?.content).trim();
  if (tabs.length === 1) return structuralText(tabs[0].documentTab.body.content).trim();
  return tabs
    .map(t => `=== Tab: ${t.tabProperties?.title ?? 'Untitled'} ===\n${structuralText(t.documentTab.body.content).trim()}`)
    .join('\n\n');
}
