import { DatabaseManager } from '../storage/database.js';
import { initializeAppDatabase, initializeLedgerDatabase } from '../storage/schema.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { ResultStore } from '../storage/result-store.js';
import { AuthoredResources } from '../storage/authored-resources.js';
import { RunTraceStore } from '../storage/run-trace-store.js';
import { CostRepository } from '../storage/cost-repo.js';
import { MemoryRepository } from '../storage/memory-repo.js';
import { RoutineRepository } from '../storage/routine-repo.js';
import { ThreadCarryoverRepository } from '../storage/thread-carryover-repo.js';
import { WorkspaceAliasRepository } from '../storage/workspace-alias-repo.js';
import { ToolDispatcher } from '../governance/dispatcher.js';
import { executeApprovedAction } from '../governance/executor.js';
import { ClaimsBankGuard } from '../governance/claims-bank.js';
import { ModelRouter } from '../models/model-router.js';
import { UnifiedAgentRunner } from '../agent/runner.js';
import { GoogleWorkspaceClient } from '../integrations/google/client.js';
import { SlackClient } from '../integrations/slack/client.js';
import { SlackCoworkerService } from '../integrations/slack/coworker.js';
import { ProtonMailClient } from '../integrations/proton/client.js';
import { GmailSentinel } from '../scheduler/sentinels/gmail-sentinel.js';
import { CalendarSentinel } from '../scheduler/sentinels/calendar-sentinel.js';
import { ProtonSentinel } from '../scheduler/sentinels/proton-sentinel.js';
import { RoutineWorker } from '../scheduler/routine-worker.js';
import { ReminderDispatcher } from '../scheduler/reminders.js';
import { NudgeGate } from '../scheduler/nudge-gate.js';
import { OwnerConfigLoader } from '../config/owner.js';
import { ToolDefinition } from '../types/tool.js';
import { createGoogleTools } from '../tools/google-tools.js';
import { createProtonTools } from '../tools/proton-tools.js';
import { createOwnerSourceTools, OwnerSources, OWNER_PROJECTS_FOLDER } from '../tools/owner-source-tools.js';
import { createDocumentTools } from '../tools/document-tools.js';
import { libreOfficeEngine, pdfToolsInstalled } from '../documents/pdf.js';
import { createVisualCheck } from '../documents/visual-check.js';
import { findHeadlessBrowser, renderHtmlToPdfWithBrowser } from '../documents/render-html-pdf.js';
import { createOwnerTextCheckTool } from '../tools/owner-text-check-tool.js';
import { OwnerInventory, RefreshSummary } from '../storage/owner-inventory.js';
import { createMemoryTools } from '../tools/memory-tools.js';
import { createResultReadTool, createSheetQueryTool } from '../tools/result-tools.js';
import { createSkillTools } from '../tools/skill-tools.js';
import { createJobEvaluationTools } from '../tools/job-evaluate-tool.js';
import { createWebTools } from '../tools/web-tools.js';
import { createApifyTools, createMcpGatewayTools } from '../tools/social-tools.js';
import { createSlackTools } from '../tools/slack-tools.js';
import { createSelfDiagnosisTools } from '../tools/self-diagnosis.js';
import { createWorkspaceAliasTools } from '../tools/workspace-alias-tools.js';
import { createRoutineTools } from '../tools/routine-tools.js';
import { createReminderTools } from '../tools/reminder-tools.js';
import { createNudgeTools } from '../tools/nudge-tools.js';
import { createQueueManageTools } from '../tools/queue-manage-tools.js';
import { createSentinelManageTools } from '../tools/sentinel-manage-tools.js';
import { createCostManageTools } from '../tools/cost-manage-tools.js';
import { WaitingRepository } from '../storage/waiting-repo.js';
import { createWaitingTools } from '../tools/waiting-tools.js';
import { SpaceRepository } from '../storage/space-repo.js';
import { createSpaceTools } from '../tools/space-tools.js';
import { createProjectStateTools, createGoogleProjectStateAdapter } from '../tools/project-state-tools.js';
import { createSubtaskTools } from '../tools/subtask-tool.js';
import { ComposioRepository } from '../storage/composio-repo.js';
import { ComposioClient } from '../integrations/composio/client.js';
import { createComposioTools } from '../tools/composio-tools.js';
import { createImageTools } from '../tools/image-tools.js';

