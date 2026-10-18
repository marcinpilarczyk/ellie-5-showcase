# Session Handoff — Full Roadmap: Proactive Chief of Staff, Continuity, Governance & Visual Document Engine

Self-contained implementation brief covering **Phases 1–5** from the gap analysis against the *Standalone Ellie — Product and Behavioral Design Specification* plus the **Document & Visual One-Pager / Infographic Engine** upgrades.

---

## Read First (Ground Rules)

1. **`docs/PLAN.md` → `Hard Rules (for every session)`**
   - Fix the class, not the instance.
   - Never print secret values or touch `/home/ellie/backups/v2-preservation/.env`.
   - Ask before any destructive/outward action, `.env` edit, or VPS write outside `deploy/push.sh`.
   - **No personalization**: Zero hardcoded owner names, Doc IDs, email addresses, company names, or personal details in `src/` or tests.
2. **Build & Test Environment**
   - Source repo lives on local storage / Drive.
   - If `npm install` cannot run directly on cloud mounts, builds and tests can run via a local mirror directory.
   - Run typecheck and test suites:
     - `npm run typecheck`
     - `npm test`

---

## Phase 1 — Proactive Execution & Attention Wiring (§14–§18, §36–§37, §41–§42, §50, §58)

### 1.1 Expand `DEFAULT_ROUTINE_GRANT` (`src/scheduler/routine-worker.ts`)
- **Problem**: `DEFAULT_ROUTINE_GRANT` (`src/scheduler/routine-worker.ts:22-27`) includes `docs_create` and `docs_append`, but omits `owner_sources_read`, `owner_text_check`, `document_render`, `drive_Search`, `drive_get_content`, and `calendar_get_event`. Because `guardOwnerText` (`src/governance/dispatcher.ts:274-282`) requires `owner_sources_read` + `owner_text_check` before any career/CV/outreach Doc write, routines cannot create verified or formatted Docs.
- **Fix**: Add `owner_sources_read`, `owner_text_check`, `document_render`, `drive_Search`, `drive_get_content`, and `calendar_get_event` to `DEFAULT_ROUTINE_GRANT`.

