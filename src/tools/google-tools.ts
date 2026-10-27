import { z } from 'zod';
import { ToolDefinition } from '../types/tool.js';
import { GoogleWorkspaceClient } from '../integrations/google/client.js';
import { compactEvent, compactThread, threadSummary } from '../integrations/google/compact.js';
import { zonedDayRange, OWNER_TIMEZONE } from '../config/time.js';
import { reconcileGoogleSheetsAppend, tabNameFromRange, resolveHeaderRow } from '../governance/sheet-append.js';

export function createGoogleTools(googleClient: GoogleWorkspaceClient): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // 1. Gmail Search
  const gmailSearchTool: ToolDefinition = {
    name: 'gmail_search',
    description: 'Searches Gmail threads with Gmail query syntax (is:unread, from:x, subject:y, newer_than:2d, after:2026/10/01). Returns sender, subject, date and snippet per thread; use gmail_read for the full text.',
    effectClass: 'READ',
    schema: z.object({
      query: z.string().optional().default('is:unread').describe('Search query (default: is:unread)'),
      maxResults: z.number().int().positive().optional().default(10).describe('Max threads (default: 10)')
    }),
    execute: async (params) => {
      const threads = await googleClient.searchGmailThreads(params.query || 'is:unread', params.maxResults || 10);
      return threads.map(threadSummary);
    }
  };
  tools.push(gmailSearchTool);

  // 2. Gmail Read (gmail_read)
  tools.push({
    name: 'gmail_read',
    description: 'Reads a Gmail thread by ID: every message with from, to, date, subject and body text.',
    effectClass: 'READ',
    schema: z.object({
      threadId: z.string().describe('The Gmail thread ID to read')
    }),
    execute: async (params) => {
      return compactThread(await googleClient.getGmailThread(params.threadId));
    }
  });

  // 3. Gmail Draft
  const gmailDraftTool: ToolDefinition = {
    name: 'gmail_draft',
    description: 'Creates a draft email in Gmail without sending it. Checked against the Claims Bank and the owner sources, verified via read-back.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: z.object({
      to: z.string().describe('Recipient email address'),
      subject: z.string().describe('Email subject line'),
      body: z.string().describe('Email body text'),
      threadId: z.string().optional().describe('Thread ID if replying')
    }),
    ownerText: { kind: 'message', text: (p: any) => `${p.subject}\n\n${p.body}`, field: 'body' },
    execute: async (params) => {
      return googleClient.createGmailDraft(params);
    },
    verify: async (params, lastKnownResult) => {
      const draftId = lastKnownResult?.draftId;
      if (!draftId) {
        return { outcome: 'FAILED_SAFE', details: 'No draft ID returned to verify.' };
      }
      try {
        const draft = await googleClient.getGmailDraft(draftId);
        if (draft && draft.id === draftId) {
          return { outcome: 'VERIFIED_SUCCESS', details: `Draft ${draftId} confirmed in Gmail.` };
        }
        return { outcome: 'FAILED_SAFE', details: `Draft ${draftId} not found upon read-back.` };
      } catch (err: any) {
        return { outcome: 'RECONCILIATION_REQUIRED', reconciliationNotes: `Read-back verification failed: ${err.message}` };
      }
    }
  };
  tools.push(gmailDraftTool);

  // 4. Gmail Send (gmail_send - CONSEQUENTIAL)
  tools.push({
    name: 'gmail_send',
    description: 'Sends an email via Gmail. CONSEQUENTIAL: requires owner confirmation.',
    effectClass: 'CONSEQUENTIAL',
    schema: z.object({
      to: z.string().describe('Recipient email address'),
      subject: z.string().describe('Email subject line'),
      body: z.string().describe('Email body text'),
      threadId: z.string().optional().describe('Thread ID if replying')
    }),
    ownerText: { kind: 'message', text: (p: any) => `${p.subject}\n\n${p.body}`, field: 'body' },
    execute: async (params) => {
      return googleClient.sendGmailMessage(params);
    }
  });

  // 5. Sheets Read
  const sheetsReadTool: ToolDefinition = {
    name: 'sheets_read',
    description: 'Reads data from a Google Sheet range (e.g. Pipeline!A1:Z50).',
    effectClass: 'READ',
    schema: z.object({
      spreadsheetId: z.string().describe('Google Spreadsheet ID or alias (prospects, targets)'),
      range: z.string().describe('A1 range notation (e.g. Pipeline!A1:M30)')
    }),
    execute: async (params) => {
      return googleClient.readSheetRange(params.spreadsheetId, params.range);
    }
  };
  tools.push(sheetsReadTool);

  // 6. Sheets Append
  const sheetsAppendTool: ToolDefinition = {
    name: 'sheets_append',
    description: 'Appends a single structured row to a Google Sheet using header mapping. Verified via read-back hook.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: z.object({
      spreadsheetId: z.string().describe('Google Spreadsheet ID or alias'),
      range: z.string().describe('Target tab name or range (e.g. Pipeline)'),
      row: z.record(z.string(), z.any()).describe('Key-value pairs corresponding to column headers in the sheet'),
      headerRow: z.number().int().optional().describe('1-based header row number')
    }),
    execute: async (params) => {
      return googleClient.appendRowByHeaders({
        spreadsheetId: params.spreadsheetId,
        range: params.range,
        row: params.row,
        headerRow: params.headerRow
      });
    },
    reconcile: async (params) => {
      if (params.row !== undefined) {
        const tab = tabNameFromRange(params.range);
        const { headerRow } = resolveHeaderRow(params.spreadsheetId, tab, params.headerRow);
        const key = Object.entries(params.row).find(([k]) => k.trim().toLowerCase() === 'company_domain')?.[1];
        return await reconcileGoogleSheetsAppend(googleClient, {
          spreadsheetId: params.spreadsheetId,
          range: `'${tab.replace(/'/g, "''")}'!A${headerRow}:ZZ`,
          values: [key ?? '']
        });
      }
      return { outcome: 'VERIFIED_SUCCESS', details: 'Row appended.' };
    }
  };
  tools.push(sheetsAppendTool);

  // 6b. Sheets Update
  const sheetsUpdateTool: ToolDefinition = {
    name: 'sheets_update',
    description: 'Updates an existing range of cells in a Google Sheet (e.g. Inbox!F2:F2 or Companies!C5:E5). Verified via read-back hook.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: z.object({
      spreadsheetId: z.string().describe('Google Spreadsheet ID or alias (prospects, targets)'),
      range: z.string().describe('A1 range notation to update (e.g. Inbox!F2:F2 or Pipeline!D5:E5)'),
      values: z.array(z.array(z.any())).describe('2D array of values to write into the range')
    }),
    execute: async (params) => {
      return googleClient.updateSheetRange(params.spreadsheetId, params.range, params.values);
    },
    verify: async (params) => {
      try {
        const read = await googleClient.readSheetRange(params.spreadsheetId, params.range);
        if (read && read.values !== undefined) {
          return { outcome: 'VERIFIED_SUCCESS', details: `Updated range ${params.range} confirmed in sheet.` };
        }
        return { outcome: 'FAILED_SAFE', details: `Range ${params.range} not found upon read-back.` };
      } catch (err: any) {
        return { outcome: 'RECONCILIATION_REQUIRED', reconciliationNotes: `Sheet update read-back failed: ${err.message}` };
      }
    }
  };
  tools.push(sheetsUpdateTool);

  // 7. Docs Read
  const docsReadTool: ToolDefinition = {
    name: 'docs_read',
    description: 'Reads the entire plain text content of a Google Doc by document ID.',
    effectClass: 'READ',
    schema: z.object({
      documentId: z.string().describe('Google Docs document ID')
    }),
    readsResource: (params: any) => params.documentId,
    execute: async (params) => {
      const text = await googleClient.readDoc(params.documentId);
      return { documentId: params.documentId, text };
    }
  };
  tools.push(docsReadTool);

  // 8. Docs Create
  const docsCreateTool: ToolDefinition = {
    name: 'docs_create',
    description: 'Creates a new Google Doc with the specified title and initial body text. Verified via read-back.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: z.object({
      title: z.string().describe('Document title'),
      bodyText: z.string().describe('Initial plain text content')
    }),
    ownerText: { kind: 'document', text: (p: any) => `${p.title}\n${p.bodyText}`, field: 'bodyText' },
    writesResource: (_params: any, result: any) => result?.documentId,
    execute: async (params) => {
      return googleClient.createDoc(params.title, params.bodyText);
    },
    verify: async (params, lastKnownResult) => {
      const docId = lastKnownResult?.documentId;
      if (!docId) return { outcome: 'FAILED_SAFE', details: 'No document ID returned.' };
      try {
        const text = await googleClient.readDoc(docId);
        if (text !== undefined) {
          return { outcome: 'VERIFIED_SUCCESS', details: `Doc '${params.title}' (${docId}) confirmed with ${text.length} chars.` };
        }
        return { outcome: 'FAILED_SAFE', details: `Doc ${docId} not found upon read-back.` };
      } catch (err: any) {
        return { outcome: 'RECONCILIATION_REQUIRED', reconciliationNotes: `Read-back check failed: ${err.message}` };
      }
    }
  };
  tools.push(docsCreateTool);

  // 9. Docs Append
  const docsAppendTool: ToolDefinition = {
    name: 'docs_append',
    description: 'Appends text to an existing Google Doc. Verified via read-back.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: z.object({
      documentId: z.string().describe('Google Document ID'),
      text: z.string().describe('Text content to append')
    }),
    ownerText: { kind: 'document', text: (p: any) => p.text, field: 'text' },
    execute: async (params) => {
      return googleClient.appendToDoc(params.documentId, params.text);
    },
    verify: async (params) => {
      try {
        const fullDoc = await googleClient.readDoc(params.documentId);
        const snippet = params.text.trim().slice(0, 100);
        if (fullDoc.includes(snippet)) {
          return { outcome: 'VERIFIED_SUCCESS', details: `Appended text confirmed in doc ${params.documentId}.` };
        }
        return { outcome: 'FAILED_SAFE', details: `Appended text snippet not found in doc ${params.documentId}.` };
      } catch (err: any) {
        return { outcome: 'RECONCILIATION_REQUIRED', reconciliationNotes: `Doc append read-back failed: ${err.message}` };
      }
    }
  };
  tools.push(docsAppendTool);

  // 10. Drive Search
  const driveSearchTool: ToolDefinition = {
    name: 'drive_search',
    description: 'Searches Google Drive for files and documents matching a query.',
    effectClass: 'READ',
    schema: z.object({
      query: z.string().describe("Drive search query (e.g. name contains 'Resume')"),
      maxResults: z.number().int().positive().optional().describe('Max files to return')
    }),
    execute: async (params) => {
      return googleClient.searchDriveFiles(params.query, params.maxResults);
    }
  };
  tools.push(driveSearchTool);

  // 11. Calendar List
  const calendarListTool: ToolDefinition = {
    name: 'calendar_list',
    description: `Lists Google Calendar events. For a day ("tomorrow", "Friday") pass date as YYYY-MM-DD (and days for a longer span); times are in ${OWNER_TIMEZONE}. Without date or timeMin it lists upcoming events from now.`,
    effectClass: 'READ',
    schema: z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Local day to list, YYYY-MM-DD'),
      days: z.number().int().min(1).max(31).optional().describe('Number of days from date (default 1)'),
      timeMin: z.string().optional().describe('ISO start (instead of date)'),
      timeMax: z.string().optional().describe('ISO end (instead of date)'),
      maxResults: z.number().int().positive().max(100).optional().describe('Max events (default: 25)')
    }),
    execute: async (params) => {
      const range = params.date ? zonedDayRange(params.date, params.days ?? 1) : { timeMin: params.timeMin, timeMax: params.timeMax };
      const events = await googleClient.listCalendarEvents(range.timeMin, range.timeMax, params.maxResults ?? 25);
      return { timeZone: OWNER_TIMEZONE, ...range, count: events.length, events: events.map(compactEvent) };
    }
  };
  tools.push(calendarListTool);

  // 12. Calendar Create
  const calendarCreateTool: ToolDefinition = {
    name: 'calendar_create',
    description: 'Creates an event in Google Calendar. CONSEQUENTIAL: invites external attendees.',
    effectClass: 'CONSEQUENTIAL',
    schema: z.object({
      summary: z.string().describe('Event title or summary'),
      description: z.string().optional().describe('Event description'),
      startIso: z.string().describe('ISO start datetime string'),
      endIso: z.string().describe('ISO end datetime string'),
      attendees: z.array(z.string()).optional().describe('List of attendee email addresses')
    }),
    execute: async (params) => {
      return googleClient.createCalendarEvent(params);
    }
  };
  tools.push(calendarCreateTool);

  // 13. Drive Read File (Universal Drive Reader)
  const driveReadFileTool: ToolDefinition = {
    name: 'drive_read_file',
    description: 'Reads any Google Drive file by ID (Google Doc, PDF, DOCX, Markdown, CSV, plain text) and extracts its text contents.',
    effectClass: 'READ',
    schema: z.object({
      file_id: z.string().describe('Google Drive file ID'),
      max_chars: z.number().optional().default(20000).describe('Maximum characters to return (default: 20000)')
    }),
    execute: async (params) => {
      const maxChars = params.max_chars ?? 20000;
      let isGoogleDoc = false;

      // Try Google Doc first
      try {
        const text = await googleClient.readDoc(params.file_id);
        if (text && typeof text === 'string') {
          return {
            file_id: params.file_id,
            format: 'google_doc',
            text: text.slice(0, maxChars),
            totalChars: text.length
          };
        }
      } catch {
        // Not a Google Doc or readDoc failed; proceed to download raw buffer
      }

      const buffer = await googleClient.downloadFile(params.file_id);

      // Check PDF magic bytes: %PDF- (0x25 0x50 0x44 0x46 0x2D)
      if (buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-') {
        let extractedText = '';
        try {
          const { libreOfficeEngine, pdfToolsInstalled } = await import('../documents/pdf.js');
          if (pdfToolsInstalled()) {
            extractedText = await libreOfficeEngine.text(buffer);
          } else {
            extractedText = buffer.toString('utf8');
          }
        } catch {
          extractedText = buffer.toString('utf8');
        }
        return {
          file_id: params.file_id,
          format: 'pdf',
          text: extractedText.slice(0, maxChars),
          totalChars: extractedText.length
        };
      }

      // Check ZIP/DOCX magic bytes: PK\x03\x04
      if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
        try {
          const { docxParagraphs } = await import('../documents/render-docx.js');
          const paragraphs = await docxParagraphs(buffer);
          const fullText = paragraphs.join('\n');
          return {
            file_id: params.file_id,
            format: 'docx',
            text: fullText.slice(0, maxChars),
            totalChars: fullText.length
          };
        } catch (docxErr: any) {
          console.warn('[drive_read_file] DOCX parse error, falling back to utf8:', docxErr.message);
        }
      }

      // Default UTF-8 decode
      const utf8 = buffer.toString('utf8');
      return {
        file_id: params.file_id,
        format: 'text',
        text: utf8.slice(0, maxChars),
        totalChars: utf8.length
      };
    }
  };
  tools.push(driveReadFileTool);

  return tools;
}
