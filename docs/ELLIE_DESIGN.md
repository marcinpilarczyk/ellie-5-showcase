# Ellie: Design Document and Lessons Learned

Status: living document. Written 2026-10-12 against `main` at `267cc94` (127 commits, 2026-10-04 to 2026-10-10).

> **Three codebases.** Sections 3 to 9 describe **Ellie v2** (`ellie-v2`, about 27,900 LOC) as it stood at `267cc94`. **Ellie v4** (`ellie-v4`, 2026-10-13) was a partial rebuild that kept running on v2's databases and config; its post-mortem is [section 10.8](#108-ellie-v4-status-against-this-plan). **Ellie v5** (this repo, `ellie-v5`, 2026-10-14) is the clean cutover: [section 10.9](#109-ellie-v5-the-clean-cutover).
Replaces the deleted `docs/ELLIE_V2_HARDENING_PLAN.md` and `docs/GROKBOT_VIKTOR_TRANSITION_SPEC.md`, whose useful content is folded in here. The token plan stays separate in [plans/token-reduction.md](plans/token-reduction.md).

Purpose: if Ellie were rebuilt from zero, this is the brief. It records what we are trying to build, what the current code does, why each big decision was made, what went wrong, what other agents do well, and a recommended build order that avoids the known mistakes.

How to read it. Section 1 to 3 say what and why. Section 4 is the architecture as built. Section 5 is the decision log. Sections 6 and 7 are the honest ledger of failures and wins. Section 8 is other agents. Section 9 is open ideas. Section 10 is the from-scratch plan, and it is the part to read first if you are about to start over.

Evidence labels used throughout: **[code]** verified in this repo, **[git]** taken from a commit message or history, **[plan]** from the token-reduction plan (production measurements of 2026-10-09), **[memory]** from Claude Code's project memory notes about the owner's decisions, **[general]** industry practice from my own knowledge, not checked in this session. Treat [general] as hypotheses to verify, not facts.

---

## 1. What we are building

### 1.1 One sentence

A private AI chief of staff for one person: it reads their mail, calendar, trackers and the web, does the reversible work on its own, and asks before anything leaves the building. It is reachable in Slack and a small web UI, and it also works unprompted on a schedule.

The product line from the code: **"Ellie owns the work. The owner owns decisions and commitments. Host code owns authority."**

### 1.2 Who it is for

One user (single-tenant, single-owner). Every design choice that looks like over-engineering for one person (signed webhooks, CSRF, actor identity, claims bank) exists because the agent reads untrusted text (email, web pages, LinkedIn posts, calendar invites) and holds real credentials. The threat is not other users; it is the content the agent reads.

### 1.3 Jobs it was built to do

From the retired transition spec [git 1aa6e6d] and the current routine seeds [code `src/config/routines.ts`]:

| Job | Shape |
| --- | --- |
| Job-search sourcing | Daily scan for vacant roles/companies against criteria and an exclusion list; append rows to a tracker; draft (never send) connection notes. 10 to 15 evidenced candidates, zero rather than padding. |
| Advisory-business prospecting | Weekday sourcing of about 10 new prospects plus a reserve list; notes under 300 characters, native Polish or English; stays unsent in a tracker. |
| Research packs | Twice-weekly newsletter angle research; weekly "what moved" scan across X, HN, YouTube, Reddit. Research only, no autonomous publishing. |
| Read-only analytics | Weekly ad-performance review (Amazon Ads, Meta) comparing last 7 days to the prior 7. Never touches bids or budgets. |
| Silence-is-valid watchers | Manuscript folder checks that speak only if something changed. |
| Weekly commitment balance | Calendar versus actual movement across projects; flag collisions; recommend, never move events. |
| Inbox and calendar sentinels | Classify inbound mail (Gmail and Proton), draft replies, surface what needs the owner. |
| Morning brief | A short prose briefing, not labelled bullets. |
| Reminders | Natural-language reminders delivered in Slack. |
| Ad-hoc chat | "Evaluate this job link", "make a PDF resume", "clean up this tracker". |

The important pattern: **most of the value is read, summarise, draft, and keep records straight.** The consequential actions (send, publish, spend, share) are rare and always human-approved.

### 1.4 Success criteria

1. Nothing consequential happens without the owner's explicit approval of the exact payload.
2. Ellie never states something as done that was not done, and never states a number she cannot trace.
3. She is quiet by default. A noisy agent gets ignored within days and the guardrail is gone.
4. Cost per useful result is predictable and observable.
5. The owner can pause it completely, and knows every thing that could wake it.
6. The owner can fix wrong behaviour by talking to her, not by deploying code.

Criterion 6 is the one the project underserved. See sections 6.7 and 6.8.

---

## 2. Design principles (the non-negotiables)

These are the rules that survived contact with reality. Each has a failure behind it (section 6).

- **P1. The model reasons; deterministic host code governs.** Anything that decides authority, identity, spending or "is it true" runs in plain code, not in a prompt.
- **P2. Authority is classified by effect in the world, not by API name.** Four classes: `READ`, `LOCAL_WRITE`, `INTERNAL_REVERSIBLE_WRITE`, `CONSEQUENTIAL` [code `src/types/tool.ts`].
- **P3. Unknown means consequential.** An unreviewed external tool, a changed tool definition, a missing field: all fail closed to "needs approval, never in the background". Never a verb-guessing denylist.
- **P4. Per-run explicit tool grants.** The set of tools a run may call is decided by code per run kind. Scheduled runs get read-mostly grants. Visibility of a tool is not authority to run it.
- **P5. One approval path.** Every consequential action is staged as an exact payload in an Action Ledger, approved by an authenticated human, then executed once.
- **P6. Background work can investigate and propose; it cannot commit.** No sends, no config changes, no memory writes with durable effect.
- **P7. A provider's "OK" is not "it happened".** Every write ends with a read-back. Ambiguous outcomes become `RECONCILIATION_REQUIRED` and are never blind-retried.
- **P8. Facts must trace to evidence.** Figures in replies must come from a tool result, the owner's words, or memory. Claims about the owner in outreach must come from a Claims Bank or the draft is blocked. Claims of completed actions are checked against the ledger.
- **P9. Learn slowly and by scope.** One edit never becomes doctrine. Candidate, corroborated, promoted. Global rules come only from the owner saying so.
- **P10. Quiet by default.** Every proactive message passes one gate (quiet hours, daily cap, dedupe, digest).
- **P11. Fail closed on config.** Missing signing secret, token, or webhook secret disables the feature; it never downgrades to "open".
- **P12. Owner data is not code.** Names, IDs, exclusion lists and routine seeds live in config (a Google Doc the owner and Ellie can edit, a private directory, `.env`), never in `src/`.
- **P13. Tell the truth about off.** Pausing a project is not switching it off. Every trigger (timers, webhooks, scheduled jobs in other accounts) has an owner and a kill list.

---

## 3. What exists today

### 3.1 Size and shape [code]

- TypeScript on Node 22, ES modules, Express 4, built-in `node:sqlite`, Zod for schemas, `@google/genai`, `@modelcontextprotocol/sdk`, `googleapis`, `imapflow`/`nodemailer` (Proton), no framework for the UI (plain JS in `public/`).
- About 27,900 lines of source and 14,800 lines of tests across 48 test files; CI builds and tests on Node 22 and 24 with no live credentials.
- 41 native tools registered in `src/runtime/build-runtime.ts`, plus dynamically discovered MCP and Composio tools.
- 7 days from first commit to the last feature merge, 127 commits, 32 PRs. A hardening programme followed a code review on day 4.

### 3.2 Surfaces

| Surface | What | Notes |
| --- | --- | --- |
| Slack (primary) | Owner-only DM and threads, native Agent view, streaming status, Approve/Reject cards, proactive nudges | Slack events and button clicks verified by signature and owner user ID |
| Web UI | Chat, Today (attention-first), Routines, Responsibilities (objectives), Costs, Settings | Token login and CSRF; rendered model output is sanitised (DOMPurify) |
| Wake worker | `dist/wake.js` every 15 minutes via systemd timer | Starts due routines, runs due objectives, runs sentinels, delivers reminders and the brief |
| Webhooks | Gmail Pub/Sub and Calendar push (optional), Slack events | All fail closed without their secret |

