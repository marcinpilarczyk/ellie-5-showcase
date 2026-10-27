# Ellie v5 showcase roadmap

> **Status:** Public engineering roadmap. This is a reference implementation, not a supported
> hosted product. Items below describe direction and known limitations rather than deployment
> commitments.

## What this showcase demonstrates

| Area | Demonstrated implementation |
| :--- | :--- |
| Agent runtime | Gemini function calling, bounded tool rounds, explicit finish states, parallel reads, task budgets, and run traces |
| Governance | Static tool grants, effect classes, owner-only Slack events, approval staging, action-ledger transitions, and execution receipts |
| Workspace tools | Gmail, Calendar, Drive, Docs, Sheets, Proton Mail Bridge, Slack, web research, and optional MCP/Composio integrations |
| Grounding | Owner-source and claims checks, identity-detail matching, reply grounding, and non-evidence tracking for agent-authored material |
| Documents | Structured DOCX generation through LibreOffice, visual HTML-to-PDF generation, page-count checks, reading-order checks, and visual inspection |
| Background work | Gmail, Proton, and Calendar sentinels; scheduled routines; reminders; waiting-item tracking; and notification quiet hours |
| Interfaces | Slack coworker, token-protected web control plane, interactive Spaces, and an experimental native Android companion |

## Completed milestones

- Established SQLite migrations for operational state, approvals, routines, memory, result handles, and Spaces.
- Introduced a single tool dispatcher with explicit effect classes and per-run tool grants.
- Added owner approval and append-only transition history for consequential actions.
- Added the Result Store for large tool outputs and thread carryover for follow-up work.
- Added source-aware writing, claims checks, and protection against treating generated drafts as evidence.
- Added background sentinels, routines, reminders, and follow-up tracking.
- Added DOCX/PDF and HTML/PDF document pipelines with structural verification.
- Added Composio discovery/install flows and a reviewed MCP gateway integration.
- Added an Android companion with approvals, Spaces, voice-note, and meeting-recording experiments.
- Hardened the web reader against DNS-resolved private addresses and disabled external reader fallback by default.
- Added Node 22/24, dependency-audit, deploy-syntax, and Android CI checks.

## Near-term improvements

1. **Configuration examples:** Provide synthetic end-to-end fixtures for each integration so the
   repository can be explored without live provider credentials.
2. **Architecture documentation:** Keep generated diagrams and the Word specification synchronized
   with the tool registry.
3. **Approval ergonomics:** Add a dedicated control-plane deep link to oversized actions so every
   payload can be reviewed in one consistent place.
4. **Android hardening:** Add instrumentation tests and retain a reproducible debug build in CI.
5. **Provider abstraction:** Separate provider-specific request and response shapes from the runner
   so model providers can be replaced without changing governance code.
6. **Public demo data:** Replace integration tests that require realistic fixtures with a complete
   synthetic workspace pack.

## Known limitations

- Task content is processed by configured external providers.
- Claims and identity checks are deterministic heuristics, not a proof of factual correctness.
- Some integrations can only be exercised with real third-party accounts.
- The Android application is experimental and is not distributed through an app store.
- The example deployment scripts are operational references and are not a supported hosting service.
- SQLite and local filesystem Spaces are designed for a single tenant, not horizontal scaling.

## Suggested reading order

1. [README](../README.md) for setup and system boundaries.
2. [How Ellie Works](HOW_ELLIE_WORKS.md) for a non-technical walkthrough.
3. [Public Architecture and Governance](INVENTORY_PUBLIC.md) for the detailed system design.
4. [Design Notes](ELLIE_DESIGN.md) for principles and tradeoffs.
5. [Runbook](../RUNBOOK.md) for optional local and systemd examples.
