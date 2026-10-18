import fs from 'node:fs';
import path from 'node:path';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  AlignmentType,
  ImageRun,
  ShadingType
} from 'docx';

const FONT_SANS = 'Google Sans Text';

// Color Palette
const COLOR_PRIMARY = '1A73E8';    // Google Blue
const COLOR_SECONDARY = '174EA6';  // Deep Blue
const COLOR_TEXT = '202124';       // Dark Grey
const COLOR_MUTED = '5F6368';      // Muted Grey
const COLOR_BG_LIGHT = 'F8F9FA';   // Light Card Background
const COLOR_BORDER = 'DADCE0';     // Border Grey
const COLOR_ACCENT_BG = 'E8F0FE';  // Accent Light Blue

function run(text, options = {}) {
  return new TextRun({
    text,
    font: FONT_SANS,
    size: options.size || 22, // 11pt default
    color: options.color || COLOR_TEXT,
    bold: options.bold || false,
    italics: options.italics || false
  });
}

function title(text) {
  return new Paragraph({
    spacing: { before: 200, after: 120 },
    alignment: AlignmentType.LEFT,
    children: [
      new TextRun({
        text,
        font: FONT_SANS,
        size: 52, // 26pt
        bold: true,
        color: COLOR_SECONDARY
      })
    ]
  });
}

function subtitle(text) {
  return new Paragraph({
    spacing: { after: 280 },
    children: [
      new TextRun({
        text,
        font: FONT_SANS,
        size: 24, // 12pt
        italics: true,
        color: COLOR_MUTED
      })
    ]
  });
}

function calloutBox(text, boldPrefix = '') {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.NONE },
      bottom: { style: BorderStyle.NONE },
      right: { style: BorderStyle.NONE },
      left: { style: BorderStyle.SINGLE, size: 24, color: COLOR_PRIMARY }
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { type: ShadingType.CLEAR, fill: COLOR_ACCENT_BG },
            margins: { top: 140, bottom: 140, left: 180, right: 180 },
            children: [
              new Paragraph({
                spacing: { line: 280 },
                children: [
                  boldPrefix ? new TextRun({ text: boldPrefix + ' ', font: FONT_SANS, size: 22, bold: true, color: COLOR_SECONDARY }) : new TextRun(''),
                  new TextRun({ text, font: FONT_SANS, size: 22, color: COLOR_TEXT, italics: true })
                ]
              })
            ]
          })
        ]
      })
    ]
  });
}

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 140 },
    children: [
      new TextRun({
        text,
        font: FONT_SANS,
        size: 34, // 17pt
        bold: true,
        color: COLOR_PRIMARY
      })
    ]
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 100 },
    children: [
      new TextRun({
        text,
        font: FONT_SANS,
        size: 26, // 13pt
        bold: true,
        color: COLOR_SECONDARY
      })
    ]
  });
}

function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 180, after: 80 },
    children: [
      new TextRun({
        text,
        font: FONT_SANS,
        size: 23, // 11.5pt
        bold: true,
        color: COLOR_TEXT
      })
    ]
  });
}

function p(text, boldPrefix = '') {
  const children = [];
  if (boldPrefix) {
    children.push(run(boldPrefix + ' ', { bold: true, color: COLOR_SECONDARY }));
  }
  children.push(run(text));
  return new Paragraph({
    spacing: { before: 60, after: 120, line: 280 },
    children
  });
}

function bullet(text, boldPrefix = '') {
  const children = [];
  if (boldPrefix) {
    children.push(run(boldPrefix + ' ', { bold: true, color: COLOR_SECONDARY }));
  }
  children.push(run(text));
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { before: 40, after: 60, line: 260 },
    children
  });
}

function imageParagraph(imagePath, width = 560, height = 300) {
  const imgBuffer = fs.readFileSync(imagePath);
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 160, after: 160 },
    children: [
      new ImageRun({
        data: imgBuffer,
        transformation: {
          width,
          height
        }
      })
    ]
  });
}

