import { z } from 'zod';
import { ToolDefinition } from '../types/tool.js';
import { ProtonMailClient } from '../integrations/proton/client.js';

export function createProtonTools(protonClient: ProtonMailClient): ToolDefinition[] {
  return [
    {
      name: 'proton_search',
      description: 'Searches Proton Mail messages in local IMAP bridge by query or UNSEEN flag.',
      effectClass: 'READ',
      schema: z.object({
        query: z.string().optional().default('UNSEEN').describe('Search query keyword or UNSEEN (default)'),
        maxResults: z.number().int().positive().optional().default(10).describe('Maximum messages to fetch (default: 10)')
      }),
      execute: async (params) => {
        return protonClient.searchEmails(params.query || 'UNSEEN', params.maxResults || 10);
      }
    },
    {
      name: 'proton_list_unread',
      description: 'Lists recent unread messages from Proton Mail via local bridge.',
      effectClass: 'READ',
      schema: z.object({
        maxResults: z.number().int().positive().optional().default(10).describe('Maximum messages to fetch (default: 10)')
      }),
      execute: async (params) => {
        return protonClient.listUnread(params.maxResults || 10);
      }
    },
    {
      name: 'proton_read',
      description: 'Reads full text body and headers of a specific Proton Mail message by UID.',
      effectClass: 'READ',
      schema: z.object({
        uid: z.number().int().positive().describe('Message UID in mailbox')
      }),
      execute: async (params) => {
        const msg = await protonClient.readEmail(params.uid);
        if (!msg) {
          throw new Error(`Message with UID ${params.uid} not found in Proton Mail.`);
        }
        return msg;
      }
    },
    {
      name: 'proton_draft',
      description: 'Creates a draft in Proton Mail Drafts mailbox via IMAP append. Checked against the Claims Bank and the owner sources, with read-back verification.',
      effectClass: 'INTERNAL_REVERSIBLE_WRITE',
      schema: z.object({
        to: z.string().describe('Recipient email address'),
        subject: z.string().describe('Email subject line'),
        body: z.string().describe('Email body text'),
        inReplyTo: z.string().optional().describe('Message-ID being replied to')
      }),
      ownerText: { kind: 'message', text: (p: any) => `${p.subject}\n\n${p.body}`, field: 'body' },
      execute: async (params) => {
        return protonClient.createDraft(params);
      },
      verify: async (params) => {
        const found = await protonClient.findDraft(params.subject);
        return found
          ? { outcome: 'VERIFIED_SUCCESS', details: `Draft '${params.subject}' confirmed in Proton Drafts (UID ${found.uid}).` }
          : { outcome: 'FAILED_SAFE', details: `Draft '${params.subject}' not found in Proton Drafts.` };
      }
    },
    {
      name: 'proton_send',
      description: 'Sends an email via Proton Mail Bridge SMTP (127.0.0.1:1025). CONSEQUENTIAL: requires owner confirmation.',
      effectClass: 'CONSEQUENTIAL',
      schema: z.object({
        to: z.string().describe('Recipient email address'),
        subject: z.string().describe('Email subject line'),
        body: z.string().describe('Email body text'),
        inReplyTo: z.string().optional().describe('Message-ID being replied to')
      }),
      ownerText: { kind: 'message', text: (p: any) => `${p.subject}\n\n${p.body}`, field: 'body' },
      execute: async (params) => {
        return protonClient.sendEmail(params);
      }
    }
  ];
}