### 1.2 Fix Routine Cron Due-Time Calculation (`src/scheduler/routine-worker.ts` & `src/scheduler/cron.ts`)
- **Problem**: `RoutineWorker.runDueRoutines` (`src/scheduler/routine-worker.ts:138-145`) deduplicates using `zonedDateKey(lastRun, tz) === zonedDateKey(now, tz)`. This blocks sub-daily routines (`0 9,17 * * *`) after the first run and skips a scheduled evening run if the routine was manually triggered (`Run now`) earlier that calendar day.
- **Fix**: Add a cron-slot helper in `src/scheduler/cron.ts` (e.g., comparing `last_run_at` against the current matching minute slot in the routine's timezone) so routines run once per matching cron slot rather than once per calendar day.

### 1.3 Wire `NudgeGate` into Proactive Surfaces (`src/scheduler/nudge-gate.ts`, `src/runtime/build-runtime.ts`)
- **Problem**: `NudgeGate` (`src/scheduler/nudge-gate.ts`) is instantiated in `src/runtime/build-runtime.ts:111` (`nudgeGate`) with quiet hours (`22:00–07:30`), daily budget, and priority bypass, but `nudgeGate.evaluate(...)` is never called by sentinels or reminders.
- **Fix**: Pass `nudgeGate` into `GmailSentinel`, `ProtonSentinel`, `CalendarSentinel`, and `ReminderDispatcher` so proactive notifications respect quiet hours and nudge budgets (while urgent/high-priority items bypass quiet hours per `NudgeGate` rules).

### 1.4 Complete `GmailSentinel` (`src/scheduler/sentinels/gmail-sentinel.ts`)
- **Problem**:
  1. Never checks `sentinel_sender_rules` (`vip` / `ignore` rules managed by `src/tools/sentinel-manage-tools.ts`).
  2. When triage returns `action: "draft"`, it dispatches `gmail_draft` (creating an `AWAITING_APPROVAL` entry in `action_ledger`), **but never posts the approval card or notification to Slack**.
  3. When triage returns `action: "surface"`, there is no `else if (triage.action === "surface")` branch—important non-reply emails are marked seen and silently dropped.
- **Fix**:
  - Consult `sentinel_sender_rules` before LLM triage (`ignore` → skip immediately; `vip` → force at least `"surface"` or `"draft"` with high priority).
  - When `action === "draft"` stages an approval in `action_ledger`, post the Slack approval card (or surface summary + approval card via `slackClient`) gated by `nudgeGate`.
  - When `action === "surface"`, post a concise summary to Slack (`defaultChannelId`) gated by `nudgeGate`.

### 1.5 Complete `ProtonSentinel` (`src/scheduler/sentinels/proton-sentinel.ts`) & Calendar Deduplication (`src/scheduler/sentinels/calendar-sentinel.ts`)
- **Problem**:
  - `ProtonSentinel` (`src/scheduler/sentinels/proton-sentinel.ts:48-63`) calls `listUnread(5)` and immediately returns `seen_count` without triaging or surfacing anything (§36, §50).
  - `CalendarSentinel` (`src/scheduler/sentinels/calendar-sentinel.ts:48-71`) posts a raw one-liner for every event `<20 min` away without deduplicating already-notified event IDs (`seen_ids`).
- **Fix**:
  - Track notified event IDs in `CalendarSentinel` via `seen_ids` in `sentinel_state` so the same meeting isn't alerted twice, and gate via `nudgeGate` (priority: high).
  - Give `ProtonSentinel` seen-ID tracking (`seen_ids` in `sentinel_state`), sender rule matching, and triage/surfacing through the same pipeline as `GmailSentinel`.

---

## Phase 2 — Thread Continuity & Governance Tightening (§28, §30, §46, §50, §51)

### 2.1 Thread Image Continuity (`src/integrations/slack/coworker.ts`)
- **Problem (§30)**: `downloadImages` (`src/integrations/slack/coworker.ts:277-289`) only downloads `event.files` from the current Slack message. `loadThreadHistory` (`src/integrations/slack/coworker.ts:254-275`) extracts only `m.text` and ignores `m.files` on earlier messages in the thread. Follow-up turns in the same thread lose access to previously shared screenshots/images.
- **Fix**: When loading thread history in `coworker.ts`, inspect recent thread messages for image `files` (bounded, e.g. up to 4 images across the thread when the current turn has none or to supplement it) and download/attach them so visual context persists across follow-up turns in the thread.

### 2.2 Filter Non-Evidence Tools from `ThreadCarryoverRepository` (`src/storage/thread-carryover-repo.ts`)
- **Problem (§28)**: `ThreadCarryoverRepository.entriesFrom` (`src/storage/thread-carryover-repo.ts:49-68`) records `notEvidence` tools (`owner_text_check`, `trace_inspect_recent`, `repo_read_file`, `repo_search`) in `thread_carryover`. Follow-up runs in the same thread re-hydrate stale diagnostic/draft checks instead of real evidence (`owner_sources_read`, `gmail_get_thread`, `drive_get_content`, etc.).
- **Fix**: Exclude `notEvidence` tools (matching `ResultStore`: `trace_inspect_recent`, `trace_inspect_run`, `repo_status`, `repo_search`, `repo_read_file`, `owner_text_check`) from `ThreadCarryoverRepository.entriesFrom`.

### 2.3 Enforce `guardOwnerText` and `stripRepeatedHeaders` on In-Thread Revisions (`src/integrations/slack/coworker.ts`)
- **Problem (§46, §51)**: `handleInThreadRevision` (`src/integrations/slack/coworker.ts:370-406`) rewrites `proposal.args` with an LLM call and writes directly to `ledger.updateProposalArgs` without running `stripRepeatedHeaders` (`src/governance/dispatcher.ts:121-133`) or `ClaimsBankGuard` / `guardOwnerText` (`src/governance/dispatcher.ts:268-353`).
- **Fix**: Validate revised `args` through `stripRepeatedHeaders` and `ClaimsBankGuard.checkText` (when the revised proposal touches owner/career/outreach content) before updating the ledger proposal.

### 2.4 Surface `FAILED` Actions in `groundReply` (`src/governance/reply-grounding.ts`)
- **Problem (§9, §50)**: `groundReply` (`src/governance/reply-grounding.ts:28-133`) checks `EXECUTED`, `AWAITING_APPROVAL`, and `DENIED`, but ignores `FAILED` ledger rows—allowing the model to omit or gloss over a failed provider call.
- **Fix**: Include `FAILED` ledger entries in `groundReply` so any failed consequential/write tool call is explicitly disclosed in the grounded reply receipt.

---

## Phase 3 — Follow-Through State, Canonical Project Docs & Outward Deduplication (§19–§26, §47)

### 3.1 First-Class `waiting_items` Table & Tools (`src/storage/schema.ts`, `src/tools/waiting-tools.ts`)
- **Problem (§16, §19–§22)**: No structured tracking of delegated tasks, owed replies, or stale threads (`waiting_on`, `subject`, `context_ref`, `due_at`, `status`).
- **Fix**:
  - Add a `waiting_items` table in `appDb` (`id`, `counterparty`, `subject`, `channel`, `thread_ref`, `due_at`, `status` [`open` | `nudged` | `resolved`], `created_at`, `updated_at`).
  - Expose `waiting_track`, `waiting_list`, and `waiting_resolve` tools and include due/overdue waiting items in morning routines.

### 3.2 Canonical `project_state_update` Tool (`src/tools/project-state-tools.ts`)
- **Problem (§23–§26)**: Spec requires `/EllieOS/Projects/<Project>/PROJECT_STATE` Docs with 8 canonical sections (`Objective`, `Current Status`, `Active Workstreams`, `Open Loops / Waiting On`, `Key Decisions`, `Risks / Blockers`, `Next Actions`, `Linked Artifacts`), but no tool enforces or updates those sections cleanly.
- **Fix**: Add `project_state_update` (and `project_state_read`) that reads/creates the project's `PROJECT_STATE` Doc under the owner's `Projects/<Project>` folder and updates specific canonical sections without clobbering the rest of the Doc.

### 3.3 Outward Action Deduplication in `ToolDispatcher` (`src/governance/dispatcher.ts`)
- **Problem (§47)**: Nothing stops duplicate outward proposals (`gmail_send`, `gmail_draft`, `proton_send`, `slack_post_message`) with identical recipient + subject/body within a short window across retries or overlapping sentinel/routine runs.
- **Fix**: Before staging or executing an outward communication tool in `ToolDispatcher`, check `action_ledger` for a recent (`AWAITING_APPROVAL` or `EXECUTED` within the last 24h) entry with the same normalized recipient + subject/target and refuse with a clear `[Duplicate Action Refusal]` receipt.

---

## Phase 4 — Self-Improvement Loop & Owner Config Wiring (§43, §62–§66)

### 4.1 Fix Queue Edit Bug & Capture Revision Lessons (`src/http/routes/queue.ts`, `src/integrations/slack/coworker.ts`)
- **Problem (§63–§66)**:
  1. `src/http/routes/queue.ts:82-91` (`edit_gmail_send_body`) stores the entire edited email body raw into `memories` (`category: 'preference'`), polluting the system prompt with full email bodies instead of a concise style/tone lesson.
  2. Slack in-thread revisions (`coworker.ts:370-406`) never extract or store a preference lesson when the owner corrects tone/phrasing.
- **Fix**:
  - Replace the raw body dump in `queue.ts` with a lightweight diff-to-lesson extractor (or concise rule summary) that stores a 1-sentence preference rule in `MemoryRepository` (`source: 'correction'`, `confidence: 0.9`).
  - Hook the same lesson extractor into `handleInThreadRevision` when the user gives a generalizable style/tone correction.

### 4.2 Wire `OwnerConfigLoader` (`src/config/owner.ts`, `src/runtime/build-runtime.ts`)
- **Problem**: `OwnerConfigLoader` is defined in `src/config/owner.ts` and listed on `Runtime` (`src/runtime/build-runtime.ts:80`), but never instantiated or passed into `UnifiedAgentRunner`.
- **Fix**: Instantiate `OwnerConfigLoader` in `buildRuntime` and feed non-empty rules/preferences alongside the Google Doc `config_doc` in `runner.ts`.

---

## Phase 5 — Document & Visual One-Pager / Infographic Engine (`src/documents/`, `src/tools/document-tools.ts`)

### 5.1 Upgrades to the Existing DOCX / Resume Renderer (`src/documents/render-docx.ts`, `src/documents/themes.ts`, `src/documents/pdf.ts`)
1. **Deterministic Typographic Auto-Fitting Loop (`src/tools/document-tools.ts`, `src/documents/themes.ts`)**:
   - **Problem**: If a resume renders to 2.05 pages (a few overflow lines on page 3) or 1.85 pages, `document_render` immediately throws back to the LLM and hard-blocks (`[Document BLOCKED]`) on the second miss. LLMs cannot see exact font metrics or line wraps.
   - **Fix**: Before failing a page-count check, run a deterministic micro-typesetting loop over 3–5 subtle `Theme` presets (elastic margins `14mm–19mm`, `lineSpacing` `1.08–1.20`, `bullet.spaceAfterPt` `1.5–3pt`, `heading.spaceBeforePt` `9–14pt`). If a preset hits the exact page target (`resume === 2`, `cover_letter <= 1`) and passes `readingOrderProblems`, use it automatically; only bounce back to the LLM when content is genuinely too long or too short across all presets.
2. **Right-Aligned Tab Stops for Role Headers (`src/documents/render-docx.ts`)**:
   - **Fix**: Add a right-aligned tab stop at the right content margin (`widthMm - 2 * marginSideMm`) so role headers can place `Title` / `Employer` on the left and `Dates · Location` flush-right on the same line, saving vertical space and improving visual scanability while preserving strict left-to-right ATS reading order (`pdftotext`).
3. **Clickable Hyperlinks in `header.contact` (`src/documents/render-docx.ts`)**:
   - **Fix**: Detect email addresses and URLs (including `linkedin.com/...` or `https://...`) in `header.contact` items and wrap them in `ExternalHyperlink` styled with `theme.contact` so exported PDFs have real clickable link annotations.
4. **Cross-Platform `pdfToolsInstalled()` (`src/documents/pdf.ts`)**:
   - **Fix**: Use `delimiter` from `node:path` instead of hardcoded `':'`, and check both `b` and `${b}.exe` on Windows so local dev environments with LibreOffice + Poppler behave identically to the Linux VPS.

### 5.2 Visual One-Pager / Pitch Sheet / Infographic Engine (`src/documents/render-html-pdf.ts`, `src/documents/visual-blocks.ts`)
- **Goal**: Produce high-craft, single-page visual executive briefs, client proposals, and process infographics (like the 4-step workflow + split card + status badge table + dark footer pitch sheet) that OOXML/LibreOffice cannot express.
- **Architecture — Dual Engine, Shared Governance Gate**:
  - Keep **DOCX + LibreOffice** (`renderDocx`) for linear ATS/editable documents (`resume`, `cover_letter`, `memo`).
  - Add **HTML/CSS + Inline SVG → Headless Browser PDF** (`renderHtmlPdf`) for visual documents (`one_pager`, `pitch_sheet`, `infographic`).
  - Both engines pass through the **exact same verification and governance pipeline**:
    1. `ClaimsBankGuard` / `ownerText` check on all text in reading order (when the document contains owner claims).
    2. `pdfinfo` exact page-count gate (`one_pager` / `pitch_sheet` / `infographic` must be `exact: 1` page).
    3. `pdftotext` reading-order / completeness check.
    4. `createVisualCheck` multimodal inspection (Gemini Flash over the rendered page PNG) checking for clipped text, overlapping boxes, uneven card alignment, or overflow.
- **Visual Component Blocks (`src/documents/visual-blocks.ts`)**:
  - Extend `document_render` (or provide `visual_document_render`) with structured visual blocks that render into a curated CSS Grid / Flexbox design system with bundled `@font-face` (`Google Sans Text` & `Merriweather` from `assets/fonts/`) and a built-in inline Lucide/Feather SVG icon set (`database`, `list`, `flag`, `check-circle`, `phone`, `mail`, `calendar`, `user-check`, `lock`, `sparkles`, `arrow-right`, `alert-circle`, etc.):
    - `banner_header`: Kicker (left) + author/date metadata (right), large serif/sans title, subtitle, and optional pull-quote with vertical accent bar.
    - `step_flow`: 3–5 horizontal cards connected by arrows (`→`), each with step number badge, SVG icon, title, description, and optional `highlight: true` (solid dark accent card for the final/payoff step).
    - `split_grid`: 2-column asymmetric or 50/50 grid holding nested card blocks:
      - `status_table`: Header with icon + title + date + badge, rows with primary label, context text, and semantic pill badge (`tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral'`), plus optional nested `callout_box` (e.g., sample message draft).
      - `benefit_card`: Tinted card with section header and icon-prefixed title + description items.
    - `icon_strip`: Full-width bordered card with 2–4 horizontal columns, each with an SVG icon and text (e.g., governance/human-in-the-loop boundaries), plus an optional bottom assumption/note line.
    - `cta_footer`: Full-bleed dark accent footer with kicker, author attribution, main pitch paragraph, bordered hypothesis/next-step callout box, and small source/disclaimer line.
- **Deterministic 1-Page Auto-Fit in Headless Browser**:
  - Before printing to PDF (`@page { size: A4; margin: 0; }`), measure `document.documentElement.scrollHeight` vs. A4 height (`1122.5px` at 96 DPI) and automatically tune CSS custom properties (`--scale-space`, `--scale-font`, `--card-padding`) so the one-pager fills 92%–100% of page 1 without ever spilling onto page 2.

---

## Recommended Execution Order Across Sessions

1. **Session A (Phases 1 & 2)**: Proactive Execution & Attention Wiring (`routine-worker.ts`, `cron.ts`, `nudge-gate.ts`, `gmail-sentinel.ts`, `proton-sentinel.ts`, `calendar-sentinel.ts`) + Thread Continuity & Governance Tightening (`coworker.ts`, `thread-carryover-repo.ts`, `reply-grounding.ts`) + unit tests.
2. **Session B (Phases 3 & 4)**: `waiting_items` table & tools, `project_state_update` tool, outward deduplication in `ToolDispatcher`, queue/revision lesson extraction, and `OwnerConfigLoader` wiring + unit tests.
3. **Session C (Phase 5)**: DOCX/Resume auto-fitting, right-tabbed role headers & hyperlinks (`5.1`) + Visual One-Pager / Infographic HTML+SVG→PDF engine (`5.2`) + unit & visual tests.