export interface RuntimeOptions {
  dataDir?: string;
  appDbPath?: string;
  ledgerDbPath?: string;
  composioClient?: ComposioClient;
}

export interface Runtime {
  dbManager: DatabaseManager;
  ledgerRepo: ActionLedgerRepository;
  resultStore: ResultStore;
  runTraceStore: RunTraceStore;
  costRepo: CostRepository;
  memoryRepo: MemoryRepository;
  routineRepo: RoutineRepository;
  aliasRepo: WorkspaceAliasRepository;
  waitingRepo: WaitingRepository;
  spaceRepo: SpaceRepository;
  composioRepo: ComposioRepository;
  composioClient: ComposioClient;
  nudgeGate: NudgeGate;
  dispatcher: ToolDispatcher;
  claimsGuard: ClaimsBankGuard;
  modelRouter: ModelRouter;
  runner: UnifiedAgentRunner;
  googleClient: GoogleWorkspaceClient;
  slackClient: SlackClient;
  coworkerService: SlackCoworkerService;
  protonClient: ProtonMailClient;
  gmailSentinel: GmailSentinel;
  calendarSentinel: CalendarSentinel;
  protonSentinel: ProtonSentinel;
  routineWorker: RoutineWorker;
  reminderDispatcher: ReminderDispatcher;
  ownerConfigLoader?: OwnerConfigLoader;
  ownerSources: OwnerSources;
  ownerInventory: OwnerInventory;
  /** Nightly: describes new and changed owner Docs and drops removed ones. */
  refreshOwnerInventory: () => Promise<RefreshSummary>;
}