### 3.3 Module map (`src/`)

| Dir | Responsibility |
| --- | --- |
| `runtime/build-runtime.ts` | The single composition root. Web server and wake worker both call it. |
| `governance/` | Dispatcher, AuthorityPolicy, Action Ledger lifecycle helpers, claims bank, read-back, all native tools (Gmail, Proton, Drive, Docs, Sheets, memory, routines, objectives, reminders, skills, web, social search). |
| `agent/` | `loop.ts` (the tool-calling engine and system prompt), interactive conversation service, subagents (role-scoped helpers), claim checker, repetition detector, feedback learner, skills loader, chat handoff. |
| `scheduler/` | Objective engine and repository, routine engine, tuner and reviewer, cron/time parser, event router, sentinels (Gmail, Calendar, Proton), reminder dispatcher. |
| `situational/` | Hypotheses, artifact relevance, dynamic watches, impact analysis, work view, morning brief. |
| `presentation/` | Chief-of-staff presenter, voice rules, reply standard, communication policy, nudge gate, blocker classifier. |
| `integrations/` | Google (OAuth, Gmail, Drive, Sheets, Calendar), Slack (service, inbound, proactive, formatter, signature), Proton Bridge, Apify (LinkedIn), web search/read, MCP manager, Composio manager, link-tracker pipeline. |
| `storage/` | Two SQLite databases (app and ledger), repositories, schema. |
| `http/` | Auth middleware, routers per area, webhook routes. |
| `models/gemini.ts` | The only model adapter. |
| `config/` | Owner config loader, routine seeds. |

### 3.4 Persistence [code `src/storage/schema.ts`]

Two SQLite files. The **ledger DB** holds only `action_ledger` and `action_ledger_events` (append-only history), deliberately separate from the app DB. The **app DB** holds about 30 tables: `integrations`, `mcp_servers`, `external_action_authority`, `memory_facts`, `preference_candidates`, `objectives`/`objective_runs`/`objective_events`, `routines`/`routine_versions`/`routine_runs`, `chat_threads`/`chat_messages`, Slack mappings and processed-event dedupe, `sentinel_inbox_items`/`sentinel_briefings`, `failure_evidence`, `api_usage`, situational tables (`situational_hypotheses`, `artifact_relevances`, `dynamic_watches`, `impact_assessments`), `scheduled_reminders`, `nudge_log`, `owner_config_cache`.

### 3.5 Deployment [code `deploy/`, memory]

One VPS, systemd user units: `ellie-v2.service` (web, port 3001), `ellie-v2-wake.timer` plus `.service` (15-minute worker), `proton-bridge.service` (snap, IMAP/SMTP on localhost). Deploy is `git pull && npm ci && npm run build && systemctl --user restart ellie-v2`. The owner has had to restate the deploy procedure many times, so it is now recorded in memory and `deploy/README.md`. An optional private no-login listener on `127.0.0.1` is meant to be exposed only through a tailnet.

---

## 4. Architecture as built

### 4.1 Layers

```
Surfaces:  Slack (events, interactions) | Web UI | Wake worker | Webhooks
              |                              |           |
Conversation + scheduling:  InteractiveConversationService | ObjectiveEngine / RoutineEngine / Sentinels
              |                                             |
Agent engine (loop.ts):  prompt = system + memory + skills + surface style;  model <-> tool rounds
              |
ToolDispatcher:  existence -> per-run grant -> AuthorityPolicy (external) -> effect class
              |         CONSEQUENTIAL -> stage in Action Ledger (never execute here)
              |         READ / LOCAL / REVERSIBLE -> validate (Zod) -> execute -> read-back
              |
Tools:  native (Gmail, Drive, Sheets, ...) | MCP gateway tools | Composio actions | helpers
              |
Storage:  app.sqlite | ledger.sqlite        Owner config:  Google Doc | private/ | .env
```

### 4.2 The dispatcher: the heart of the system [code `governance/dispatcher.ts`]

Every tool call from every run goes through `ToolDispatcher.dispatch`:

1. The tool must exist.
2. The run's `toolGrant.allowedToolNames` must include it (P4).
3. For external tools, `AuthorityPolicy.evaluate(ref, mode)` returns `EXECUTE`, `STAGE` or `DENY`; the tool's own metadata is ignored.
4. If the effective class is `CONSEQUENTIAL`: refuse unless the run is interactive and `allowConsequential` is true; otherwise validate params and `stageProposal` into the ledger. The model gets back `STAGED_FOR_APPROVAL` and an action ID. Nothing has happened.
5. Otherwise Zod-validate and execute.
6. For `INTERNAL_REVERSIBLE_WRITE`, run a read-back and attach `{status: VERIFIED | ABSENT | INCONCLUSIVE | UNAVAILABLE}` plus a warning string the model is expected to respect.

This function is about 120 lines and is the single most valuable part of the codebase. Rebuild it first.

### 4.3 AuthorityPolicy for third-party tools [code `governance/authority-policy.ts`, `reviewed-baseline.ts`]

