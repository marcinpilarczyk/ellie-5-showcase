# Ellie v5

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.8%2B-blue?style=flat-square&logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.13-green?style=flat-square&logo=node.js" alt="Node.js" />
  <img src="https://img.shields.io/badge/Database-node%3Asqlite%20WAL-orange?style=flat-square&logo=sqlite" alt="SQLite" />
  <img src="https://img.shields.io/badge/Foundation_Models-Gemini_3.8_Flash_%7C_Reasoning-8E75C2?style=flat-square&logo=google" alt="Gemini" />
  <img src="https://img.shields.io/badge/Native_Tools-74_Statically_Typed-teal?style=flat-square" alt="74 Native Tools" />
  <img src="https://img.shields.io/badge/Tests-406_Passing-brightgreen?style=flat-square" alt="Tests" />
  <img src="https://img.shields.io/badge/License-MIT-lightgrey?style=flat-square" alt="License" />
</p>

> **Operating Doctrine:**  
> *"The agent owns the work. The owner owns decisions and commitments. Host code owns authority."*

---

## Executive Summary

**Ellie v5** is a production-grade, single-tenant, Slack-first **Autonomous AI Chief of Staff** engineered for executive workflows, strategic continuity, deep document generation, and 24/7 background vigilance.

Unlike conventional chatbots or multi-tenant agent platforms that charge recurring credit markups for idle polling loops, Ellie runs on a **direct-API architectural foundation** designed for solo operators and high-leverage executives. Built on the core principle of **"Cheap triggers, expensive thinking,"** Ellie executes background event detection (IMAP UIDs, Gmail history checkpoints, Drive timestamps, cron alarms) in lightweight host code at zero marginal cost—invoking Google Gemini models only when an actual state change demands cognitive synthesis.

Ellie reads email, calendars, Drive files, and web sources; autonomously performs reversible background tasks; renders publication-grade DOCX and PDF documents; publishes interactive web spaces; and enforces **deterministic host code governance** over every outward communication or consequential action.

---

## Architectural Highlights

```mermaid
flowchart TD
    subgraph Triggers["Inbound Triggers & Wake (Zero Marginal Cost)"]
        Slack["Slack Events & Interactivity"]
        WebUI["Web Control Plane & Spaces"]
        Wake["15-Min Wake Timer"]
        RemLoop["60s Reminder Loop"]
    end

    subgraph Core["Runtime Core & Coworker"]
        Coworker["SlackCoworkerService"]
        Sentinels["Sentinels & Background Routines"]
        Runner["UnifiedAgentRunner (Forced Loop ANY)"]
        Router["ModelRouter: Gemini Flash / Reasoning"]
        Dispatcher["ToolDispatcher (Static Effect Typing)"]
        Executor["Approval Executor"]
    end

    subgraph Guards["Governance & Verification Pipeline"]
        Claims["Claims Bank & Identity Corpus Guard"]
        AntiLoop["Authored Resources (Anti-Looping)"]
        Humanizer["Stylistic Scanners & De-AI Checkers"]
    end

    subgraph Storage["Deterministic Storage (WAL Mode)"]
        LedgerDB[("Action Ledger DB (Audit Trail)")]
        AppDB[("Operational App DB")]
        SpacesFS["Self-Hosted Spaces (/spaces/:slug)"]
    end

    subgraph External["External Services & Integrations"]
        Google["Google Workspace (Gmail, Drive, Docs, Sheets, Cal)"]
        Mail["Proton Mail Bridge (IMAP/SMTP)"]
        DocEngines["Dual-Engine: LibreOffice DOCX + Headless Chromium PDF"]
        WebMCP["Web Search & MCP Gateway (Ads, Composio)"]
    end

    Slack --> Coworker
    WebUI --> Executor
    Wake --> Sentinels
    RemLoop --> Sentinels
    Coworker --> Runner
    Sentinels --> Runner
    Runner --> Router
    Runner --> Dispatcher
    Dispatcher --> Claims
    Claims --> AntiLoop
    Claims --> Humanizer
    Dispatcher --> LedgerDB
    Dispatcher --> AppDB
    Dispatcher --> SpacesFS
    Dispatcher --> DocEngines
    Dispatcher --> External
    Executor --> LedgerDB
    Executor --> External
```

