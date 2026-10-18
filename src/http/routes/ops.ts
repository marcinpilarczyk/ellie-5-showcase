import { Router, Request, Response } from 'express';
import { RoutineRepository, formatCronSchedule } from '../../storage/routine-repo.js';
import { RunTraceStore } from '../../storage/run-trace-store.js';
import { CostRepository } from '../../storage/cost-repo.js';
import { RoutineWorker } from '../../scheduler/routine-worker.js';
import { GmailSentinel } from '../../scheduler/sentinels/gmail-sentinel.js';
import { CalendarSentinel } from '../../scheduler/sentinels/calendar-sentinel.js';
import { ProtonSentinel } from '../../scheduler/sentinels/proton-sentinel.js';
import type { GoogleWorkspaceClient } from '../../integrations/google/client.js';
import type { SlackClient } from '../../integrations/slack/client.js';
import type { ProtonMailClient } from '../../integrations/proton/client.js';
import type { ModelRouter } from '../../models/model-router.js';
import type { ActionLedgerRepository } from '../../storage/action-ledger.js';

export function createOpsRouter(
  routineRepo: RoutineRepository,
  runTraceStore: RunTraceStore,
  costRepo: CostRepository,
  routineWorker?: RoutineWorker,
  gmailSentinel?: GmailSentinel,
  calendarSentinel?: CalendarSentinel,
  protonSentinel?: ProtonSentinel,
  googleClient?: GoogleWorkspaceClient,
  slackClient?: SlackClient,
  protonClient?: ProtonMailClient,
  modelRouter?: ModelRouter,
  ledgerRepo?: ActionLedgerRepository
): Router {
  const router = Router();

  // GET /api/ops/status - Live Integration & Governance Status
  router.get('/status', (_req: Request, res: Response) => {
    const activeRoutines = routineRepo.getAllRoutines().filter(r => r.is_active === 1);
    const sentinels = routineRepo.listSentinels();
    const stagedQueue = ledgerRepo ? ledgerRepo.listStaged() : [];

    res.json({
      ok: true,
      googleConnected: Boolean(googleClient?.isConnected()),
      slackConfigured: Boolean(slackClient?.isConfigured()),
      protonConfigured: Boolean(protonClient?.isEnabled()),
      flashModel: modelRouter?.flashModel || '',
      reasoningModel: modelRouter?.reasoningModel || '',
      activeRoutinesCount: activeRoutines.length,
      sentinelsCount: sentinels.length,
      stagedQueueCount: stagedQueue.length,
      timestamp: new Date().toISOString()
    });
  });

  // --- Routines Management, Kill Switches & Run Now ---

  router.get('/routines', (_req: Request, res: Response) => {
    const rawRoutines = routineRepo.getAllRoutines();
    const mapped = rawRoutines.map(r => ({
      ...r,
      cadence_description: r.cadence_description || formatCronSchedule(r.cron_schedule),
      destination: r.destination || 'Slack'
    }));
    res.json({ ok: true, routines: mapped });
  });

  router.post('/routines/:id/toggle', (req: Request, res: Response) => {
    const routineId = String(req.params['id']);
    const r = routineRepo.getRoutine(routineId);
    if (!r) {
      res.status(404).json({ ok: false, error: 'Routine not found' });
      return;
    }
    const newActive = r.is_active === 1 ? false : true;
    routineRepo.setRoutineActive(routineId, newActive);
    res.json({ ok: true, id: routineId, isActive: newActive });
  });

  router.put('/routines/:id', (req: Request, res: Response) => {
    const routineId = String(req.params['id']);
    const { title, description, cron_schedule, destination, is_active } = req.body;
    const updated = routineRepo.updateRoutine(routineId, {
      title,
      description,
      cron_schedule,
      destination,
      is_active
    });
    if (!updated) {
      res.status(404).json({ ok: false, error: 'Routine not found' });
      return;
    }
    res.json({ ok: true, routine: updated });
  });

  router.delete('/routines/:id', (req: Request, res: Response) => {
    const routineId = String(req.params['id']);
    const deleted = routineRepo.deleteRoutine(routineId);
    if (!deleted) {
      res.status(404).json({ ok: false, error: 'Routine not found' });
      return;
    }
    res.json({ ok: true, id: routineId, deleted: true });
  });

  router.post('/routines/:id/run', async (req: Request, res: Response) => {
    const routineId = String(req.params['id']);
    if (!routineWorker) {
      res.status(503).json({ ok: false, error: 'RoutineWorker not initialized' });
      return;
    }
    // Routines can take minutes; start it and let the result arrive in Slack
    const started = routineWorker.startRoutineNow(routineId);
    if (!started.started) {
      res.status(started.alreadyRunning ? 409 : 404).json({ ok: false, alreadyRunning: Boolean(started.alreadyRunning), error: started.error });
      return;
    }
    res.status(202).json({ ok: true, started: true, message: 'Routine started. The result will be posted to Slack when it finishes.' });
  });

  // --- Sentinels Kill Switches & Run Now ---

  router.get('/sentinels', (_req: Request, res: Response) => {
    res.json({ ok: true, sentinels: routineRepo.listSentinels() });
  });

  router.post('/sentinels/:id/toggle', (req: Request, res: Response) => {
    const sentinelId = String(req.params['id']);
    const s = routineRepo.getSentinel(sentinelId);
    const newActive = s.is_active === 1 ? false : true;
    routineRepo.setSentinelActive(sentinelId, newActive);
    res.json({ ok: true, id: sentinelId, isActive: newActive });
  });

  router.post('/sentinels/:id/run', async (req: Request, res: Response) => {
    const id = String(req.params['id']);
    try {
      let report: any = {};
      if (id === 'gmail_sentinel' && gmailSentinel) {
        report = await gmailSentinel.runCheck();
      } else if (id === 'calendar_sentinel' && calendarSentinel) {
        report = await calendarSentinel.runCheck();
      } else if (id === 'proton_sentinel' && protonSentinel) {
        report = await protonSentinel.runCheck();
      } else {
        res.status(404).json({ ok: false, error: `Unknown or unconfigured sentinel '${id}'` });
        return;
      }
      res.json({ ok: true, sentinel: id, report });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // --- Glass-Box Run Trace Inspector ---

  router.get('/traces', (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string || '50', 10);
    const traces = runTraceStore.listTraces(limit);
    const mapped = traces.map(t => {
      let toolsCalled = [];
      let handlesUsed = [];
      try { toolsCalled = JSON.parse(t.tools_called); } catch {}
      try { handlesUsed = JSON.parse(t.handles_used); } catch {}
      return {
        ...t,
        toolsCalled,
        handlesUsed
      };
    });
    res.json({ ok: true, count: mapped.length, traces: mapped });
  });

  // --- Cost Telemetry ---

  router.get('/costs', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      summary: costRepo.getSummary(7),
      breakdown: costRepo.getBreakdown(7)
    });
  });

  return router;
}