- Rows in `external_action_authority`, keyed by `(source, key)` where source is `mcp`, `composio` or `connector`.
- A review records effect class, interactive/background permission, approval requirement, read-back spec, metered flag, risk, reviewer, time.
- A **fingerprint** (SHA-256 of canonicalised name, description and input schema) is stored with the review. If a server later changes a tool's definition, the review is void and the tool is `CONSEQUENTIAL` again.
- A repo-kept **reviewed baseline** pins specific read tools (the Ellie Gateway's LinkedIn reads) to exact fingerprints so a fresh database does not post approval cards for safe reads. It only fills gaps; it never overrides a review recorded through the host.
- Incomplete discovery metadata means the tool is not registered at all.

### 4.4 Action Ledger [code `types/action.ts`, `storage/action-ledger.ts`]

States: `STAGED -> APPROVED -> EXECUTING -> PROVIDER_CONFIRMED -> VERIFIED`, with `DENIED`, `FAILED_SAFE` (provably no effect) and `RECONCILIATION_REQUIRED` (truth unknown) as the other terminals. Properties:

- Payload is canonicalised and hashed. Edits recompute the hash.
- Approval expires (default 15 minutes).
- Atomic claim before execution so one approval produces at most one provider effect.
- Event history records the real prior state at each transition.
- Lives in its own SQLite file.
- One executor (`approved-action-executor.ts`) is shared by the web "execute" route and the Slack Approve button. Before it existed, Slack Approve only knew Gmail and Sheets and unknown types fell through to the Gmail executor.

Generic MCP/Composio writes use the same lifecycle. A read-back can be declared as a **companion read** (`ReadBackSpec`: which read tool, with which parameters, and which strings must appear), itself required to be reviewed as `READ`. Without one, the action stays `PROVIDER_CONFIRMED` (unverified) and is reported that way.

### 4.5 Run kinds and grants

| Run kind | Entry | Grant | Consequential? |
| --- | --- | --- | --- |
| Interactive (Slack, web) | Owner message | Large named list (about 40 tools plus connected MCP tools) | Stages for approval |
| Objective step (routine, handoff, proactive) | Wake worker or immediate chain | Routine-specific grant owned by the seed (`private/routines.json`) | Never |
| Sentinel | Wake or webhook | Narrow classifier plus draft | Drafts only, gated by the claims bank |
| Helper (subagent) | `delegate_subtask` | Role-specific read tools intersected with the caller's grant | Never |
| Companion read | Read-back | Single read tool | Never |

Chat handoff: when an interactive turn hits its round or time cap, the remainder becomes a background objective tied to the same thread. The handoff grant is the interactive grant minus sends and anything that changes Ellie's own configuration or memory (`NOT_FOR_BACKGROUND`).

### 4.6 Agent engine [code `agent/loop.ts`]

- Gemini SDK `chats.create` multi-round loop. Defaults: 5-minute timeout; 8 tool rounds interactively, 16 for objective steps; bounded tool-call and token budgets.
- System prompt of about 10 KB: operating principles (act, don't offer; conclusions first; brevity; honest evidence; evidence priority), voice and dry-wit rules, surface-specific style, provider notes, self-diagnosis, conversation-language rule.
- Memory context and installed-skill descriptions are appended per run.
- After the model answers, host code runs:
  - **offer detector** ("would you like me to...") and nudges the model to act;
  - **reply standard** (no preamble; every figure must be grounded);
  - **claim checker** (claims of sent/created/updated/deleted things are matched against tool calls and the ledger, in English and Polish);
  - **claims-bank guard** on outreach segments;
  - **repetition detector** for loops.
- Failures are written to `failure_evidence`; cost rows go to `api_usage`.

### 4.7 Objectives, routines, wake worker [code `scheduler/`]

- **Objective** = a durable unit of owned work: goal, success criteria, plan with steps, next action, waiting condition or blocker, attempts, lease, next review time. Dispositions are `CONTINUE | WAIT | NEEDS_USER | COMPLETE | FAILED`, validated by `validateObjectiveDisposition` (e.g. `COMPLETE` requires every plan step done).
- **Routine** = a cron-scheduled template. The wake worker computes `lastFireTime` in Europe/Warsaw, catches up a missed window once, and instantiates an objective only when a window has opened.
- A **Pro-model evaluator** reviews worker output for grounding and quality. Optimistic concurrency and leasing prevent double runs; retries are bounded and back off.
- **RoutineReviewer/Tuner** analyse evaluator scores and failures and can only *propose* prompt changes. Background runs cannot apply them [git f3026d7].
- Tool grants for routines are owned by the seed file, not editable by Ellie.

### 4.8 Sentinels and situational awareness

- Gmail, Proton and Calendar sentinels classify inbound items (email bodies capped at 1,500 characters, temperature 0), draft replies behind the claims-bank gate, and route to objectives through an event router.
- The situational engine builds hypotheses about what matters, links artifacts, creates dynamic watches, and runs an impact analyzer. A work-view and morning brief sit on top. It is the least battle-tested part (section 6.9).

### 4.9 Presentation [code `presentation/`]

- Chief-of-staff presenter turns run facts into messages. Failure classification uses the **blocker**, not the free-text run summary (a past bug produced phantom approval alerts) [git 6c3ea4e].
- `NudgeGate`: every proactive Slack message goes through quiet hours (default 21:00 to 08:00, Europe/Warsaw), a daily cap (8), dedupe by key over 24 hours, and a held-message digest.
- Approval cards are plain language ("Read LinkedIn messages"), not tool names and action IDs [git f9fc278].
- One voice per Slack thread: turns are serialised per thread, so a follow-up sees the reply in progress rather than racing and contradicting it [git d9a7bf8].

### 4.10 Memory and learning

- `memory_facts`: typed (`PREFERENCE | POLICY | CONTACT | PROJECT_FACT | DECISION`), per domain, with provenance, confidence, supersession, staleness, and a secret detector that refuses to store credentials.
- `preference_candidates`: scoped (recipient, workflow, domain, global). One rejection or edit makes a candidate; a second matching one corroborates; a third, or owner confirmation, promotes it to a single stable fact. Opposite evidence counts against it. Global rules only come from the owner.
- Only `executive` facts are loaded into every prompt (about 1k tokens at present).

### 4.11 Owner configuration homes [code `config/owner.ts`, memory]

| Home | Contents | Who edits |
| --- | --- | --- |
| `ELLIE_CONFIG` Google Doc | About, search preferences, never-resurface list, meeting windows and exceptions | Owner and Ellie, in chat, no deploy |
| Professional record Doc, Claims Bank Doc | Fit judgement source; the only specifics outreach may assert | Owner |
| `private/` on the server | `routines.json` (seeds and tool grants), `never-claims.json`, avatar | Owner only, deliberately not Ellie |
| `.env` | Identity, IDs, secrets, tuning | Owner |

Rule: no owner-specific fact in `src/`. Tests run against `test.env` with no private directory and generic example routines.

### 4.12 Security posture [code `http/`, git]

Single shared control-plane token with cookie session and CSRF; auth fails closed for every non-allowlisted path (case-insensitive); actor identity comes from the session, never the request body; webhooks need their secrets; Slack events and interactions are signed and owner-only, with replay dedupe; MCP stdio registration over HTTP removed; gateway key sent only to the exact configured origin and redirects refused; model output sanitised before rendering; production refuses to start without the control-plane token.

---

## 5. Decision log

| # | Decision | Why | Cost / revisit when |
| --- | --- | --- | --- |
| D1 | Host code owns authority, model owns reasoning | Prompts are not a security boundary; the agent reads hostile text | Every new tool needs a classification. Worth it. |
| D2 | Four effect classes, `CONSEQUENTIAL` always staged | Simple enough to review, enough to express send/publish/spend | Calendar events and shares needed special treatment (invites email people). |
| D3 | Unreviewed external tool = `CONSEQUENTIAL`; review pinned to a definition fingerprint | A verb-based denylist fell through to `READ` and let `GMAIL_REPLY_TO_THREAD` run unapproved [git 03f1733] | New gateway reads need a baseline entry or they ask approval every time. |
| D4 | Separate ledger database | Audit trail should survive app-DB resets and be easy to back up and inspect | Two files to back up. |
| D5 | Read-back after every write; provider OK is not verification | Models and APIs both say "done" when it isn't | Needs a verify hook per tool; unverifiable writes are reported as such. |
| D6 | Background cannot commit and cannot change config | Nobody watches 3 a.m. runs | Handoff continuations are therefore limited; see D17. |
| D7 | Slack as the primary surface, web UI secondary | The owner lives in Slack; approvals in-thread are one tap | Slack-specific complexity (threads, sessions, signatures, formatting) is large. |
| D8 | Gemini Flash for workers, Pro as evaluator/arbiter | Cheap volume, stronger judgement where it matters. About $4 per week at Gemini rates [plan]. | Provider switch to Claude could be about 10x the cost at the same volume [plan]; cost accounting is not provider-neutral. |
| D9 | `node:sqlite`, two files, no ORM | Zero ops, single VPS, easy to inspect | Hand-written SQL everywhere; no migrations framework. |
| D10 | Single composition root (`buildRuntime`) shared by server and worker | Avoids two diverging wirings | 500-line constructor wall; hard to test pieces alone. |
| D11 | Owner data out of code (PR #30) | Repo should be publishable; content fixes should not need deploys | Config loading adds a Drive dependency on the hot path (cached). |
| D12 | Claims Bank: deterministic check of every number and named result in outreach against one owner-owned document; unreadable bank blocks everything | Confident wrong numbers are the real brand risk | Blocks drafts when the Doc is unreachable. Intended. |
| D13 | Reply standard enforced in host code (brevity, no preamble, ungrounded figures revised) | Prompts alone drifted into long, padded replies | A failed check triggers a full extra model round with all tools [plan item D]. |
| D14 | Scoped graduated learning | One-shot edits had been written as 0.9+ confidence global preferences [git f3026d7] | Slower to adapt; owner can still say "always". |
| D15 | Nudge gate for all proactive messages | Alerts were wallpaper | Held messages arrive late as a digest. |
| D16 | Skills as markdown files read on demand (`skill_read`) | Humanizer and Polish-language rules are large and rule-heavy | Full reads are 20 to 43 KB and are replayed every round (plan C). |
| D17 | Chat handoff passes request plus partial answer only | Quick to build | Loses evidence, so continuations repeat searches or duplicate Docs. Known bug [plan root cause 5]. |
| D18 | Situational engine (hypotheses, watches, impact) | "General agency": notice what matters without being asked | Large surface, hard to evaluate. Revisit its value before rebuilding it. |
| D19 | MCP gateway ("Ellie Gateway") plus Composio for long-tail integrations | Avoid writing every connector natively | Dynamic tool lists inflate every prompt (about 17 gateway tools of about 57 declared) and complicate cache stability. |
| D20 | Pause, don't delete (2026-10-10) | Owner stopped due to friction | A paused project still costs: timer, server, and any third-party trigger [memory]. |

---

## 6. What went wrong

Grouped by cause, not by date. Each item says what happened, the root cause, and the rule it produced.

### 6.1 Authority and safety bugs found in the day-4 review [git]

| Incident | Root cause | Lesson |
| --- | --- | --- |
| `/API/actions/:id/execute` skipped auth because the guard matched lowercase `/api/` only (Express routing is case-insensitive); action routes then defaulted the actor to the owner. An unauthenticated caller could approve and execute a send. | Allowlist-by-prefix instead of deny-by-default; a convenient default actor. | Auth is a default-deny middleware on everything; there is no default identity. |
| Composio/MCP actions classified by a keyword denylist fell through to `READ`: reply, forward and calendar-event creation ran without approval, even in background runs. | Guessing from names. | P3. Explicit reviews, fingerprints, unknown = consequential. |
| Slack Approve only executed Gmail and Sheets; Composio stayed "approved but unrun"; Proton and MCP types fell through to the Gmail send executor. | Two approval paths written at different times. | One executor, one path, refuse unknown types unclaimed. |
| Gmail/Calendar push webhooks started model-backed runs for any caller. | Endpoint existed with no registration and no secret. | Cost amplification is an attack. Unregistered endpoints must not exist. Require secrets or disable. |
| Slack events accepted unsigned when the signing secret was unset. | Dev-mode convenience became prod fall-open. | No unsigned mode in any environment. |
| Rendered model output went straight into `innerHTML`; calendar titles were interpolated unescaped. | Output can quote inbound emails and web pages. | Treat model output as untrusted HTML. Sanitise, pin CDN libraries with SRI. |
| `ELLIE_MCP_GATEWAY_KEY` was attached by record ID or URL substring, and `mcp_manage ADD` could repoint the record from chat. | Credential routing by string match. | Credentials go to one exact parsed origin; refuse redirects; chat cannot overwrite a server record. |
| Ledger event history claimed a `PROVIDER_CONFIRMED -> VERIFIED` transition from `EXECUTING`; runtime invented a `mock-key` Gemini key when none was set. | Convenience fallbacks that lie. | Record the real prior state. Missing mandatory config must fail loudly. |

Takeaway: **the strongest ideas (ledger, read-back) were in the first milestone, but the surrounding product was built faster than its boundary was reviewed.** The hardening plan listed 10 steps; steps 1 to 4 and 7 shipped; steps 5 (control-plane write class), 6 (metered-read budgets), 8 (evaluator decoupling) and 10 (adversarial suite) are not marked done in the repo. Treat them as open (section 9).

### 6.2 Cost and latency (the token problem) [plan]

- A "make a PDF resume" request took 90 s and billed about 177k prompt tokens plus about 5.6k thinking tokens not in the cost estimate.
- Worst Slack turn that day: **2.08M prompt tokens**, 30 tool calls, two sheet reads of 103 KB and 71 KB replayed every later round.
- Fixed prefix of about 11k tokens per call (about 2.6k system prompt, about 1k memory, about 57 tool declarations).
- 7 days of chat: 39.1M prompt tokens across 286 usage rows.

Root causes: quadratic replay (every round re-sends every tool result), no size limit on tool results, no history budget, sequential tool execution, handoff that drops evidence, and cost accounting that ignores cache discounts, thinking tokens and the fallback synthesis call.

Lessons: **measure tokens per request before building features** (the telemetry step is still not done), give tool results handles and retrieval tools rather than truncating, and make the stable prefix byte-stable so caching works.

### 6.3 Background and autonomy failures

- Evaluator outage re-ran the full worker every 15 minutes with no cap and nested "Retry evaluation for:" prefixes; execution errors left `next_review_at` in the past so the objective was due again immediately. Both re-billed forever [git eaaba8b]. Lesson: every retry loop has a cap and a backoff, and every failure state has an exit.
- An evaluator score of 80 owned the state machine, so a legitimate WAIT could become CONTINUE because of a low stylistic score. This is hardening step 8 and it is still open: `objective-engine.ts` still gates on `evalResult.passed && evalResult.score >= 80` (lines 407, 550, 567 as of `267cc94`).
- Chat handoff loses evidence (D17); a continuation can redo searches or create a second copy of a Doc.
- Background runs once could change their own prompts via the tuner; now proposals only.

### 6.4 Truthfulness and presentation

- Ellie replied in Polish to an English message because an explicit language rule was lost in a prompt rewrite. Lesson: prompt rules need regression tests, because prompt edits silently drop rules. The fix added a test asserting the rule is in the assembled system prompt [git 4713e4c].
- Phantom "approval required" and "auth required" alerts: failure classification scanned the model's free-text summary, so "no pending approvals" triggered an alert. Lesson: classify from structured fields, never from prose.
- Fifty alerts about one dead Google login. Lesson: dedupe key per condition, clear on recovery [git adceae2].
- Robotic cards and follow-up notes ("accepted by provider but NOT verified"). Lesson: the owner reads these on a phone; say what Ellie wants to do in the owner's words.
- Approval cards went to the default channel, not the DM the request came from [git 4713e4c]. Lesson: carry the origin (`SlackOrigin`) through every layer.
- Slack follow-ups raced in-progress replies and contradicted them. Lesson: serialise per thread.
- Reconnected Google login lost to a stale older row; refreshed tokens overwrote the new row [git adceae2]. Lesson: one credential row per provider, written where it was read.

### 6.5 Integration friction

- Proton Mail Bridge exits cleanly after self-update and `Restart=on-failure` left it down for days (2026-10-06); needs `Restart=always`. VPS has no keychain, so the Bridge vault is stored unencrypted [code `deploy/README.md`].
- Header-mapped Sheets append exists because trackers are written by other systems and column order drifts [git 73fa01d].
- LinkedIn needed Apify; "personal cookie fallback" exists but is risky; the Apify token went in query strings (open item in 6.1/hardening step 6).
- Web pages are cut at 15,000 characters with no paging; content beyond that is unreachable [plan B].
- Google Docs reader takes only a document ID; no range or section, so any size cap would have left Ellie unable to ask for a smaller piece [plan].

### 6.6 Engineering process

- **Speed outran review.** 127 commits in 7 days. Features landed first (autonomy, situational reasoning, learning, closed loops, 1-tap approvals) and the security review came on day 4. The first commit message says "Milestone 1" but the hardening backlog was already implied by the milestone name: ledger plus fail-closed dispatcher were right; everything outside them needed the same rigour from the start.
- **Multiple agents, no stable spec.** The codebase was written by Claude and other assistants in turns. Commit trailers show Claude Opus/Sonnet; hardening steps were written as "AV handoff" prompts for another agent; a ChatGPT review shaped the token plan [memory]. Each pass re-derived context. Conventions came from tests and commit messages, not a written architecture. This document exists to stop that.
- **Docs went stale.** The hardening plan's status table said everything was `TODO` after most steps shipped; a follow-up PR was needed just to correct it. Deleted plans (hardening, transition spec) lived only in git history until now.
- **Test file sizes hide cost.** `slack_conversation.test.ts` is 2,443 lines and `http_control_plane_auth.test.ts` is 1,154. Large tests are a symptom of large wiring, not of thorough design.
- **Repo hygiene.** A zero-byte `data/app.db` and ad-hoc `test_*.mjs` scripts were committed; `skills/` and `.agents/skills/` are duplicated copies; `.sqlite` files sit next to source in a cloud-synced Google Drive folder (risky: sync can corrupt a live SQLite file). Remote `main` was merged by hand via PRs, with "Merge main into ..." merges.
- **Development friction ended the project.** The owner paused on 2026-10-10 ("too much hassle") [memory]. Contributing causes visible in the repo: owner-data baked into code until day 6; deploy steps repeated to the assistant "many times"; every Ellie quirk tempting a code change instead of a chat correction; a large surface (27.9k lines) for one user.

### 6.7 Things that should have been Ellie fixing herself

The owner's rule [memory `ellie-fix-vs-code-fix`]: wording, structure, content errors, misuse of a documented tool, or redoing output are **Ellie's to fix in chat**. Code is for a missing or broken capability, or a failure that recurs even when she uses the tool correctly. A real example: the PDF resume came out wrong because Ellie used markdown syntax her tool doesn't list; extending the parser (####, ---, bullets) was the wrong reflex.

Design implication: build the agent so corrections can be given as text and stored (skills, memory, config Doc) and so the owner can see *why* it did something (run trace). Without a trace the owner cannot tell which bucket a problem is in.

### 6.8 Pause is not off

Stopping work left the 15-minute wake timer, the server and any triggers in Google accounts running [LinkedIn post draft, memory]. The old v1 app (`ellie-production`, port 3000) kept its own units and Tailnet proxy until 2026-10-10. A listed inventory of every trigger belongs in the runbook (section 10.6).

### 6.9 Things that might be over-built (honest uncertainty)

I could not verify value from production data in this session; this is a judgement from code size and commit history.

- **Situational engine** (hypotheses, artifact relevance, watches, impact, work view): about 2,500 lines with 649 lines of tests, introduced as "general agency". No evidence in the repo of how often it produced a decision-changing result. Rebuild only if a measured use case demands it.
- **Closed-loop routine auto-tuning**: now proposal-only; value depends on how many routines exist. For a handful, a human reading evaluator defects is cheaper.
- **Dry-wit voice system**: a long prompt section, repeated across presenter and loop. Reasonable personality, but it costs about a third of the system prompt.
- **Helpers (4 role subagents)**: role prompts are sent in the user turn on top of the full interactive system prompt, so helpers read two identities [plan].

---

## 7. What worked and should be kept

1. **The dispatcher with explicit grants** and the fail-closed default. No model behaviour change was needed to fix any authority bug; only host code.
2. **Action Ledger with canonical payload hash, atomic claim, expiry and the full state machine**, including `RECONCILIATION_REQUIRED`.
3. **Read-back as a first-class concept**, including declarative companion reads for third-party writes.
4. **Fingerprint-pinned reviews** for third-party tools.
5. **Claims Bank guard** and **figure grounding check**. Cheap, deterministic, and aimed at the failure that would actually cost the owner.
6. **Owner-config split** (Doc for what Ellie may edit, private dir for what she may not, env for secrets). It matches the fix-vs-code rule.
7. **Graduated learning** with scope and evidence counts.
8. **Nudge gate**, **one voice per thread**, **plain-language approval cards**.
9. **CI that runs without credentials**, mocking at the boundary.
10. **Cron in an explicit timezone with catch-up-once semantics**; DST-safe slot handling.
11. **A single composition root** so tests and the worker see the same wiring.
12. **Measured evidence** (production numbers in the token plan) instead of guessing.

---

## 8. What other agents do well

### 8.1 Evidence from this project

- **Viktor.com** [git transition spec]: strong routine semantics and prioritisation (some routines are never throttled), a good pattern of "silence is a valid output" for watchers, and polished integrations. Weakness: **96% of 153,000 credits in 30 days went to chat and polling; 10 of 11 routines had to be paused.** Lesson: a managed agent's credit model punishes polling, so poll in cheap code and call a model only when something changed.
- **GrokBot (xAI)**: provided the live X/web-reading routines. The spec records hard rules it taught us: X is read-only; ad accounts are read-only; North-America numbers must not be shown as zero when the profile is restricted. These became hard constraints in routines.
- **ChatGPT review** of the token plan [memory]: added the point that a size cap without a retrieval tool strips capability, led to "visibility is not authority", and the B-to-E additions.
- **Claude (this tool) on this codebase**: strongest at review, writing tests alongside fixes, and writing handoff prompts; weakest when it re-derived context each session.

### 8.2 General patterns worth copying [general; verify before adopting]

| Pattern | Seen in | Why it helps Ellie |
| --- | --- | --- |
| Permission modes with plan-then-approve; per-tool allow/deny rules; hooks that can block a call | Claude Code | Maps onto grants and the ledger; hooks suggest a clean place for policy checks outside the prompt. |
| Tool results written to disk or a store, with the model getting a path/handle and search tools | Coding agents generally | Direct answer to quadratic replay (token plan step 2). |
| Context compaction/summarisation when a threshold is passed, with pinned instructions | Claude Code, many chat products | Bounded working context (step 5), but keep evidence pinned. |
| Subagents with their own context and a narrow tool list, returning only a summary | Claude Code | Keeps big reads out of the parent; fix Ellie's helper prompt duplication. |
| Skills loaded on demand by description, with scripts alongside | Claude skills | Already used; extend with "read once, keep out of replay". |
| Prompt caching with a stable prefix and breakpoints | Claude API | Makes the replay cheap; needs byte-stable tool order and no timestamps near the top. |
| Durable execution (a workflow engine with checkpoints and retries) | Temporal-style systems, some agent platforms | Replaces hand-built leasing, backoff and `next_review_at` logic. Probably overkill for one user, but the model is the right one. |
| Evals on recorded real tasks before changing prompts or models | Most mature agent teams | Missing here; the plan relies on replaying real requests. |
| Structured outputs and typed tool schemas instead of regex-parsing JSON out of prose | Provider SDKs | `extractWorkerPlanProposal` scans text for JSON blocks; structured output removes a failure class. |
| Observability: one trace per run with each model call, tool call, tokens, latency | LLM ops tools | The telemetry step. Without it every cost claim is a guess. |
| Human-approval queue as the central UX | Customer-support and finance agents | Already the model; invest in making cards trivially understandable. |

---

## 9. Open items and ideas

### 9.1 Known unfinished work

1. **Telemetry** (token plan step 1). Per-request input, cached, output and thinking tokens; per-tool duration and result size; count the revision, nudge and fallback calls. Prerequisite for everything else.
2. **Result store and retrieval tools** for large tool results (steps 2 and 3); sheet query tool; `web_read_page` paging; section reads for Docs.
3. **Parallel independent reads**, evidence-preserving handoff (handles, created IDs, completed actions, unfinished steps).
4. **Bounded working context** and on-demand tool schemas (visibility never widens the grant).
5. **Byte-stable prompt prefix** (sort gateway tools and memory facts; no dynamic values at the top).
6. **Reply-standard revision as a small tool-less call** with fallback to the full round.
7. **Explicit thinking levels** for sentinels and classifiers only, after telemetry.
8. Hardening steps **5, 6, 8, 10**: control-plane write class; metered-read budgets (Apify, token out of query strings); decouple evaluator score from disposition; adversarial governance suite. Re-verify each against current `main` rather than trusting the plan text.
9. Remove the duplicated helper role prompt from the user turn.
10. Housekeeping: delete `data/app.db`, de-duplicate `skills/` and `.agents/skills/`, move SQLite files out of the synced Drive folder.

### 9.2 Ideas not yet tried

- **Provider-neutral model adapter** with a rate table per provider and fields for cache read/write and thinking tokens from day one, so a switch to Claude is configuration.
- **Run trace UI**: for each answer, show the tools called, the evidence used, the checks that passed, and tokens. It would let the owner decide "Ellie fix or code fix" at a glance.
- **Cheap triggers, expensive thinking**: poll with code and conditional requests (history IDs, `If-Modified-Since`, push notifications), and call a model only when there is a diff. This is Viktor's lesson.
- **Eval set from real turns**: a labelled sample of the resume request, tracker cleanup, late correction, and handoff, replayed before each change.
- **Kill-switch page**: one place listing every timer, webhook and scheduled job with on/off state and owner.
- **Sheet mirror** with freshness checks, as a cache of the Sheet and never the source of truth.
- **Spend ledger**: metered tools (Apify, search) debit a budget in host code; exhaustion is a normal outcome.
- **Structured worker output** instead of JSON extracted from prose.

### 9.3 Open questions

- Is the situational engine earning its keep? Which of its outputs ever changed an owner decision?
- How much of the dry-wit voice survives a move to a different model and shorter prompts?
- Would Ellie be simpler as Slack only, with the web UI reduced to approvals and costs?
- Is SQLite on one VPS still right if a second process (the wake worker) and the web server contend? So far it works; WAL mode and a single writer path should be checked.
- Which Gemini features (implicit caching, thought signatures) are load-bearing and would need Claude equivalents (explicit cache breakpoints, preserved thinking blocks)?

---

## 10. If we started from scratch

### 10.1 Rules for the rebuild

1. **Write this document's section 2 as tests first.** Every principle becomes a failing test before any feature (fail-closed authority, background cannot send, unknown tool is consequential, webhook without secret is disabled, actor is never taken from a body).
2. **Review the boundary before adding surface.** No new integration until the dispatcher, ledger and auth are reviewed and the adversarial suite exists.
3. **Telemetry before optimisation, optimisation before features.** Token and latency per request is a day-one table.
4. **One spec, one owner of context.** Keep `docs/ELLIE_DESIGN.md` current and update it in each PR that changes a decision. Hand the same file to every agent session.
5. **Keep it small.** Target roughly a third of today's line count: core, Slack, a few integrations, approvals. Add the rest when a measured need appears.
6. **Owner data in config from the first commit.**
7. **Document the off switch** in the same PR as every trigger.

### 10.2 Recommended architecture

Keep the shape, simplify the wiring.

```
core/
  authority/   effect classes, grants, AuthorityPolicy (fingerprinted reviews), dispatcher
  ledger/      action ledger, executor, reconcilers, read-back registry
  model/       provider-neutral adapter: request, usage (in/cached-read/cached-write/out/thinking), rates
  runs/        run kinds and grants, tool-result store, trace
  checks/      reply standard, figure grounding, claims bank, action-claim checker
tools/         native tools, each with schema, effect class, read-back
surfaces/      slack, web (approvals, trace, costs), webhooks
work/          objectives (state machine), routines (cron), sentinels (cheap detect, model classify)
memory/        facts, candidates (scoped learning), skills
config/        owner config loader (Doc, private dir, env)
```

Differences from today:

- **Model adapter first**, with a normalised usage record and per-provider rate tables. The loop calls the adapter, not the SDK.
- **Tool-result store in the core.** Every tool returns either a small result or `{handle, description, preview}`; retrieval tools (`result_read`, `result_search`, `sheet_query`) are ordinary `READ` tools. The checks (claims, grounding) read the full original evidence.
- **One trace per run** stored from day one (model calls, tool calls, sizes, durations, checks, tokens).
- **Structured worker output** (schema-validated) for objective dispositions.
- **Workflow durability** either by a small checkpoint table with bounded retries (as now, but written once and tested) or an off-the-shelf engine if one is already in use.
- **Ledger stays a separate store.**
- **Plugin boundary for integrations**: each integration is a folder exporting tools and (optional) sentinels, registered by a list, so the composition root is a loop and not 400 lines of wiring.
- **Config schema validated at boot** (Zod), with a `doctor` command that prints what is missing and what would be disabled.

### 10.3 Build order

1. Repo, CI (build and test, no credentials), config loader, `doctor`.
2. Authority core: effect classes, grants, dispatcher, AuthorityPolicy with fingerprints. Adversarial tests.
3. Action Ledger, executor, read-back, reconciliation. Tests including provider success then client timeout.
4. HTTP auth (default-deny, CSRF, session actor), Slack signature and owner filter, webhook secrets. Tests including case variants and missing config.
5. Model adapter and telemetry; trace table.
6. Agent loop with tool-result store, byte-stable prefix, history budget, parallel reads. Replay set of real requests as evals.
7. Slack surface: owner DM, threads, approvals with plain-language cards, per-thread serialisation, origin propagation.
8. First two integrations only (Gmail drafts, Sheets/Docs) with read-backs and header-mapped append.
9. Checks: reply standard, grounding, claims bank, action-claim checker.
10. Objectives and routines with bounded retries; wake worker; nudge gate; morning brief.
11. Memory, skills, graduated learning.
12. Further integrations (Proton, LinkedIn/Apify with spend budgets, MCP gateway, Composio) one at a time, each with review entries and read-backs.
13. Only then: situational awareness, sentinels beyond mail, tuning.

### 10.4 Technology notes

- Keep TypeScript, Zod, SQLite; add a migrations table. Use WAL mode and a single writer path.
- Prefer structured output / function calling features over prose parsing.
- If moving to Claude: normalise usage; use explicit cache breakpoints on the stable prefix; preserve thinking blocks and signatures across tool rounds; budget thinking explicitly; do not truncate tool results (use handles).
- If staying on Gemini: keep response parts and thought signatures intact when managing history by hand; measure implicit cache hits before adding explicit caching.
- Slack: use the native Agent view and signed requests; keep all Slack-specific code behind one surface adapter.
- Do not keep databases in a cloud-synced folder; keep `private/`, `data/` and `ledger/` outside the synced tree or ignored by sync.

### 10.5 What to cut or defer on day one

| Cut | Reason |
| --- | --- |
| Situational engine | Unproven value; large surface |
| Routine auto-tuning | Proposals can be read by a human until there are many routines |
| Four role helpers | Replace with one generic delegate tool and a short role string |
| Dry-wit prompt block | Add a short voice section; grow it from real complaints |
| Web UI beyond approvals, trace, costs | Slack is the product surface |
| Native Proton | Optional plugin |

### 10.6 Runbook items to write on day one

- Deploy and rollback commands, health check, logs.
- **Trigger inventory** (timers, webhooks, scheduled jobs, third-party automation) with the command to disable each.
- Where each secret lives and how to rotate it.
- Backup and restore for the app DB and the ledger DB.
- How to disable all background work without disabling chat.
- How to find which bucket a problem belongs to: Ellie-fix, config-fix, or code-fix.

### 10.7 Anti-patterns checklist (review every PR against this)

- [ ] Authority decided by a name, verb, description or the tool's own metadata.
- [ ] A default identity, default actor, or "unsigned in dev" path.
- [ ] A write reported as done without a read-back or an "unverified" label.
- [ ] A retry without a cap, backoff and exit state.
- [ ] Classification from model prose rather than structured fields.
- [ ] An alert with no dedupe key and no clear-on-recovery.
- [ ] Owner-specific data in `src/` or tests.
- [ ] A new prompt rule without a test that it survives prompt assembly.
- [ ] A tool result with no size story.
- [ ] A tool declared to the model without a grant decision.
- [ ] A new trigger without a kill-switch entry.
- [ ] A convenience fallback that invents configuration (mock keys, placeholder tokens).
- [ ] A one-off content quirk fixed in code that Ellie could fix in chat.
- [ ] Docs status tables not updated in the same PR.

### 10.8 Ellie v4 status against this plan

Updated 2026-10-14 [code, git]. v4 is about 11,400 LOC of source and 2,700 LOC of tests (150 passing, `npm run test:ts`). That is under half of v2, within reach of rule 5. Model: Gemini Flash via one router (`models/model-router.ts`); Argon for routines whose `primaryModel` asks for a Pro-class model.

**Build order (10.3) status**

| Step | Status in v4 |
| --- | --- |
| 1. CI, config loader, `doctor` | Config loader yes. **No CI and no `doctor`.** Production refuses to start without `ELLIE_CONTROL_PLANE_TOKEN`, `GEMINI_API_KEY`, `SLACK_SIGNING_SECRET`, `SLACK_OWNER_USER_ID` (`src/index.ts`); there is no schema validation of the rest. |
| 2. Authority core | Done: effect classes, grants, dispatcher, AuthorityPolicy with fingerprints. Grants cover aliases (`aliasOf`). Composio actions are `CONSEQUENTIAL` until the owner reviews them as `READ` via `composio_review_action` (P3); MCP gateway reads come from the repo baseline. AuthorityPolicy reviews did not persist in SQLite until 2026-10-14 (column mismatch, failed closed). |
| 3. Ledger, executor, read-back | Done. **One executor** (`governance/executor.ts`) for Slack Approve, `/queue` approve and batch approve-all. It runs the tool's own `execute()` so tool guards (Claims Bank) apply, enforces `ELLIE_SEND_ALLOWLIST`, `ELLIE_MAX_DAILY_SENDS` and expiry, and marks an action `VERIFIED` only after a read-back; otherwise `PROVIDER_CONFIRMED` (P7). |
| 4. HTTP auth, Slack signature and owner filter | Done. Default-deny token on port 3001; tailnet access via a private loopback listener (`ELLIE_PRIVATE_PORT`) trusted by socket, never by headers. Slack events and buttons fail closed without signature or owner ID. **No CSRF token** (cookie is `httpOnly`, `sameSite=lax`). |
| 5. Model adapter and telemetry | Partial. Per-call tokens (prompt, cached, thinking, output) in `api_usage`, cost split Flash/Argon, run traces in `/ops`, explicit prefix-cache creation logged as source `prefix_cache`. Cache storage cost is not tracked. Not provider-neutral. |
| 6. Agent loop | Done. **Runs end only through a `finish` tool** (function-calling mode `ANY`; status `DONE`/`NEEDS_INPUT`/`BLOCKED`/`NOTHING_TO_REPORT`), with a wall-clock budget after which the last call may only be `finish`. Result store with handles (>1,800 chars), byte-stable prefix served from an **explicit Gemini context cache**, repetition guard that forces `finish`, parallel execution of plain `READ` calls, aliases and unconfigured integrations not declared. Thread history capped at 20 messages; no token-based history budget. |
| 7. Slack surface | Done: owner DM and threads, eyes/check reactions, live status message replaced by the answer, per-thread serialisation, per-thread carryover of the last run's evidence (`thread_carryover`), one quote card per staged action, in-thread revisions (non-questions only). Interactive runs: 25 rounds, ~4.5 min budget, 6 min hard stop. Interactive Slack runs are granted every tool (P4 is weak here). |
| 8. Gmail, Sheets, Docs | Done, with header-mapped Sheet append and read-back. |
| 9. Checks | Reply grounding (unverified Google links withheld, "created" claims without a successful write flagged), Claims Bank checks numbers and named results in outbound mail and documents. Figure grounding on Slack replies (P8) verifies currencies, percentages, and unit metrics against run evidence. |
| 10. Routines, wake worker, nudge gate, brief | Done. The routine prompt carries `hardConstraints`, `rules` and `destination`; v2 tool names map to v4 tools and missing ones are named; every run is delivered to Slack (root message with link, reply-able) or is explicitly `SILENT` when the routine allows it; failures are posted. Budget 8–10 min, 20 rounds; the wake worker runs quick checks first and routines last, with a 14-minute guard. Routines may stage consequential actions into their batch (never execute). The built-in 08:00 brief runs only when the morning routine is off. Gmail sentinel classifies new unread threads in parallel, skips threads already seen, and stages real reply drafts. Evaluator pass verifies `hard_constraints` using `evaluator_model` (EVALUATOR tier) and appends evaluator notes on violation. |
| 11. Memory, skills | Present (facts, preference candidates, markdown skills). |
| 12. Further integrations | Proton, Apify, MCP gateway (17 baseline reads), Composio. **No spend budget for Apify.** |
| 13. Situational awareness | Cut, as planned. |

**Fixed on 2026-10-14** (all with tests): Slack Approve only marked `APPROVED` and never executed; approved sends bypassed the Claims Bank; `calendar_create` and `composio_execute` could be staged but not executed; the system prompt told the model to call a non-existent `action_stage`; routines could not stage anything; Mission Control trusted forgeable `X-Forwarded-*` and `Tailscale-*` headers and handed out the real token as a cookie; Slack accepted any workspace member when `SLACK_OWNER_USER_ID` was unset; Composio without a key reported "simulated" success; fallback replies said "continuing to work on this" when nothing was running. Interactive thinking dropped from `high` to `medium` (`GEMINI_INTERACTIVE_THINKING`); tool failures still escalate to `high`.

**Follow-through, same day** (end-to-end tests in `src/test/follow-through.test.ts`): the loop used to treat any text reply as the final answer, so "Working on the tailored resume right now" ended the run and nothing followed; routines received only their one-line description (their `hardConstraints` were never loaded), were granted v2 tool names that do not exist in v4, had 60 seconds, and their output was never delivered anywhere, so `/ops` showed `COMPLETED` for runs that produced nothing; the Argon tier was never selected by any caller. Root cause of "it said it was all built": tests checked that parts existed (tool registered, routine seeded), never that a routine run ends with a message in Slack.

**Open v4 gaps, in suggested order**

1. CI (build and test without credentials) and a `doctor` that prints what is missing and what is disabled. (Done)
2. Per-run grant for interactive Slack runs instead of every tool (P4, anti-pattern "tool declared without a grant decision"). (Done in v5 via `resolveInteractiveSlackGrant`)
3. Missing routine tools: `delegate_subtask`, a real X/Hacker News search (mapped to `web_search` for now), a Drive file reader for non-Doc files (mapped to `docs_read`). (Done)
4. Evaluator pass for routines that declare `evaluatorModel`, and a background continuation for interactive work that outgrows the 4.5-minute budget (today it stops with BLOCKED and "reply continue"). (Done)
5. Hardcoded owner defaults in `src/config/owner.ts` violate P12; moved to required environment config. (Done)
6. Figure grounding for Slack replies (P8; outbound mail is already covered by the Claims Bank) and an Apify spend budget. (Done)
7. Runbook (10.6): trigger inventory with kill commands, secret rotation, DB backup and restore. (Done)
8. Migrations table instead of `ALTER TABLE ... catch {}`. (Done)


### 10.9 Ellie v5: the clean cutover

Started 2026-10-14 [code]. v4 was reported as a full replacement of v2, but its deployed `.env` still pointed at v2's app database, ledger and private folder (`ELLIE_APP_DB_PATH=/home/ellie/apps/ellie-v2/...`), ported v2 code expected v2 table shapes, routines kept v2 tool names, and the test suite wrote to the real `routines.json`. v5 keeps the v4 parts that were fixed and covered by end-to-end tests that day, drops the rest, and replaces the VPS install.

**Kept from v4 (fixed and tested):** dispatcher and ledger, one approval executor, `finish`-only run endings with time budgets, live Slack status, per-thread serialisation and carryover, routine delivery to Slack, explicit prefix cache, private tailnet listener, Claims Bank, result store, sentinels, reminders, nudge gate, memory, skills, Slack management tools.

**Dropped (or scoped to approval gate):** `AuthorityPolicy` raw auto-execution (external tools are strictly gated by human approval cards; Composio tool discovery revived as approval-gated `composio_install_tool`), knowledge sources, the `/brain` screen and most of Mission Control, the built-in bullet-point morning brief (it is a routine now), file-synced `routines.json` (routines live in SQLite, created from Slack), tool aliases and v2 tool-name mapping.

**Lessons built in:**

| Lesson | v5 mechanism |
| --- | --- |
| v4 ran on v2's databases | One `ELLIE_DATA_DIR`; no per-file DB path settings; `migrate()` refuses a database with tables it did not create |
| `ALTER TABLE ... catch {}` hid schema drift | Versioned migrations in `schema_migrations`, each in a transaction |
| Half-migrated `.env` went unnoticed | `npm run doctor`: required/optional settings, obsolete keys, any `ellie-v2/v4` path, model ids checked against the API, Slack `auth.test`, Google profile, gateway, Proton port |
| "Argon" model id was invented (at the time; the API lists `models/gemini-4-argon` as of 2026-10-14) | No invented model defaults; `GEMINI_REASONING_MODEL` (or `GEMINI_PRO_MODEL`) is checked by doctor |
| Google could not be reconnected (no connect route) | `/api/integrations/google/connect` behind the login, callback accepts only a `state` it issued; token export/import script for the cutover |
| Owner names hard-coded (P12) | Names only from `.env`; neutral fallback; committed `.env.test` uses fake values |
| Tests mutated real owner config | Tests run on a fake data dir only; no file sync exists |
| "Built" without evidence | Acceptance list in `RUNBOOK.md`: done means seen in Slack; CI on Node 22 and 24 |
| Trigger inventory missing (P13) | `RUNBOOK.md` lists every trigger and its off switch, including v2's Google push subscriptions |

**Cutover:** `deploy/vps.sh` phases `inventory` → `fetch` → `preserve` (Google token) → `wipe` (lists targets, requires typing "wipe"; keeps `~/backups`, Proton Bridge, Tailscale) → `configure` (`.env` from `~/backups/v2-preservation/.env` with obsolete keys removed) → `start`. Tested end to end in a sandbox home directory with stubbed `systemctl`/`crontab`.

**Landed and tested (2026-10-17 — Tracks A, D, B, C Complete, Image Engine, Composio & P4 Tool Grants):**
- **Per-Run Tool Grants for Slack (P4):** `resolveInteractiveSlackGrant` (`src/integrations/slack/coworker.ts`) dynamically scopes interactive Slack turns into explicit capability clusters (Core Assistant, Document/Drive/Sheets, Nano Banana Image, Management/Admin, Self-Diagnosis, and Composio) while keeping Gemini prefix caching byte-stable.
- **Deterministic Last-Page Fill Check:** `lastPageFillProblems` (`src/documents/pdf.ts` and `src/tools/document-tools.ts`) detects sparse page 2 on resumes (<5 lines or <250 chars) in <10ms before paying 2–14s for visual check.
- **Image Generation via Google Nano Banana & Metadata Stripping:** Native `image_generate`, `image_edit`, and `image_describe` tools with direct Slack upload (`slackClient.uploadFileV2`), multi-turn visual iteration, and automatic EXIF/GPS/metadata scrubbing.
- **Composio Free Tool Discovery & Approval-Gated Install:** Native `composio_search_free_tools`, `composio_install_tool`, `composio_setup_tool`, and `composio_execute_tool` tools with Slack OAuth setup links and automated post-approval execution.
- **Track A (Zero-Hallucination Grounding):** Claims Bank figure & `[X]` never-claim verification extended to `kind === 'document'` (`document_render`, `visual_document_render`) with `skipNamedEntities: true`, and hard figure grounding in Slack replies (`groundReply`, P8) checking percentages, currencies, and non-time unit figures against run evidence.
- **Track D (RRSI-Regularized Self-Improvement, arXiv:2609.24972v3):** Migration 11 `rrsi_edit_ledger` table and `MemoryRepository` ledger methods (`recordRrsiProposal`, `recordRrsiTrial`, `listRrsiLedger`, `memory_manage` `target: 'ledger'`); diff-level deterministic leakage critic (`screenCandidateLeakage`) blocking payload-specific emails, URLs, dates, currency figures, percentages, IDs/paths, proper nouns, and $>35$-word prose dumps; candidate promotion after corroboration ($N \ge 3$) routing single edits away from global prefix cache invalidation; credit assignment on Slack card approve/drop and web queue edits/drops; Lasso ($L_1$) structural pruning (`pruneStaleCandidates`) demoting unproductive learned facts (`trials >= 3 && delta_score < 0`) to `confidence = 0.5` while preserving owner facts; and Ridge ($L_2$) complexity cap on `getExecutiveFacts` ($\le 1,000$ tokens / 4,000 chars).
- **Track B (Closed-Loop Proactive Follow-Through):** Inbound mail auto-resolution of active `waiting_items` in `GmailSentinel` and `ProtonSentinel` with Slack card confirmation; auto-staged follow-up email proposals for overdue items in `wake.ts` (`processOverdueWaitingItems`, verified via `reviewOwnerText`) with Slack approval quote cards; outbound email send auto-tracking in `executeApprovedAction` (`executor.ts`, wired in runtime and queue routes) tracking open loops with 3-day deadlines; and pre-meeting Chief-of-Staff open loop and recent attendee email thread context (`searchEmails`) attached to `<20 min` alerts in `CalendarSentinel`.
- **Track C (Universal Drive Reader & Evaluator Pass):** `drive_read_file` tool extracting content from Google Docs, PDFs, DOCX, and text up to `max_chars`; and routine evaluator pass in `RoutineWorker` verifying `hard_constraints` with `evaluator_model` and appending evaluation notes on failure.
- **Foundations & Core:** Honest sentinel statuses (`off`, `not_connected`, `error`, `unchanged`, `checked`), sentinel draft verification via `reviewOwnerText`, Apify daily spend budget (`ELLIE_APIFY_MAX_DAILY_CALLS`) and Bearer auth, persistent `owner_doc_cache` (Migration 10), structured `blocks` `draftHandle` in `owner_text_check`, Gemini prefix cache pre-warming (`warmPrefixCache`), `ResultStore.pruneOldResults` in `wake.ts`, background continuation (`runBackgroundContinuation`), agentic sub-rounds (`delegate_subtask`), dual-engine formatted documents (`document_render` + `visual_document_render`), Phase 3 follow-through (`waiting_items`, `project_state_update`/`project_state_read`, outward 24h deduplication), and the VPS Spaces engine (`spaces` table, `space_publish`/`space_list`, modernized web control plane). Identity details in drafts and Docs are checked in the dispatcher for every tool that declares `ownerText`. Owner text is refused until the run has read the owner sources (`owner_sources_read`).

---

## 11. Appendices

### A. Key files

| Path | Why it matters |
| --- | --- |
| `src/governance/dispatcher.ts` | The authority gate |
| `src/governance/authority-policy.ts`, `reviewed-baseline.ts` | Third-party tool reviews and fingerprints |
| `src/types/tool.ts`, `src/types/action.ts` | Effect classes, grants, ledger states |
| `src/storage/action-ledger.ts`, `src/governance/approved-action-executor.ts` | Stage, approve, execute, reconcile |
| `src/agent/loop.ts` | Engine, system prompt, post-reply checks |
| `src/agent/interactive-conversation.ts`, `chat-handoff.ts` | Interactive grant, history, handoff |
| `src/scheduler/objective-engine.ts`, `routine-engine.ts`, `src/wake.ts` | Autonomy |
| `src/presentation/nudge-gate.ts`, `reply-standard.ts`, `chief-of-staff-presenter.ts` | Quiet and truthful output |
| `src/governance/claims-bank.ts`, `src/agent/claim-checker.ts` | Truth checks |
| `src/config/owner.ts`, `.env.example`, `deploy/README.md` | Config and ops |
| `src/runtime/build-runtime.ts` | Everything wired |
| `docs/plans/token-reduction.md` | The cost plan and its production evidence |

### B. Environment surface (from `.env.example`)

Core: `NODE_ENV`, `PORT`, DB paths, `ELLIE_PUBLIC_URL`. Owner: names, actor, private dir, config/record/claims Doc IDs, tracker IDs and aliases. Security: `ELLIE_CONTROL_PLANE_TOKEN` (required in production), `ELLIE_WEBHOOK_TOKEN`, Gmail Pub/Sub and Calendar channel pins, private listener port, gateway URL and key. Model: `GEMINI_API_KEY`, Flash and Pro model names. Google: client ID/secret, operator email, redirect. Governance: send allowlist, daily send cap, approval expiry. Proactive: quiet hours, daily nudge cap. Proton, Slack (bot token, signing secret, owner ID, channel ID), Apify, X bearer.

### C. Timeline

| Date | Event |
| --- | --- |
| 2026-10-04 | Milestone 1: ledger, fail-closed dispatcher, tests. Same day: Gemini SDK, Google OAuth, multi-turn loop, routines, subagents, Slack, Composio, reflection |
| 2026-10-05 | Sentinels, settings, objectives hardening, cost tracking, Proton, UI, situational engine |
| 2026-10-06 | Slack Agent view and session identities; Proton Bridge outage |
| 2026-10-07 | Chief-of-staff brief, link tracker, Apify; security review; hardening plan written; Step 1 (control plane) merged |
| 2026-10-08 | Steps 2 to 4 (webhooks, authority registry, generic lifecycle), Sheets header-mapped append, claims bank |
| 2026-10-09 | Read-back, reply standard, scoped learning, voice, Docs export, owner-config refactor, gateway key origin, token plan |
| 2026-10-10 | Token plan reviewed; v1 app stopped; development paused |

### D. Glossary

- **Effect class**: the kind of change a tool can make in the world.
- **Grant**: the explicit set of tool names a run may call.
- **Staging**: recording an exact payload for approval instead of executing.
- **Read-back**: a separate read proving a write took effect.
- **Companion read**: a declared read-back for a third-party write.
- **Claims Bank**: the owner-maintained list of specifics outreach may assert.
- **Objective**: durable owned work with a plan, a state and a next review time.
- **Routine**: a scheduled template that instantiates objectives.
- **Sentinel**: a cheap detector over an inbound stream (mail, calendar) that classifies and drafts.
- **Nudge**: a proactive message to the owner, always through the gate.
- **Handle**: a stable ID for a large stored tool result.

### E. Source notes and caveats

- Verified in code on 2026-10-12: the evaluator score gate is still present (6.3) and no `CONTROL_PLANE_WRITE` class exists (hardening step 5). Step 6 is only partly there: `authority-policy.ts` has a `metered` flag, but I did not find per-run spend budgets. Step 10 (adversarial suite) is not present as a named suite, though many of its cases are covered across existing tests.
- Production numbers are those recorded in the token plan on 2026-10-09; I had no database access in this session.
- Section 8.2 is general industry knowledge, not verified against current vendor documentation.
- The "what went wrong" list is built from commit messages, code and memory notes. It does not include anything only the owner experienced and never wrote down; add those.