function createTable(headers, rows) {
  const borderStyle = { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER };
  const borders = {
    top: borderStyle,
    bottom: borderStyle,
    left: borderStyle,
    right: borderStyle,
    insideHorizontal: borderStyle,
    insideVertical: borderStyle
  };

  const headerRow = new TableRow({
    children: headers.map(h => new TableCell({
      shading: { type: ShadingType.CLEAR, fill: COLOR_ACCENT_BG },
      margins: { top: 100, bottom: 100, left: 140, right: 140 },
      children: [
        new Paragraph({
          children: [run(h, { bold: true, color: COLOR_SECONDARY, size: 20 })]
        })
      ]
    }))
  });

  const bodyRows = rows.map((r, rowIdx) => new TableRow({
    children: r.map((cellText, cellIdx) => new TableCell({
      shading: { type: ShadingType.CLEAR, fill: rowIdx % 2 === 1 ? COLOR_BG_LIGHT : 'FFFFFF' },
      margins: { top: 90, bottom: 90, left: 140, right: 140 },
      children: [
        new Paragraph({
          children: [run(cellText, { size: 19, bold: cellIdx === 0 })]
        })
      ]
    }))
  }));

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders,
    rows: [headerRow, ...bodyRows]
  });
}

// Build Document
const docChildren = [
  title('Ellie v5: Architecture, Features & Governance Specification'),
  subtitle('Public / External Engineering Reference — Designed for AI Employee Systems'),
  calloutBox(
    'Operating doctrine: "The agent owns the work. The owner owns decisions and commitments. Host code owns authority."',
    'Core Principle:'
  ),
  new Paragraph({ spacing: { after: 200 } }),

  h1('0. Executive Preface: Context Note for AI Employee Platforms'),
  h2('Background and Motivation'),
  p('This architecture specification documents Ellie v5, a private, single-tenant, Slack-first AI Chief of Staff. The system was designed and built following production experience with commercial AI coworker platforms (specifically Viktor.com).'),
  p('Commercial AI coworker platforms excel for mid-size and enterprise companies, where pooled team budgets absorb usage-based consumption naturally. Such platforms pioneered several interaction patterns that heavily inspired Ellie:'),
  bullet('Interacting inside Slack channels and threads with a natural conversational voice, responsiveness, and solid context retention instead of acting like a temporary chatbot.', '1. The coworker experience:'),
  bullet('Recognizing that in scheduled monitoring, saying nothing when nothing changed is the hallmark of an executive assistant.', '2. Silence as a valid output:'),
  bullet('Publishing persistent, visual HTML micro-applications and dashboards instead of dumping walls of formatted text into chat.', '3. Interactive spaces:'),

  h2('The Solo Operator Dilemma & Real-World Friction'),
  p('For a freelancer or solo operator, usage-based credit tiers become an obstacle to running an always-on, 24/7 personal chief of staff:'),
  bullet('Running continuous background watchers (inbox monitoring, calendar overlap checks, folder sweeps, open loop tracking) constantly drains monthly credit allotments. Having to throttle or pause 10 out of 11 routines just to save credits defeats the core value of an autonomous coworker.', 'Background vigilance anxiety:'),
  bullet('In multi-tenant managed setups, over 90% of credits end up consumed by idle polling loops and conversational ping-pongs, not deep reasoning.', 'Polling versus thinking:'),
  p('While the coworker workflow is compelling, running it continuously as an independent operator required a setup anchored in direct-API pricing and deterministic host-code execution:'),
  bullet('Trigger detection runs in lightweight host code (inspecting IMAP UID sequences, Gmail historyId checkpoints, Google Drive modification timestamps, or receiving webhooks) at zero marginal cost. Gemini models run only when an actual state change needs intelligence, reducing background costs to near zero while keeping sub-minute responsiveness.', '1. Cheap triggers, expensive thinking:'),
  bullet('System prompts like "do not send emails without permission" fail under prompt injection, context truncation, or subtle conversational pressure. Host code keeps absolute authority. Native tools belong to static effect classes (READ, LOCAL_WRITE, INTERNAL_REVERSIBLE_WRITE, CONSEQUENTIAL). Consequential tools (sending emails, staging external payments, creating public calendar entries) cannot execute directly. The dispatcher intercepts the call, logs it in an append-only SQLite ledger, and renders a cryptographic Slack approval card. Only an explicit human click triggers execution.', '2. Deterministic governance vs prompt pleading:'),
  bullet('Language models drafting executive correspondence or resumes tend to embellish metrics, hallucinate phone numbers, or invent career milestones. An automated claims bank guard intercepts outbound drafts and documents. It scans text against a verified identity corpus and numerical repository, blocking ungrounded quantitative claims and unauthorized contact details before text reaches the approval queue.', '3. Outbound claims banking:'),
  bullet('Over time, an agent reading past documents or email threads begins treating its own prior drafts as ground-truth evidence, compounding hallucinations over successive cycles. Every resource generated by the agent is logged in an authored resources registry. When reading Google Docs, Drive files, or stored results, any artifact authored by the agent is marked as non-evidence, cutting off self-referential hallucination loops.', '4. Self-referential evidence protection:'),
  bullet('Unchecked agent self-learning causes prompt context explosion and captures transient details (such as specific email addresses, one-off dates, private recipient notes) into global long-term memory. A regularized self-improvement engine enforces a strict budget cap of about 1,000 tokens on active injected memory, scores lessons using Wilson-score utility rankings, and runs an automated leakage critic that rejects candidates containing specific dates, currency amounts, emails, or recipient-specific proper nouns.', '5. Memory regularization:'),

  h1('1. System Architecture & Runtime Topology'),
  h2('1.1 High-Level Architecture Diagram'),
  p('The diagram below illustrates the runtime components, governance gates, local SQLite stores, and external integrations:'),
  imageParagraph('docs/diagram1.png', 480, 175),

  h2('1.2 Technology Stack'),
  createTable(
    ['Layer', 'Implementation', 'Role'],
    [
      ['Runtime', 'TypeScript 5.8+ (ES2022, NodeNext ESM), Node.js >=22.13.0', 'Core application runtime'],
      ['Database', 'Built-in node:sqlite (DatabaseSync) in WAL mode', 'Operational state (app.sqlite) and audit ledger (ledger.sqlite)'],
      ['Foundation models', 'Google genai SDK (Gemini 3.8 Flash, Reasoning, Image Models)', 'Multi-tier reasoning, vision, and explicit context caching'],
      ['Web service', 'Express with a single-file responsive dark-mode interface', 'Control plane, REST endpoints, and Spaces hosting'],
      ['Document generation', 'docx, headless LibreOffice, Poppler, and Chromium', 'Dual-engine linear and visual document rendering'],
      ['Tabular sandbox', 'In-memory node:sqlite (DatabaseSync)', 'Isolated SQL querying of attached user spreadsheets'],
      ['External tools', 'Model Context Protocol (MCP) gateway & Composio', 'Integration with advertising, CRM, and cloud toolchains']
    ]
  ),
  new Paragraph({ spacing: { after: 180 } }),

  h1('2. Core Subsystems & Governance Pipeline'),
  h2('2.1 Multi-Tier Model Routing and Context Caching'),
  createTable(
    ['Tier', 'Default Model', 'Thinking Budget', 'Temperature', 'Target Workloads'],
    [
      ['SENTINEL', 'Gemini Flash', 'low', '0.0', 'Email triage, thread card edits, correction extraction, layout checks'],
      ['ROUTINE', 'Gemini Flash', 'medium', '0.2', 'Scheduled cron routines, background continuations, subtask delegation'],
      ['INTERACTIVE', 'Gemini Flash', 'medium', '0.3', 'Default Slack conversations and threads'],
      ['ESCALATION', 'Gemini Flash', 'high', '0.3', 'Auto-escalated upon repeated tool execution errors'],
      ['ANALYSIS', 'Gemini Reasoning', 'high', '0.2', 'Deep synthesis, complex evaluations, threads flagged with /argon'],
      ['EVALUATOR', 'Gemini Reasoning', 'high', '0.0', 'Post-routine constraint verification before posting deliverables']
    ]
  ),
  new Paragraph({ spacing: { after: 120 } }),
  p('The static prompt prefix (doctrine, governance, tool discipline) is hashed with SHA-256 and registered with an explicit 1,800-second Gemini context cache. The coworker service warms this cache asynchronously upon receiving incoming Slack events.', 'Static prefix caching:'),
  p('Low media resolution is applied for document and PDF visual layout checks. A zero thinking budget is configured on fast internal extraction tasks such as lesson extraction and text slimming. Redundant Slack block markup and Markdown noise are stripped before prompt assembly.', 'Token efficiency:'),

  h2('2.2 Forced Tool Loop & Execution Discipline'),
  p('The agent runs with function calling mode set to ANY. Plain-text model completion is disabled. The model must invoke a tool on every turn, terminating through a synthetic finish tool call with explicit status (DONE, NEEDS_INPUT, BLOCKED, NOTHING_TO_REPORT, CONTINUE_IN_BACKGROUND) and deliveryMode (SLACK_MESSAGE, REACTION_ONLY, SILENT).'),
  p('Multiple read tool calls in a single turn execute concurrently through Promise.all, followed sequentially by write or staging actions. Long-running interactive tasks can yield CONTINUE_IN_BACKGROUND with a prompt, allowing the coworker service to chain background execution rounds without blocking Slack response deadlines.'),

  h2('2.3 Deterministic Governance & Action Ledger Sequence'),
  p('The sequence diagram below displays the strict human-in-the-loop lifecycle for consequential writes:'),
  imageParagraph('docs/diagram2.png', 480, 286),
  bullet('ToolDispatcher validates the active grant and interactive safety guards.', '1. Guard evaluation:'),
  bullet('Draft handles are resolved and verified against the Claims Bank and Identity Corpus.', '2. Verification:'),
  bullet('If the tool is classified as CONSEQUENTIAL, the proposal is staged in the Action Ledger and rendered as a Slack approval card.', '3. Action Ledger staging:'),
  bullet('Only a verified human click invokes the execution handler.', '4. Execution:'),
  bullet('If the tool is classified as INTERNAL_REVERSIBLE_WRITE, the operation executes immediately and runs an automated read-back verification pass.', '5. Read-back pass:'),

  h1('3. Complete Tool Catalog Inventory (74 Native Tools)'),
  p('All 74 native tools are statically typed, assigned an effect class, and guarded by host code before invocation.'),

  h2('3.1 Google Workspace Tools (14 Tools)'),
  bullet('read-only message and thread discovery with payload decoders.', 'gmail_search & gmail_read:'),
  bullet('non-consequential draft creation with read-back verification.', 'gmail_draft:'),
  bullet('consequential outbound email staging requiring human Slack approval.', 'gmail_send:'),
  bullet('header-mapped reading, row appending, and cell-by-cell verified updates.', 'sheets_read, sheets_append, sheets_update:'),
  bullet('full document reading and verified authoring logged in authored resources.', 'docs_read, docs_create, docs_append:'),
  bullet('drive search and universal reading (extracts text from Docs, PDFs, Word docx, CSV, JSON).', 'drive_search, drive_read_file:'),
  bullet('calendar inspection and staged consequential event creation.', 'calendar_list, calendar_create:'),

  h2('3.2 Secure Mail Bridge Tools (5 Tools)'),
  bullet('localhost IMAP message querying and body retrieval.', 'proton_search, proton_list_unread, proton_read:'),
  bullet('IMAP append draft composition.', 'proton_draft:'),
  bullet('consequential SMTP email staging with deduplication and approval card checks.', 'proton_send:'),

  h2('3.3 Verification & Claims Tools (2 Tools)'),
  bullet('batch loader for canonical identity documents, project guidelines, and the verified claims bank.', 'owner_sources_read:'),
  bullet('pre-flight check evaluating plain text or document blocks against the Claims Bank, Identity Corpus, and stylistic humanization scanners.', 'owner_text_check:'),

  h2('3.4 Dual-Engine Document Rendering Tools (2 Tools)'),
  bullet('linear formatted document generator (resumes, cover letters, memos, briefs, reports). Generates docx with embedded Open Font License typography, runs headless LibreOffice conversion to PDF, performs page auto-fitting, validates ATS reading order, and archives to Drive.', 'document_render:'),
  bullet('visual one-page document generator (one pagers, pitch sheets, infographics). Renders HTML5 and CSS Grid layouts with embedded SVG icons, runs an A4 height solver targeting 92% to 100% density, and converts through headless Chromium.', 'visual_document_render:'),

  h2('3.5 Memory, State, Spaces & Spreadsheets (15 Tools)'),
  bullet('explicit executive memory management.', 'memory_save, memory_list_facts:'),
  bullet('candidate learning pipeline.', 'memory_record_candidate, memory_list_candidates, memory_promote_candidate:'),
  bullet('natural language scheduled Slack reminder creation.', 'reminder_set:'),
  bullet('character-offset paging through large stored result handles.', 'result_read:'),
  bullet('in-memory SQLite sandbox executing read-only SQL (SELECT and WITH queries) against attached XLSX, CSV, or TSV workbooks.', 'sheet_query:'),
  bullet('outbound follow-through tracking so no open loop is forgotten.', 'waiting_track, waiting_list, waiting_resolve:'),
  bullet('canonical project status tracker managing objectives, blockers, and milestones.', 'project_state_read, project_state_update:'),
  bullet('publishing and listing interactive self-hosted web micro-apps served at /spaces/:slug.', 'space_publish, space_list:'),

  h2('3.6 Skills, Job Evaluation, Subtasks & Visuals (6 Tools)'),
  bullet('on-the-fly inspection and authoring of domain skill files.', 'skills_list, skill_read, skill_edit:'),
  bullet('specialized evaluation engine executing multi-criteria role scoring on the reasoning model against verified candidate dossiers.', 'job_evaluate:'),
  bullet('spawns an isolated child agent runner to distill complex research without context pollution.', 'delegate_subtask:'),
  bullet('image generation and iterative photo manipulation using Gemini Image models with automatic EXIF metadata stripping.', 'image_generate:'),

  h2('3.7 Web Intelligence & Gateway Integrations (21 Tools)'),
  bullet('Google Search grounding through native tool configuration.', 'web_search:'),
  bullet('multi-fallback web reader with SSRF address validation.', 'web_read_page:'),
  bullet('structured profile and post scraping with daily quota caps.', 'apify_linkedin_profile, apify_linkedin_posts:'),
  bullet('Model Context Protocol gateway integrations (Amazon Ads reporting, Meta Ads reporting, and LinkedIn DMA data portability) pinned against SHA-256 schema baselines.', 'mcp_elliegateway tools:'),

  h2('3.8 Dynamic Composio Integration (5 Tools + Dynamic Slugs)'),
  bullet('dynamic discovery, authorization checking, and staging of third-party SaaS tools. Consequential actions automatically inherit Action Ledger approval requirements.', 'composio_search_tools, composio_install_tool, composio_setup_tool, composio_execute_tool, composio_list_installed:'),

  h2('3.9 Self-Diagnosis & Infrastructure Inspection (4 Tools)'),
  bullet('code exploration and self-inspection blocking secrets, environment files, and databases.', 'repo_list_and_search, repo_read_file:'),
  bullet('glass-box execution inspection of recent run traces, errors, and tool outputs.', 'trace_inspect_recent:'),
  bullet('sandboxed Linux systemd and journalctl resource reader with automated secret token redaction.', 'vps_inspect:'),

  h2('3.10 Interactive Command & Control Tools (8 Tools)'),
  p('These tools are restricted to interactive Slack sessions and blocked in background routines:'),
  bullet('management of automated cron schedules and prompts.', 'routine_manage:'),
  bullet('inspection and rescheduling of active reminders.', 'reminder_manage:'),
  bullet('configuration of quiet hours, snooze windows, and daily proactive notification caps.', 'nudge_settings_manage:'),
  bullet('review and maintenance of learned executive rules.', 'memory_manage:'),
  bullet('live inspection and dropping of staged Action Ledger proposals.', 'queue_manage:'),
  bullet('setting friendly alias pointers for Drive files and sheets.', 'workspace_alias_manage:'),
  bullet('configuration of VIP sender rules and monitoring states.', 'sentinel_manage:'),
  bullet('telemetry inspection of daily and weekly token consumption and USD spend.', 'cost_and_budget_manage:'),

  h1('4. Proactive Sentinels & Autonomous Operations'),
  h2('4.1 Sentinels and Nudge Gate'),
  p('Gmail and Proton sentinels watch incoming correspondence around the clock. When a counterparty replies to an outstanding thread, open waiting loops resolve automatically. Inbound triage runs on the fast sentinel tier and posts Slack cards with one-click reply drafts.'),
  p('A calendar sentinel checks upcoming schedules within a rolling 45-minute window, raising alerts only for imminent commitments or double bookings.'),
  p('A configurable nudge gate enforces quiet hours, daily notification limits, snooze durations, and 24-hour deduplication so background alertness never degrades into notification noise.'),

  h2('4.2 Cron Routines and Dual-Pass Evaluator'),
  p('Background routines that monitor external folders or trackers check resource modification timestamps before doing any work. When nothing changed, the run finishes silently without spending model tokens.'),
  p('When a routine has hard factual constraints, a second evaluator pass checks the draft against tool evidence using the reasoning model before anything posts to Slack.'),

  h1('5. Web Control Plane & Interface'),
  p('A single-page control plane runs alongside the agent runtime under token authentication.'),
  p('The approvals screen (at /) lists staged consequential actions with diff previews, approval buttons, and drop controls. A spaces gallery (at /spaces) lets users browse and search agent-published dashboards and micro-apps. The routines screen manages schedules and manual run triggers, while the runs tab provides glass-box telemetry for prompt timing, token counts, cache hit rates, and delivered text. Additional views report token costs, project documentation, and integration health checks.'),

  h1('6. Implementation Status & Roadmap'),
  h2('Current Production State (v5.0.0)'),
  p('The core agent, deterministic governance pipeline, dual-engine document rendering (DOCX and visual HTML/SVG PDFs), and all 74 native tools are in production, backed by 44 test suites with 390 passing unit and integration tests.'),

  h2('Roadmap and Active Development (TBD)'),
  p('Mobile operations and real-time voice are currently in development. This track includes a native Android companion app (Jetpack Compose) for on-the-go approvals and space viewing, alongside bidirectional Gemini Live voice streaming over WebSockets and ambient meeting note synthesis.')
];

const doc = new Document({
  styles: {
    default: {
      document: {
        run: {
          font: FONT_SANS,
          size: 22,
          color: COLOR_TEXT
        }
      }
    }
  },
  sections: [
    {
      properties: {
        page: {
          margin: {
            top: 1080,    // 0.75 inch
            bottom: 1080,
            left: 1080,
            right: 1080
          }
        }
      },
      children: docChildren
    }
  ]
});

const buffer = await Packer.toBuffer(doc);
const outputPath = 'docs/Ellie_v5_Architecture_Specification.docx';
fs.writeFileSync(outputPath, buffer);
console.log(`Document generated successfully at ${outputPath} (${buffer.length} bytes)`);
