const ACTION_LABELS: Record<string, string> = {
  gmail_send: 'Email (Gmail)',
  proton_send: 'Email (Proton)',
  gmail_draft: 'Gmail draft',
  proton_draft: 'Proton draft',
  calendar_create: 'Calendar invite',
  composio_install_tool: 'Composio tool install',
  slack_post_message: 'Slack message'
};

const SLACK_PLAIN_TEXT_LIMIT = 2800;
const MAX_SLACK_APPROVAL_BODY = 45_000;

function completePayloadText(payload: Record<string, any>): string {
  const bodyField = ['body', 'text', 'content'].find(key => typeof payload[key] === 'string');
  if (!bodyField) return JSON.stringify(payload, null, 2);
  const metadata = { ...payload };
  const body = metadata[bodyField] as string;
  delete metadata[bodyField];
  const metadataText = Object.keys(metadata).length > 0 ? `${JSON.stringify(metadata, null, 2)}\n\n` : '';
  return `${metadataText}${body}`;
}

function plainTextSections(text: string): any[] {
  const sections: any[] = [];
  const characters = Array.from(text);
  for (let offset = 0; offset < characters.length; offset += SLACK_PLAIN_TEXT_LIMIT) {
    sections.push({
      type: 'section',
      text: {
        type: 'plain_text',
        text: characters.slice(offset, offset + SLACK_PLAIN_TEXT_LIMIT).join('')
      }
    });
  }
  return sections;
}

function quoteDetails(actionType: string, payload: Record<string, any>): { header: string; bodyText: string } {
  const label = ACTION_LABELS[actionType] || actionType || 'Action';
  if (actionType === 'composio_install_tool') {
    return {
      header: `${label} — needs your OK:`,
      bodyText: completePayloadText(payload)
    };
  }

  const subject = payload.subject ? `Subject: ${payload.subject}\n` : '';
  const to = payload.to
    ? `To: ${payload.to}\n`
    : (payload.channel
      ? `Channel: ${payload.channel}\n`
      : (payload.recipient ? `Recipient: ${payload.recipient}\n` : ''));
  return {
    header: `${label} — needs your OK:\n${to}${subject}`,
    bodyText: completePayloadText(payload)
  };
}

export function buildQuoteCardBlocks(actionId: string, actionType: string, payload: Record<string, any>): any[] {
  const quote = quoteDetails(actionType, payload);
  const visible = `${quote.header}${quote.bodyText}`;
  if (visible.length > MAX_SLACK_APPROVAL_BODY) {
    return [{
      type: 'section',
      text: {
        type: 'plain_text',
        text: `${quote.header}\nThis payload is too large to review safely in Slack (${visible.length} characters). Review it in the control plane before approving. (${actionId})`
      }
    }];
  }

  return [
    ...plainTextSections(visible),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Approve'
          },
          style: 'primary',
          action_id: 'approve_action',
          value: actionId
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Drop'
          },
          style: 'danger',
          action_id: 'drop_action',
          value: actionId
        }
      ]
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Action \`${actionId}\`. This card shows the complete payload that will execute.`
      }]
    }
  ];
}

export type SettledCardState =
  | 'APPROVED'
  | 'DENIED'
  | 'VERIFIED'
  | 'PROVIDER_CONFIRMED'
  | 'FAILED_SAFE'
  | 'RECONCILIATION_REQUIRED';

const SETTLED_LABELS: Record<SettledCardState, string> = {
  APPROVED: '✅ *Approved*',
  VERIFIED: '✅ *Done and verified*',
  PROVIDER_CONFIRMED: '☑️ *Done (provider confirmed, not read back)*',
  DENIED: '❌ *Dropped*',
  FAILED_SAFE: '⛔ *Not sent*',
  RECONCILIATION_REQUIRED: '⚠️ *Failed mid-send, check before retrying*'
};

export function buildSettledCardBlocks(
  actionId: string,
  actionType: string,
  state: SettledCardState,
  detail?: string,
  payload?: Record<string, any>
): any[] {
  const blocks: any[] = [];
  if (payload) {
    // Keep the complete payload visible so the thread shows what was actually approved.
    const quote = quoteDetails(actionType, payload);
    blocks.push(...plainTextSections(`${quote.header}${quote.bodyText}`));
  }
  const note = detail ? ` — ${detail.slice(0, 300)}` : '';
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `${SETTLED_LABELS[state]}${note} (\`${actionId}\`)`
      }
    ]
  });
  return blocks;
}
