# Ellie v5 design notes

> **Scope:** These notes describe the public showcase implementation. They are not a production
> support contract, and they do not claim that every integration is enabled in every environment.

## 1. Design goals

Ellie explores what a single-tenant AI chief of staff looks like when the model is capable but not
trusted with unlimited authority.

The central rule is:

> The agent owns the work. The owner owns decisions and commitments. Host code owns authority.

That rule leads to four design goals:

1. Give the model useful tools rather than a single unrestricted shell.
2. Keep irreversible or externally visible actions behind host-enforced approval.
3. Preserve evidence so replies can be checked against tool results.
4. Keep background polling cheap and invoke a model only when state changes or reasoning is needed.

## 2. Runtime model

Every interactive request follows the same high-level path:

```text
Slack event
  -> signature and owner validation
  -> per-run tool grant
  -> model function-call loop
  -> dispatcher policy checks
  -> tool result or approval proposal
  -> grounded delivery
  -> run trace
```

The model runs with function calling enabled. A normal run ends only through a synthetic `finish`
tool carrying an explicit status and delivery mode. This makes completion, blocking, clarification,
and silent background results structured rather than inferred from prose.

The runtime supports:

- bounded interactive and routine rounds;
- wall-clock budgets and forced final turns;
- parallel execution for side-effect-free reads;
- sequential writes and approval staging;
- a Result Store for large outputs;
- thread carryover with evidence labels;
- model-tier routing for interactive, routine, escalation, and analysis work.

## 3. Tool authority

Tools are assigned one of four effect classes:

| Class | Behavior |
| :--- | :--- |
| `READ` | No external mutation; may execute directly and in parallel |
| `LOCAL_WRITE` | Reserved for local state with no outward effect |
| `INTERNAL_REVERSIBLE_WRITE` | Executes directly, with tool-specific read-back verification where implemented |
| `CONSEQUENTIAL` | Is staged in the Action Ledger and requires an explicit owner approval before execution |

Per-run grants limit which tools are declared and callable. Slack command-and-control tools are
restricted to owner direct messages. Background routines cannot execute consequential tools; they
can only stage proposals for review.

The dispatcher applies additional checks before execution:

- tool existence and grant membership;
- owner-text policy;
- duplicate outward-action detection;
- send allowlists and daily limits;
- payload schema validation;
- approval expiry and execution claiming.

## 4. Approval and audit model

Consequential actions are never executed by the model.

1. The dispatcher validates the proposed payload.
2. The proposal is written to `action_ledger`.
3. Every state transition is appended to `action_ledger_events`.
4. Slack and web approval surfaces show the serialized payload.
5. An owner interaction triggers the executor.
6. The executor claims the action atomically, runs the tool, and records a provider or verification
   result.

Slack cards use plain text for payload display. If a payload is too large to review safely in
Slack, the card intentionally withholds approval buttons and directs the owner to the control
plane.

The approval system is an application boundary, not a cryptographic guarantee that the underlying
provider delivered the requested effect. A send can be reported as provider-confirmed without a
separate provider read-back when no verification hook exists.

## 5. Evidence and grounding

The model's own prose is not evidence.

The runtime separately tracks:

- the owner's instruction and earlier owner messages;
- tool results marked as evidence;
- resources authored by Ellie;
- stored results and their evidence status;
- owner-source material used for identity and claims checks.

Draft checks, code reads, traces, and agent-authored documents are marked as non-evidence. This
reduces the chance that an earlier hallucination becomes a future factual source.

Claims checks cover selected patterns such as currencies, percentages, recognized quantities,
emails, URLs, phone numbers, titles, and years of experience. Coverage depends on the tool and on
available source material. These checks are best-effort safeguards; they do not establish that all
generated content is correct.

## 6. Data storage

The application uses two SQLite databases:

- `app.sqlite` stores operational state, run traces, memory, routines, result handles, Spaces
  metadata, and integration tokens.
- `ledger.sqlite` stores approval records and their transition history.