/** The single composition root: the web server, the wake worker and `doctor` all call this. */
export function buildRuntime(options?: RuntimeOptions): Runtime {
  // 1. Databases (versioned migrations; refuses a database Ellie did not create)
  const dbManager = new DatabaseManager(options);
  const appDb = dbManager.getAppDb();
  const ledgerDb = dbManager.getLedgerDb();
  initializeAppDatabase(appDb);
  initializeLedgerDatabase(ledgerDb);

  // 2. Storage
  const ledgerRepo = new ActionLedgerRepository(ledgerDb);
  const resultStore = new ResultStore(appDb);
  const runTraceStore = new RunTraceStore(appDb);
  const costRepo = new CostRepository(appDb);
  const memoryRepo = new MemoryRepository(appDb);
  const routineRepo = new RoutineRepository(appDb);
  const aliasRepo = new WorkspaceAliasRepository(appDb);
  aliasRepo.seedFromEnv();
  const waitingRepo = new WaitingRepository(appDb);
  const spaceRepo = new SpaceRepository(appDb, options?.dataDir ? `${options.dataDir}/spaces` : undefined);
  const composioRepo = new ComposioRepository(appDb);

  // 3. Governance core and clients
  const googleClient = new GoogleWorkspaceClient(appDb);
  const slackClient = new SlackClient();
  const protonClient = new ProtonMailClient({}, appDb);
  const composioClient = options?.composioClient ?? new ComposioClient();
  const nudgeGate = new NudgeGate(appDb);
  const reminderDispatcher = new ReminderDispatcher(appDb, slackClient, nudgeGate);
  const modelRouter = new ModelRouter(costRepo);

  // The owner's working Docs: the loose Docs in the config Doc's folder and everything under its
  // Projects folder, plus the record and Claims Bank. Other subfolders (archives, run receipts,
  // exports) hold old or machine-written text and must not ground claims.
  const ownerFolderId = async () => {
    const configId = aliasRepo.getAlias('config_doc')?.resource_id;
    return configId ? googleClient.getParentFolderId(configId) : undefined;
  };
  const ownerSources = new OwnerSources({
    folderId: ownerFolderId,
    listDocs: folderId => googleClient.listFolderDocs(folderId, (name, depth) => depth > 0 || name === OWNER_PROJECTS_FOLDER),
    readDoc: id => googleClient.readDoc(id),
    linkedDocIds: () => ['professional_record_doc', 'claims_bank_doc']
      .map(key => aliasRepo.getAlias(key)?.resource_id)
      .filter((id): id is string => Boolean(id))
  }, undefined, appDb);

  // Claims Bank: the only specifics outreach may assert (doc from alias or .env)
  const claimsGuard = new ClaimsBankGuard(async () => {
    const docId = aliasRepo.resolveId('claims_bank_doc') || process.env.ELLIE_CLAIMS_BANK_DOC_ID?.trim();
    if (!docId) return '';
    try {
      return await googleClient.readDoc(docId);
    } catch {
      return '';
    }
  }, undefined, async () => {
    // Identity details (contact data, links, years, titles) may only come from the owner's own Docs.
    return ownerSources.allTexts();
  });

  // Every tool that declares owner text is checked here, before it writes or stages anything.
  const dispatcher = new ToolDispatcher(ledgerRepo, resultStore, claimsGuard, new AuthoredResources(appDb));
  const register = (tools: ToolDefinition[]) => tools.forEach(t => dispatcher.registerTool(t));

  // 4. Work tools
  register(createGoogleTools(googleClient));
  register(createProtonTools(protonClient));
  register(createOwnerSourceTools(ownerSources));
  // Formatted documents go to a folder inside the owner's folder.
  const browserBin = findHeadlessBrowser();
  const htmlPdf = browserBin
    ? async (html: Buffer) => renderHtmlToPdfWithBrowser(html.toString('utf8'), browserBin)
    : undefined;

  register(createDocumentTools({
    ownerFolderId,
    ensureFolder: (rootId, path) => googleClient.ensureFolderPath(rootId, path),
    upload: (name, mimeType, data, parentId) => googleClient.uploadFile(name, mimeType, data, parentId),
    download: fileId => googleClient.downloadFile(fileId),
    pdf: pdfToolsInstalled() ? libreOfficeEngine : undefined,
    htmlPdf,
    visualCheck: createVisualCheck(modelRouter)
  }));
  register([createOwnerTextCheckTool(claimsGuard)]);
  register(createMemoryTools(memoryRepo, reminderDispatcher));
  register([createResultReadTool(resultStore), createSheetQueryTool(resultStore)]);
  register(createWaitingTools(waitingRepo));
  register(createSpaceTools(spaceRepo));
  register(createProjectStateTools(createGoogleProjectStateAdapter(googleClient, ownerFolderId)));
  register(createSkillTools());
  register(createJobEvaluationTools(modelRouter, ownerSources));
  register(createWebTools(modelRouter));
  register(createApifyTools(costRepo));
  register(createMcpGatewayTools());
  register(createComposioTools({ client: composioClient, repo: composioRepo, dispatcher }));
  register(createSlackTools(slackClient));
  register(createSelfDiagnosisTools({ appDb, ledgerDb, resultStore, runTraceStore, ledgerRepo }));

  const uploadImageToDrive = googleClient.isConfigured()
    ? async (name: string, mimeType: string, data: Buffer) => {
        const root = await ownerFolderId();
        if (!root) throw new Error("No owner folder configured");
        const parentId = await googleClient.ensureFolderPath(root, 'Images');
        return googleClient.uploadFile(name, mimeType, data, parentId);
      }
    : undefined;
  register(createImageTools({
    modelRouter,
    slackClient,
    uploadToDrive: uploadImageToDrive
  }));

  // 5. Owner config Docs (cached in SQLite)
  const configDocId = aliasRepo.resolveId('config_doc') || process.env.ELLIE_OWNER_CONFIG_DOC_ID?.trim();
  const profRecordDocId = aliasRepo.resolveId('professional_record_doc') || process.env.ELLIE_PROFESSIONAL_RECORD_DOC_ID?.trim();
  const ownerConfigLoader = new OwnerConfigLoader(
    appDb,
    googleClient.isConfigured() ? (id: string) => googleClient.readDoc(id) : undefined,
    configDocId,
    profRecordDocId
  );

  // 6. Runner and Slack
  const ownerInventory = new OwnerInventory(appDb);
  const runner = new UnifiedAgentRunner(
    modelRouter,
    dispatcher,
    memoryRepo,
    runTraceStore,
    ownerInventory,
    ownerConfigLoader
  );
  register(createSubtaskTools(runner, resultStore));
  const refreshOwnerInventory = async (): Promise<RefreshSummary> => {
    const { docs } = await ownerSources.documents();
    return ownerInventory.refresh(docs, async (title, folder, text) => {
      const resp = await modelRouter.generate(
        `In one plain sentence of at most 25 words, say what this document is for and what it holds, so an assistant can tell when to read it. No preamble.

Title: ${title}
Folder: ${folder}

${text.slice(0, 8000)}`,
        { tier: 'SENTINEL', temperature: 0, source: 'owner_inventory' }
      );
      return resp.text;
    });
  };
  const coworkerService = new SlackCoworkerService(
    slackClient,
    ledgerRepo,
    runner,
    undefined,
    (actionId, actor) => executeApprovedAction(actionId, { ledgerRepo, dispatcher, actor, waitingRepo }),
    new ThreadCarryoverRepository(appDb, resultStore),
    runTraceStore,
    memoryRepo,
    resultStore
  );

  // 7. Scheduled work
  const gmailSentinel = new GmailSentinel(googleClient, modelRouter, ledgerRepo, routineRepo, slackClient, nudgeGate, claimsGuard, waitingRepo);
  const calendarSentinel = new CalendarSentinel(googleClient, modelRouter, routineRepo, slackClient, nudgeGate, waitingRepo);
  const protonSentinel = new ProtonSentinel(protonClient, modelRouter, ledgerRepo, routineRepo, slackClient, nudgeGate, claimsGuard, waitingRepo);
  const routineWorker = new RoutineWorker(routineRepo, runner, ledgerRepo, coworkerService);

  // Pre-flight diff hook: check Google Drive file modifiedTime before spinning up an LLM run for silence-allowed routines
  routineWorker.setPreFlightHook(async (routine) => {
    // Look for explicit Google Drive or Docs IDs in routine constraints/rules/description
    const combinedText = `${routine.description || ''} ${routine.hard_constraints || ''} ${routine.rules || ''}`;
    // Google Doc/Drive IDs are 25-60 character alphanumeric strings (letters, digits, dashes, underscores)
    const docIdMatches = combinedText.match(/(?:document\/d\/|drive\/folders\/|id[=:]\s*['"]?)([a-zA-Z0-9_-]{25,})/g);
    if (!docIdMatches || docIdMatches.length === 0 || !googleClient.isConnected()) {
      return { canSkip: false };
    }

    try {
      const lastRunMs = routine.last_run_at ? new Date(routine.last_run_at).getTime() : 0;
      if (!lastRunMs) return { canSkip: false };

      for (const m of docIdMatches) {
        const id = m.replace(/^(?:document\/d\/|drive\/folders\/|id[=:]\s*['"]?)/, '');
        const meta = await googleClient.getDriveFileMeta(id);
        if (meta?.modifiedTime) {
          const modMs = new Date(meta.modifiedTime).getTime();
          if (modMs > lastRunMs) {
            // File was modified since last run; run routine
            return { canSkip: false };
          }
        }
      }
      return { canSkip: true, reason: 'Watched Drive resources have not changed since last run' };
    } catch {
      // On any Drive API error or permission check, fall back to normal execution
      return { canSkip: false };
    }
  });

  // 8. Command & Control tools (owner-only, interactive Slack)
  register(createRoutineTools(routineRepo, routineWorker, dispatcher));
  register(createReminderTools(reminderDispatcher));
  register(createNudgeTools(nudgeGate, slackClient));
  register(createQueueManageTools(ledgerRepo, memoryRepo));
  register(createWorkspaceAliasTools(aliasRepo));
  register(createSentinelManageTools(routineRepo, gmailSentinel, calendarSentinel, protonSentinel));
  register(createCostManageTools(costRepo));

  return {
    dbManager,
    ledgerRepo,
    resultStore,
    runTraceStore,
    costRepo,
    memoryRepo,
    routineRepo,
    aliasRepo,
    waitingRepo,
    spaceRepo,
    composioRepo,
    composioClient,
    nudgeGate,
    dispatcher,
    claimsGuard,
    ownerSources,
    ownerInventory,
    refreshOwnerInventory,
    modelRouter,
    runner,
    googleClient,
    slackClient,
    coworkerService,
    protonClient,
    gmailSentinel,
    calendarSentinel,
    protonSentinel,
    routineWorker,
    reminderDispatcher,
    ownerConfigLoader
  };
}