---

## Core Architectural Pillars

### 1. Deterministic Host Governance (Action Ledger)
> [!IMPORTANT]
> System prompts like *"please do not send emails without asking"* fail under prompt injection, context truncation, or conversational pressure. **Host code must maintain absolute authority.**

All 74 native tools are statically assigned to immutable effect classes:
* `READ`: Free of side-effects; executed concurrently in parallel (`Promise.all`).
* `LOCAL_WRITE`: Internal modifications (memory, aliases, routine definitions).
* `INTERNAL_REVERSIBLE_WRITE`: Self-contained reversible actions (e.g., creating a draft Google Doc or publishing a Space) with automated read-back verification.
* `CONSEQUENTIAL`: Outward-facing actions (`gmail_send`, `proton_send`, `calendar_create`, external API writes).

When an agent attempts a `CONSEQUENTIAL` tool call, the `ToolDispatcher` intercepts the execution:
1. The tool call is **refused direct execution**.
2. The proposal is serialized into the append-only SQLite `action_ledger` table with status `AWAITING_APPROVAL`.
3. An interactive Slack Card is rendered in the conversation thread featuring the exact diff/payload.
4. Only an authentic, cryptographically verified owner click invokes `governance/executor.ts`, enforcing allowlists, rate limits, and verification re-checks.

### 2. Forced Tool Loop (`function_calling_mode: "ANY"`)
The agent never produces conversational free-text without ground truth. Every single model turn requires invoking a declared tool. A run terminates exclusively when the model invokes a synthetic `finish` tool call carrying:
* **Explicit Execution Status**: `DONE`, `NEEDS_INPUT`, `BLOCKED`, `NOTHING_TO_REPORT`, or `CONTINUE_IN_BACKGROUND`.
* **Explicit Delivery Mode**: `SLACK_MESSAGE` (thread reply), `REACTION_ONLY` (emoji acknowledgement), or `SILENT` (routine complete with no actionable delta).
* **Budget Enforcers**: Slack runs enforce strict limits (25 rounds, ~4.5 minute timeouts). If exhausted, the model is forced into a terminal `finish` call detailing completed tasks and pending continuation tokens.

### 3. Outbound Claims Banking & Zero-Hallucination Guard
When drafting executive correspondence, cover letters, or tailored resumes, generative models tend to fabricate contact information, embellish metrics, or invent career milestones.
* **Claims Bank Guard**: Intercepts every document or email proposal before staging.
* **Corpus Matching**: Verifies every quantitative metric, job title, date range, email, phone number, and LinkedIn URL against a local canonical identity source and verified claims ledger.
* **Ungrounded Claims Rejection**: If ungrounded assertions are detected, the proposal is immediately rejected with a structured `[Document Check]` diagnostic, forcing the model to revise or cite source evidence.

### 4. Self-Referential Evidence Protection (Anti-Looping)
Over weeks of autonomous operation, agents reading past Drive documents or email threads frequently mistake their own earlier hypothetical drafts for verified facts.
* Every document, draft, or sheet written by Ellie is permanently recorded in an `authored_resources` registry.
* Whenever Ellie reads Google Drive, Docs, or cached result handles, resources flagged as agent-authored are explicitly marked as **non-evidence**, neutralizing recursive hallucination drift.