Database files can contain private task content and provider credentials. Treat the data directory
and backups as secrets.

Large tool results are replaced with handles and bounded previews. Thread carryover preserves
useful evidence across related runs without replaying every result into every prompt.

## 7. Background automation

Background work is split into cheap detection and expensive reasoning:

- Gmail uses history checkpoints;
- Proton Mail uses IMAP status counters;
- Calendar uses bounded time windows;
- Drive routines can compare file modification times;
- reminders and routines run on timers.

When no relevant state changed, the process can stop before making a model call. Sentinels and
routines still pass through the nudge gate, quiet hours, deduplication, and delivery rules.

Background routines can research, write supported internal artifacts, and stage consequential
actions. They cannot execute sends, calendar invites, Slack posts, or other consequential actions.

## 8. Documents

The document subsystem has two engines.

### Linear documents

Structured blocks are rendered to DOCX, converted to PDF with LibreOffice, then inspected for:

- configured page-count targets;
- text order compatible with ATS extraction;
- sparse final pages;
- visual layout defects when a multimodal check is available.

The renderer controls typography and spacing; the model supplies content and semantic blocks.

### Visual documents

HTML and inline SVG are rendered through a headless browser for one-pagers, pitch sheets, and
infographics. A deterministic layout solver adjusts spacing and scale before PDF generation.
The same identity and claims checks run before either engine writes output.

## 9. Web reading and third-party APIs

Public URL reads are guarded at the DNS connection layer so hostnames cannot resolve into loopback,
private, link-local, carrier-grade NAT, metadata, or other reserved address ranges. Redirects are
validated against the same policy.

The external Jina reader is disabled by default because it sends the requested URL to a third
party. Operators must explicitly enable it.

Google, Slack, Gemini, Proton Bridge, Apify, Composio, and the optional MCP gateway are separate
trust and data-processing boundaries. Each requires its own account, permissions, quotas, and
security review.

## 10. Web and mobile interfaces

The web control plane serves:

- staged approvals;
- routine and sentinel controls;
- run traces and delivered text;
- cost telemetry;
- Spaces;
- integration status.

Authentication is either a bearer control-plane token or a deliberately trusted loopback listener
exposed only through a private network such as Tailscale.

The Android companion demonstrates approvals, runs, routines, Spaces, and voice capture. It
encrypts the control-plane token with Android Keystore, requires HTTPS, disables application
backups, and deletes uploaded meeting audio. It remains an experimental showcase client.

## 11. Tradeoffs

| Decision | Benefit | Cost |
| :--- | :--- | :--- |
| Single tenant | Simpler authorization and data model | No multi-user administration |
| SQLite | No separate database service | Limited horizontal scaling |
| Provider APIs | Strong model and workspace capabilities | External data processing and vendor dependencies |
| Deterministic governance | Predictable approval boundaries | Tool declarations require explicit review |
| Structured blocks | Reliable document layout | Less formatting freedom than raw HTML or Word |
| Result handles | Bounded prompts | Additional retrieval step for the agent |
| Heuristic grounding | Fast deterministic checks | Incomplete coverage and possible false positives |

## 12. Source map

| Area | Primary files |
| :--- | :--- |
| Agent loop | `src/agent/runner.ts`, `src/agent/prefix-builder.ts` |
| Governance | `src/governance/dispatcher.ts`, `src/governance/executor.ts`, `src/storage/action-ledger.ts` |
| Runtime wiring | `src/runtime/build-runtime.ts` |
| Slack | `src/integrations/slack/`, `src/http/routes/slack.ts` |
| Web control plane | `src/http/`, `src/web/index.html` |
| Documents | `src/documents/`, `src/tools/document-tools.ts` |
| Background work | `src/scheduler/`, `src/wake.ts` |
| Android | `android/app/src/main/java/com/ellie/app/` |
| Tests | `src/test/` |

For the complete public architecture, see [INVENTORY_PUBLIC.md](INVENTORY_PUBLIC.md).
