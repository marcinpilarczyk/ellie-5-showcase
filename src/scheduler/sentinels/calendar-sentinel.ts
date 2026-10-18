import crypto from 'node:crypto';
import { GoogleWorkspaceClient } from '../../integrations/google/client.js';
import { ModelRouter } from '../../models/model-router.js';
import { SlackClient } from '../../integrations/slack/client.js';
import { RoutineRepository } from '../../storage/routine-repo.js';
import { NudgeGate } from '../nudge-gate.js';

import { SentinelRunResult, SentinelRunStatus } from './gmail-sentinel.js';

function canPostSlack(slackClient?: SlackClient): slackClient is SlackClient {
  if (!slackClient) return false;
  if (typeof slackClient.isConfigured === 'function') return slackClient.isConfigured();
  return typeof slackClient.postMessage === 'function';
}

import { WaitingRepository } from '../../storage/waiting-repo.js';

export class CalendarSentinel {
  constructor(
    private readonly googleClient: GoogleWorkspaceClient,
    private readonly modelRouter: ModelRouter,
    private readonly routineRepo?: RoutineRepository,
    private readonly slackClient?: SlackClient,
    private readonly nudgeGate?: NudgeGate,
    private readonly waitingRepo?: WaitingRepository
  ) {}

  public async runCheck(): Promise<SentinelRunResult & { upcomingCount: number; briefedCount: number }> {
    if (this.routineRepo && !this.routineRepo.getSentinel('calendar_sentinel').is_active) {
      return { upcomingCount: 0, briefedCount: 0, processedCount: 0, draftsStagedCount: 0, cheapSkipped: true, status: 'off' };
    }

    if (!this.googleClient.isConnected()) {
      return { upcomingCount: 0, briefedCount: 0, processedCount: 0, draftsStagedCount: 0, cheapSkipped: true, status: 'not_connected' };
    }

    let events: any[] = [];
    try {
      const now = new Date();
      const endOfDay = new Date(now.getTime() + 18 * 60 * 60 * 1000);
      events = await this.googleClient.listCalendarEvents(now.toISOString(), endOfDay.toISOString(), 15);
    } catch (err: any) {
      return { upcomingCount: 0, briefedCount: 0, processedCount: 0, draftsStagedCount: 0, cheapSkipped: false, status: 'error', error: err.message };
    }

    // --- CHEAP DETECT (Calendar Event Diff Hash) ---
    const eventFingerprints = events.map(e => `${e.id || ''}:${e.start?.dateTime || e.start?.date || ''}:${e.summary || ''}`).sort();
    const currentHash = crypto.createHash('sha256').update(eventFingerprints.join('|')).digest('hex');

    let lastHash = '';
    let seenIds: string[] = [];
    if (this.routineRepo) {
      const record = this.routineRepo.getSentinel('calendar_sentinel');
      try {
        const state = JSON.parse(record.state_json || '{}');
        lastHash = state.eventsHash || '';
        const existingSeen = Array.isArray(state.seen_ids)
          ? state.seen_ids
          : (Array.isArray(state.notifiedEventIds) ? state.notifiedEventIds : []);
        seenIds = existingSeen.map(String);
      } catch {}
    }

    const seenSet = new Set(seenIds);
    const eventKey = (e: any): string => String(e.id || `${e.summary || 'event'}_${e.start?.dateTime || e.start?.date || ''}`);

    // Check if any event starts in less than 20 minutes and has not already been notified
    const nowMs = Date.now();
    const startingSoonEvents = events.filter(e => {
      const startIso = e.start?.dateTime || e.start?.date;
      if (!startIso) return false;
      const startMs = new Date(startIso).getTime();
      if (!(startMs > nowMs && startMs - nowMs <= 20 * 60 * 1000)) return false;
      return !seenSet.has(eventKey(e));
    });

    // If events have not changed and no un-notified event is starting soon, skip
    if (lastHash && currentHash && lastHash === currentHash && startingSoonEvents.length === 0) {
      if (this.routineRepo) {
        this.routineRepo.updateSentinelCheck(
          'calendar_sentinel',
          JSON.stringify({ eventsHash: currentHash, upcomingCount: events.length, seen_ids: seenIds })
        );
      }
      return { upcomingCount: events.length, briefedCount: 0, processedCount: 0, draftsStagedCount: 0, cheapSkipped: true, status: 'unchanged' };
    }

    let briefedCount = 0;
    const nextSeen = [...seenIds];
    for (const startingSoon of startingSoonEvents) {
      const key = eventKey(startingSoon);
      if (!seenSet.has(key)) {
        seenSet.add(key);
        nextSeen.push(key);
      }

      const summary = startingSoon.summary || 'Upcoming Meeting';
      let text = `📅 *Upcoming in <20 min:* ${summary}`;

      const bullets: string[] = [];

      // Chief-of-Staff context: check open loops with attendees or topic
      if (this.waitingRepo) {
        try {
          const activeItems = this.waitingRepo.list({ status: 'active' });
          const attendeesList: string[] = [];
          if (Array.isArray(startingSoon.attendees)) {
            for (const a of startingSoon.attendees) {
              if (a?.email) attendeesList.push(String(a.email).toLowerCase());
              if (a?.displayName) attendeesList.push(String(a.displayName).toLowerCase());
            }
          }
          const summaryWords = summary.toLowerCase().split(/\s+/).filter((w: string) => w.length >= 4);

          const matchingItems = activeItems.filter(item => {
            const cp = (item.counterparty || '').trim().toLowerCase();
            if (cp.length >= 3) {
              if (attendeesList.some(a => a.includes(cp))) return true;
              if (summary.toLowerCase().includes(cp)) return true;
            }
            const subjWords = item.subject.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
            return subjWords.some(w => summaryWords.includes(w));
          });

          for (const item of matchingItems.slice(0, 3)) {
            bullets.push(`• *Open loop:* Waiting on ${item.subject} (${item.status})`);
          }
        } catch (wErr: any) {
          console.warn('[CalendarSentinel] Error checking waiting context:', wErr.message);
        }
      }

      // External attendee recent thread context
      if (this.googleClient.isConnected() && typeof this.googleClient.searchEmails === 'function') {
        try {
          const externalAttendees: string[] = [];
          if (Array.isArray(startingSoon.attendees)) {
            for (const a of startingSoon.attendees) {
              const email = typeof a === 'string' ? a : a?.email;
              if (!email || typeof email !== 'string') continue;
              const normalized = email.trim().toLowerCase();
              if (!normalized.includes('@')) continue;
              if (a?.self) continue;
              if (startingSoon.organizer?.self && startingSoon.organizer?.email?.toLowerCase() === normalized) continue;
              if (normalized.includes('group.calendar.google.com') || normalized.includes('resource.calendar.google.com')) continue;
              if (process.env.ELLIE_OWNER_EMAIL && normalized === process.env.ELLIE_OWNER_EMAIL.trim().toLowerCase()) continue;
              externalAttendees.push(normalized);
            }
          }
          const firstExternal = externalAttendees[0];
          if (firstExternal) {
            const searchRes = await this.googleClient.searchEmails(`from:${firstExternal}`, 1);
            const recent = Array.isArray(searchRes) ? searchRes[0] : searchRes;
            if (recent && (recent.subject || recent.snippet)) {
              bullets.push(`• *Recent thread:* ${recent.subject || recent.snippet.slice(0, 80)}`);
            }
          }
        } catch (emailErr: any) {
          console.warn('[CalendarSentinel] Error checking recent email thread context:', emailErr.message);
        }
      }

      if (startingSoon.location && String(startingSoon.location).trim().length > 0) {
        bullets.push(`• *Location:* ${String(startingSoon.location).trim()}`);
      }

      if (bullets.length > 0) {
        text += `\n${bullets.join('\n')}`;
      }

      let canSend = true;
      if (this.nudgeGate) {
        const evalFn = typeof this.nudgeGate.evaluate === 'function'
          ? this.nudgeGate.evaluate.bind(this.nudgeGate)
          : this.nudgeGate.admit.bind(this.nudgeGate);
        const admission = evalFn({
          source: 'calendar_sentinel',
          priority: 'high',
          text,
          dedupeKey: `calendar_soon:${key}`
        });
        canSend = admission.decision.action === 'SEND';
      }

      if (canSend && canPostSlack(this.slackClient)) {
        await this.slackClient.postMessage({
          channel: this.slackClient.defaultChannel,
          text
        });
        briefedCount++;
      }
    }

    if (this.routineRepo) {
      this.routineRepo.updateSentinelCheck(
        'calendar_sentinel',
        JSON.stringify({
          eventsHash: currentHash,
          upcomingCount: events.length,
          seen_ids: nextSeen.slice(-200)
        })
      );
    }

    return { upcomingCount: events.length, briefedCount, processedCount: 0, draftsStagedCount: 0, cheapSkipped: false, status: 'checked' };
  }
}
