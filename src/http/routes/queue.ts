import { Router, Request, Response } from 'express';
import { ActionLedgerRepository } from '../../storage/action-ledger.js';
import { MemoryRepository } from '../../storage/memory-repo.js';
import { ModelRouter } from '../../models/model-router.js';
import { extractCorrectionLesson } from '../../agent/correction-extractor.js';
import { executeApprovedAction } from '../../governance/executor.js';
import { ToolDispatcher } from '../../governance/dispatcher.js';
import { WaitingRepository } from '../../storage/waiting-repo.js';
import type { SlackCoworkerService } from '../../integrations/slack/coworker.js';

export function createQueueRouter(
  ledgerRepo: ActionLedgerRepository,
  dispatcher: ToolDispatcher,
  memoryRepo?: MemoryRepository,
  modelRouter?: ModelRouter,
  waitingRepo?: WaitingRepository,
  coworkerService?: SlackCoworkerService
): Router {
  const router = Router();

  // GET /api/queue - List staged actions
  router.get('/', (req: Request, res: Response) => {
    const batchId = typeof req.query.batch_id === 'string' ? req.query.batch_id : undefined;
    const actions = ledgerRepo.listStaged(batchId);
    const mapped = actions.map(a => {
      let payload = {};
      try { payload = JSON.parse(a.payload_json); } catch {}
      return {
        id: a.id,
        actionType: a.action_type,
        payload,
        state: a.state,
        batchId: a.batch_id,
        createdAt: a.created_at,
        expiresAt: a.expires_at,
        slackChannel: a.slack_channel,
        slackThreadTs: a.slack_thread_ts
      };
    });
    res.json({ ok: true, count: mapped.length, items: mapped });
  });

  // POST /api/queue/:id/approve - Approve and execute single action
  router.post('/:id/approve', async (req: Request, res: Response) => {
    const actionId = String(req.params['id']);
    const actor = (typeof req.body?.actor === 'string' && req.body.actor.trim()) ? req.body.actor.trim() : 'android_app';
    try {
      const outcome = await executeApprovedAction(actionId, { ledgerRepo, dispatcher, actor, waitingRepo });
      const current = ledgerRepo.get(actionId);
      if (outcome.ok && current?.action_type === 'composio_install_tool' && coworkerService) {
        let parsedPayload: Record<string, any> | undefined;
        try { parsedPayload = JSON.parse(current.payload_json); } catch {}
        await coworkerService.handlePostApprovedInstall(current, parsedPayload, outcome);
      }
      res.json(outcome);
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/queue/:id/drop - Drop/deny single action
  router.post('/:id/drop', (req: Request, res: Response) => {
    const actionId = String(req.params['id']);
    const actor = (typeof req.body?.actor === 'string' && req.body.actor.trim()) ? req.body.actor.trim() : 'android_app';
    const reason = (typeof req.body?.reason === 'string' && req.body.reason.trim()) ? req.body.reason.trim() : 'Dropped from the control plane';
    try {
      const denied = ledgerRepo.denyAction(actionId, actor, reason);
      if (memoryRepo && denied?.action_type && typeof memoryRepo.recordNegativeEvidence === 'function') {
        memoryRepo.recordNegativeEvidence(denied.action_type);
      }
      res.json({ ok: true, action: denied });
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // PUT /api/queue/:id - Inline edit staged payload (extracts style/tone lessons)
  router.put('/:id', async (req: Request, res: Response) => {
    const actionId = String(req.params['id']);
    const actor = (typeof req.body?.actor === 'string' && req.body.actor.trim()) ? req.body.actor.trim() : 'android_app';
    const bodyObj = req.body;

    if (!bodyObj || typeof bodyObj !== 'object') {
      res.status(400).json({ ok: false, error: 'Expected JSON payload object' });
      return;
    }

    const updatedPayload = bodyObj.payload && typeof bodyObj.payload === 'object' ? bodyObj.payload : { ...bodyObj };
    if ('actor' in updatedPayload && bodyObj.payload === undefined) {
      delete updatedPayload.actor;
    }

    try {
      const existing = ledgerRepo.get(actionId);
      if (!existing) {
        res.status(404).json({ ok: false, error: 'Action not found' });
        return;
      }

      let oldPayload: any = {};
      try { oldPayload = JSON.parse(existing.payload_json); } catch {}

      // Update in ledger
      const updated = ledgerRepo.updateStagedPayload(actionId, updatedPayload, actor);

      // Extract and record style/tone preferences instead of raw body dumps
      if (memoryRepo) {
        const hasChanges = Object.keys(updatedPayload).some(
          k => JSON.stringify(oldPayload[k]) !== JSON.stringify(updatedPayload[k])
        );

        if (hasChanges) {
          try {
            const lesson = await extractCorrectionLesson(modelRouter, {
              actionType: existing.action_type,
              oldPayload,
              newPayload: updatedPayload
            });

            if (lesson) {
              const existingFacts = memoryRepo.searchFacts(lesson);
              const alreadyExists = existingFacts.some(f => f.statement.toLowerCase() === lesson.toLowerCase());
              if (!alreadyExists) {
                const addedFact = memoryRepo.addFact(lesson, 'preferences', 'PREFERENCE', 0.9, 'correction');
                if (addedFact && typeof memoryRepo.recordRrsiProposal === 'function') {
                  memoryRepo.recordRrsiProposal({
                    componentType: 'memory_fact',
                    targetId: addedFact.id,
                    hypothesis: `${actor} correction on ${existing.action_type}`,
                    diffText: lesson,
                    accepted: true
                  });
                }
              }
            }
          } catch (err: any) {
            console.warn('[QueueRouter] Failed to extract correction lesson:', err.message);
          }
        }
      }

      res.json({ ok: true, action: updated });
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // POST /api/queue/batch/approve-all - Batch approve
  router.post('/batch/approve-all', async (req: Request, res: Response) => {
    const batchId = req.body?.batch_id;
    const actor = (typeof req.body?.actor === 'string' && req.body.actor.trim()) ? req.body.actor.trim() : 'android_app';
    const actions = ledgerRepo.listStaged(batchId);
    const results = [];

    for (const a of actions) {
      try {
        const out = await executeApprovedAction(a.id, { ledgerRepo, dispatcher, actor });
        results.push({ id: a.id, outcome: out });
      } catch (err: any) {
        results.push({ id: a.id, error: err.message });
      }
    }

    res.json({ ok: true, processedCount: results.length, results });
  });

  // POST /api/queue/batch/drop-all - Batch drop
  router.post('/batch/drop-all', (req: Request, res: Response) => {
    const batchId = req.body?.batch_id;
    const actor = (typeof req.body?.actor === 'string' && req.body.actor.trim()) ? req.body.actor.trim() : 'android_app';
    const reason = (typeof req.body?.reason === 'string' && req.body.reason.trim()) ? req.body.reason.trim() : 'Batch dropped from the control plane';
    const actions = ledgerRepo.listStaged(batchId);
    for (const a of actions) {
      try {
        ledgerRepo.denyAction(a.id, actor, reason);
      } catch {}
    }
    res.json({ ok: true, droppedCount: actions.length });
  });

  return router;
}
