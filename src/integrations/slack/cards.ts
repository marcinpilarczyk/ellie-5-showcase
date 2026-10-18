const ACTION_LABELS: Record<string, string> = {
  gmail_send: 'Email (Gmail)',
  proton_send: 'Email (Proton)',
  gmail_draft: 'Gmail draft',
  proton_draft: 'Proton draft',
  calendar_create: 'Calendar invite',
  composio_install_tool: 'Composio tool install',
  slack_post_message: 'Slack message'
};

function quoteSection(actionType: string, payload: Record<string, any>): any {
  if (actionType === 'composio_install_tool') {
    const slug = payload.toolSlug || 'Unknown tool';
    const toolkit = payload.toolkitSlug ? ` (${payload.toolkitSlug})` : '';
    const auth = payload.authMode ? `\n*Auth:* ${payload.authMode}` : '';
    const reason = payload.reason ? `\n> *Why:* ${payload.reason}` : '';
    const task = payload.pendingTask ? `\n> *Task to finish:* ${payload.pendingTask}` : '';
    return {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Composio tool install — needs your OK:*\n*Tool:* \`${slug}\`${toolkit}${auth}${reason}${task}`
      }
    };
  }

  const subject = payload.subject ? `*Subject:* ${payload.subject}\n` : '';
  const to = payload.to
    ? `*To:* ${payload.to}\n`
    : (payload.channel
      ? `*Channel:* <#${payload.channel}>\n`
      : (payload.recipient ? `*Recipient:* ${payload.recipient}\n` : ''));
  const bodyText = payload.body || payload.text || payload.content || JSON.stringify(payload, null, 2);
  const truncatedBody = bodyText.length > 600 ? bodyText.slice(0, 597) + '...' : bodyText;
  const label = ACTION_LABELS[actionType] || actionType || 'Action';

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*${label} — needs your OK:*\n${to}${subject}> ${truncatedBody.split('\n').join('\n> ')}`
    }
  };
}

export function buildQuoteCardBlocks(actionId: string, actionType: string, payload: Record<string, any>): any[] {
  return [
    quoteSection(actionType, payload),
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
    // Keep the quote visible so the thread shows what was actually approved
    blocks.push(quoteSection(actionType, payload));
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