### 5. Regularized Self-Improvement & Memory (RRSI)
Uncontrolled agent self-learning causes prompt bloat and leaks private transient data into global memory.
* **Strict Memory Budget**: Active memory injection into the system prompt is hard-capped at ~1,000 tokens.
* **Wilson-Score Utility Ranking**: Memory rules and operational lessons compete for inclusion based on proven feedback utility.
* **Leakage Critic**: An automated heuristic pass validates every memory candidate, refusing entries containing specific dates, dollar amounts, temporary email addresses, or ungeneralizable one-off details.

### 6. Dual-Engine Document Rendering
Ellie features a dual-engine document synthesis pipeline sharing a unified verification gate:
1. **Linear / ATS-Grade Engine (`document_render`)**:
   - Takes a structured semantic block schema (headings, roles, bullet points, key-value blocks).
   - Generates OOXML `.docx` files via Node `docx` with embedded Open Font License typography (*Merriweather* and *Google Sans Text*).
   - Converts to PDF via headless LibreOffice on the host.
   - Verifies exact page counts (e.g., resumes must be exactly 2 pages; cover letters <= 1 page) and verifies ATS text reading order via Poppler (`pdftotext`).
   - Runs deterministic typographic auto-fitting across subtle margin and line-spacing presets before engaging multimodal visual review.
2. **Visual One-Pager & Infographic Engine (`visual_document_render`)**:
   - Compiles HTML5, modern CSS Grid/Flexbox, and inline SVG iconography into executive one-pagers, split-card pitch sheets, and workflow infographics.
   - Uses an iterative A4 height-solver targeting 92%–100% density without spillover.
   - Exports pixel-perfect PDFs via headless Chromium.

### 7. Interactive Spaces (`/spaces/:slug`)
Instead of overwhelming Slack threads with unreadable walls of text, Ellie publishes persistent, self-hosted HTML5 micro-applications, dashboards, and research viewers directly to `/spaces/:slug`. Each space is served with zero external runtime dependencies and linked cleanly in chat.

### 8. Multi-Tier Model Routing & Context Caching
Ellie dynamically routes requests across specialized operational tiers:
* **SENTINEL** (`Gemini Flash`, temperature 0.0, low thinking): High-speed triage of incoming emails, reminder triggers, and layout checks.
* **ROUTINE** (`Gemini Flash`, temperature 0.2, medium thinking): Scheduled background synthesis, daily briefings, and folder sweeps.
* **INTERACTIVE** (`Gemini Flash`, temperature 0.3, medium thinking): Default Slack coworker threads.
* **ESCALATION** (`Gemini Flash`, temperature 0.3, high thinking): Automatically triggered after two consecutive tool errors.
* **ANALYSIS / EVALUATOR** (`Gemini Reasoning`, temperature 0.0–0.2, max thinking): Complex job scoring, deep multi-doc synthesis, and pre-publish routine verification.

**Static Prefix Caching**: The static prompt prefix (~7.8k tokens encompassing operational doctrine, governance rules, and 74 tool schemas) is registered with an explicit 1,800-second Gemini context cache, achieving ~95% cache hit rates on active threads and dramatically slashing latency and cost.

---

## 74-Tool Ecosystem Catalog

Every native tool is strictly typed with Zod schemas, assigned an effect class, and guarded by host code before invocation:

| Subsystem | Count | Highlighted Capabilities |
| :--- | :---: | :--- |
| **Google Workspace** | 14 | `gmail_search`, `gmail_read`, `gmail_draft`, `gmail_send` (consequential), `sheets_read`, `sheets_append`, `sheets_update`, `docs_read`, `docs_create`, `docs_append`, `drive_search`, `drive_read_file`, `calendar_list`, `calendar_create` (consequential). |
| **Secure Mail Bridge** | 5 | `proton_search`, `proton_list_unread`, `proton_read`, `proton_draft`, `proton_send` (consequential SMTP staging via Proton Mail Bridge). |
| **Verification & Claims** | 2 | `owner_sources_read` (batch-read identity dossier and verified claims), `owner_text_check` (pre-flight claims and humanization validator). |
| **Document Rendering** | 2 | `document_render` (linear ATS DOCX/PDF via LibreOffice), `visual_document_render` (visual one-pagers/infographics via Chromium). |
| **Memory, State & Spaces**| 15 | `memory_save`, `memory_list_facts`, `memory_record_candidate`, `memory_promote_candidate`, `reminder_set`, `result_read` (paged large-output reader), `sheet_query` (in-memory SQLite sandbox for attached XLSX/CSV files), `waiting_track`, `waiting_list`, `waiting_resolve` (follow-through tracker), `project_state_read`, `project_state_update`, `space_publish`, `space_list`. |
| **Skills & Research** | 6 | `skills_list`, `skill_read`, `skill_edit`, `job_evaluate` (multi-criteria role scoring on reasoning model), `delegate_subtask` (isolated child-agent runner), `image_generate` (Gemini image models with EXIF stripping). |
| **Web & MCP Gateway** | 21 | `web_search` (Google Search grounding), `web_read_page` (SSRF-protected web reader), `apify_linkedin_profile`, `apify_linkedin_posts`, plus Model Context Protocol (MCP) integrations for Amazon Ads, Meta Ads, and LinkedIn portability. |
| **Dynamic Composio SaaS**| 5 | `composio_search_tools`, `composio_install_tool`, `composio_setup_tool`, `composio_execute_tool`, `composio_list_installed`. Consequential SaaS tools automatically inherit Action Ledger approvals. |
| **Diagnostics & Host Ops**| 4 | `repo_list_and_search`, `repo_read_file` (sandboxed codebase introspection), `trace_inspect_recent` (glass-box run inspection), `vps_inspect` (sandboxed systemd/journalctl logs with automated secret token masking). |
| **Command & Control** | 8 | Interactive-only management tools: `routine_manage`, `reminder_manage`, `nudge_settings_manage`, `memory_manage`, `queue_manage`, `workspace_alias_manage`, `sentinel_manage`, `cost_and_budget_manage`. |

---

## Repository Structure

```
ellie-v5/
├── assets/fonts/               # Bundled OFL typography (Google Sans Text, Merriweather)
├── deploy/
│   ├── push.sh                 # Zero-downtime deployment script with atomic swap & rollback
│   └── vps.sh                  # Host bootstrap and cutover script for systemd units
├── docs/
│   ├── INVENTORY_PUBLIC.md     # Comprehensive public architecture & governance specification
│   ├── ELLIE_DESIGN.md         # Foundational architectural doctrine and hard-won lessons
│   ├── PLAN.md                 # Roadmap, completed milestones, and engineering notes
│   ├── HANDOFF-*.md            # Module handoff specifications
│   └── ARCHITECTURE_SPEC.docx  # Formatted Word specification generated via scripts
├── android/                    # Native Android companion app (Jetpack Compose, in development)
│   └── app/src/main/java/com/ellie/app/
├── skills/                     # Domain-specific executive skills & Polish language humanizers
│   ├── humanization/           # AI tell-stripping scanner and prose naturalizer
│   ├── humanizer-pl/           # Polish voice & stylistic norms
│   └── poprawna-polszczyzna/   # Contemporary Polish orthography and business registers
├── src/
│   ├── config/                 # Environment validation, model constants, allowlists
│   ├── documents/              # Dual-engine document synthesis (DOCX, HTML/SVG, PDF, fonts)
│   ├── governance/             # Action Ledger, Claims Bank Guard, Executor, Result Store
│   ├── integrations/           # Slack Coworker, Google Workspace, Proton Bridge, Composio, MCP
│   ├── memory/                 # Regularized Self-Improvement (RRSI), Wilson scoring, leakage critic
│   ├── runtime/                # UnifiedAgentRunner, prompt builder, model router, cache manager
│   ├── scheduler/              # Sentinels (Gmail, Proton, Cal), cron routines, nudge gate
│   ├── storage/                # SQLite repositories (app.sqlite, ledger.sqlite, migrations)
│   ├── tools/                  # 74 statically typed native tool definitions
│   ├── web/                    # Express control plane, REST endpoints, spaces hosting
│   ├── index.ts                # Application entry point
│   ├── wake.ts                 # 15-minute background wake timer script
│   └── test/                   # 406 unit and integration tests across 132 test suites
├── package.json                # Modern ESM Node.js >=22.13.0 dependencies
├── tsconfig.json               # TypeScript 5.8+ ES2022 configuration
└── RUNBOOK.md                  # Complete operational manual, network routing, and health checks
```

