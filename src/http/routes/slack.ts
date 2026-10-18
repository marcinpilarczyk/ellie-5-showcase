import { Router, Request, Response } from 'express';
import { verifySlackSignature } from '../../integrations/slack/signature.js';
import { SlackCoworkerService } from '../../integrations/slack/coworker.js';

export function createSlackRouter(coworkerService: SlackCoworkerService): Router {
  const router = Router();
  const ownerId = process.env.SLACK_OWNER_USER_ID;
  const processedEventKeys = new Map<string, number>();

  // POST /api/slack/events
  router.post('/events', (req: Request, res: Response) => {
    // 1. Signature verification (Slack signs url_verification too)
    const sigResult = verifySlackSignature({
      timestamp: req.headers['x-slack-request-timestamp'],
      signature: req.headers['x-slack-signature'],
      rawBody: (req as any).rawBody || JSON.stringify(req.body)
    });

    if (!sigResult.valid) {
      res.status(401).send(`Invalid Slack signature: ${sigResult.reason}`);
      return;
    }

    // 2. URL verification challenge
    if (req.body?.type === 'url_verification') {
      res.json({ challenge: req.body.challenge });
      return;
    }

    // 3. Immediately acknowledge HTTP 200
    res.status(200).send('OK');

    const event = req.body?.event;
    // Only new messages or agent lifecycle events from a person. Edits, deletions and joins (including Ellie's own status
    // updates, which arrive as message_changed without a user) are not requests.
    const PERSON_SUBTYPES = new Set([undefined, 'file_share', 'thread_broadcast']);
    const effectiveUser = event?.user || event?.context?.user_id;
    if (!event || event.bot_id || !effectiveUser || !PERSON_SUBTYPES.has(event.subtype)) return;

    // 4. Owner only. Without SLACK_OWNER_USER_ID nobody is the owner (P11: fail closed).
    if (!ownerId || effectiveUser !== ownerId) {
      console.warn(`[SlackRouter] Ignored event from non-owner user '${effectiveUser}'`);
      return;
    }

    // 5. Deduplication: Slack sends both app_mention and message events for the same message in channels.
    const canonicalKey = event.client_msg_id
      ? `cmsg_${event.client_msg_id}`
      : (event.channel && event.ts ? `msg_${event.channel}_${event.ts}` : req.body?.event_id);

    if (canonicalKey) {
      const now = Date.now();
      const lastSeen = processedEventKeys.get(canonicalKey);
      if (lastSeen && (now - lastSeen) < 5 * 60 * 1000) {
        return;
      }
      processedEventKeys.set(canonicalKey, now);

      if (processedEventKeys.size > 1000) {
        for (const [k, t] of processedEventKeys) {
          if (now - t > 10 * 60 * 1000) processedEventKeys.delete(k);
        }
      }
    }

    // 6. Handle agent lifecycle & context events
    if (event.type === 'agent_session_stopped') {
      coworkerService.handleSessionStopped({
        channel: event.channel,
        thread_ts: event.thread_ts,
        user: effectiveUser
      }).catch(err => {
        console.error('[SlackRouter] Error handling agent_session_stopped:', err);
      });
      return;
    }

    if (event.type === 'app_home_opened') {
      coworkerService.handleAppHomeOpened({
        channel: event.channel,
        user: effectiveUser,
        tab: event.tab
      }).catch(err => {
        console.error('[SlackRouter] Error handling app_home_opened:', err);
      });
      return;
    }

    if (event.type === 'app_context_changed') {
      coworkerService.handleAppContextChanged({
        user: effectiveUser,
        context: event.context
      });
      return;
    }

    // 7. Handle message asynchronously
    if (event.type === 'message' || event.type === 'app_mention') {
      coworkerService.handleUserMessage({
        type: event.type,
        user: effectiveUser,
        text: event.text || '',
        ts: event.ts,
        thread_ts: event.thread_ts,
        channel: event.channel,
        files: event.files
      }).catch(err => {
        console.error('[SlackRouter] Error handling user message:', err);
      });
    }
  });

  // POST /api/slack/interactions
  router.post('/interactions', async (req: Request, res: Response) => {
    const sigResult = verifySlackSignature({
      timestamp: req.headers['x-slack-request-timestamp'],
      signature: req.headers['x-slack-signature'],
      rawBody: (req as any).rawBody
    });

    if (!sigResult.valid) {
      res.status(401).send(`Invalid Slack signature: ${sigResult.reason}`);
      return;
    }

    res.status(200).send('OK');

    let payload: any;
    try {
      payload = typeof req.body.payload === 'string' ? JSON.parse(req.body.payload) : req.body;
    } catch {
      return;
    }

    // Owner check (fail closed when unset)
    if (!ownerId || payload.user?.id !== ownerId) {
      console.warn(`[SlackRouter] Ignored interaction from non-owner user '${payload.user?.id}'`);
      return;
    }

    try {
      await coworkerService.handleButtonInteraction(payload);
    } catch (err: any) {
      console.error('[SlackRouter] Error handling button interaction:', err);
    }
  });

  return router;
}