---

## Quickstart & Local Setup

### Prerequisites
* **Node.js**: `>=22.13.0` (uses native `node:sqlite` in WAL mode and native fetch)
* **LibreOffice & Poppler** *(optional for local document rendering)*: `soffice`, `pdftoppm`, `pdfinfo`
* **Google Gemini API Key**
* **Slack App Credentials**: Bot Token (`xoxb-...`), App Token (`xapp-...`), Signing Secret

### 1. Installation
```bash
git clone https://github.com/owner/ellie-v5.git
cd ellie-v5
npm ci
```

### 2. Configuration
Copy the template and populate credentials:
```bash
cp .env.example .env
```
Key configuration parameters:
* `GEMINI_API_KEY`: Google Gemini API key.
* `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`: Slack connectivity.
* `ELLIE_OWNER_SLACK_ID`: Your Slack member ID (events from other users are strictly ignored).
* `ELLIE_DATA_DIR`: SQLite storage path (defaults to `~/.local/share/ellie`).
* `ELLIE_CONTROL_PLANE_TOKEN`: Secret token required for web control plane access.

### 3. Environment Diagnosis
Run the built-in diagnostic doctor to verify models, directories, and provider connectivity:
```bash
npm run doctor
```

### 4. Running the Test Suite
The repository includes 406 offline unit and integration tests using mocked providers and realistic sandboxes:
```bash
npm test
```
To run tests directly against TypeScript source with `tsx`:
```bash
npm run test:ts
```

### 5. Running the Server
```bash
npm run build
npm start
```

---

## Production Deployment & Operations

Ellie is designed to run 24/7 on a Linux host (Ubuntu 24.04 LTS or Debian) under `systemd` user units, interconnected securely via [Tailscale](https://tailscale.com).

* **Public Webhook Endpoint**: Exposed via Tailscale Funnel to `/api/slack/events` and Google OAuth redirects.
* **Control Plane & Spaces**: Accessible on a private Tailscale IP (e.g. port `10000`) without public exposure, authenticated by socket origin.
* **Atomic Zero-Downtime Deployments**:
  Deployments run from the repository root via `deploy/push.sh`:
  ```bash
  bash deploy/push.sh
  ```
  The deployment script uploads committed `HEAD` to a staging directory on the host, runs `npm ci`, compiles TypeScript, executes `doctor`, and performs an atomic directory swap before restarting `ellie.service`. Automatic fallback to `~/ellie.prev` is preserved on failure.

For complete operational procedures, backup restoration, and service monitoring, consult **[RUNBOOK.md](RUNBOOK.md)**.

---

## Technical Documentation & References

* **[Public Architecture & Governance Specification](docs/INVENTORY_PUBLIC.md)**: Exhaustive breakdown of system topology, model routing parameters, and tool catalogs.
* **[Ellie Design Doctrine](docs/ELLIE_DESIGN.md)**: Engineering manifesto, failure mode analysis from earlier generations, and the philosophical principles behind host governance.
* **[Operational Runbook](RUNBOOK.md)**: Day-to-day administration, network architecture, and diagnostic troubleshooting.
* **[Product Roadmap & Engineering Plan](docs/PLAN.md)**: Live tracking of milestones, live test traces, and performance telemetry.

---

## License

This project is licensed under the [MIT License](LICENSE).
