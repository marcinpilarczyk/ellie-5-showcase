# Handoff: formatted documents (Ellie v5)

Paste everything below the line into a fresh development session for Ellie v5.

---

Build formatted documents for Ellie v5: steps 3 to 6 of "Proposal: formatted documents" in `docs/PLAN.md`. Read that section, "Definition of done", the top Status entries and `RUNBOOK.md` check 3 before you write any code. Steps 1 and 2 (identity details in the claims guard, owner working Docs as sources) are already in place. Check that against the code instead of assuming it.

**Goal.** When the owner asks Ellie in Slack to tailor a resume for a job, the Slack thread gets a DOCX link and a text-based PDF link. The PDF is exactly 2 pages, it reads in the same order as the blocks (ATS order), and every contact detail and claim traces to an owner source. Today `docs_create` writes plain text only.

**Visual target.** Reference resume PDFs reside in the owner's Google Drive. Match their layout in the `executive-editorial` theme, inside the limits PLAN gives (A4, one column, Aptos or Arial, no tables, sidebars or icons). Never copy personal details into code, config or tests. Tests use made-up people and documents.

**Build order.** One deploy for each step, and each step has a made-up-document test.
1. (Step 3) `document_render`: a `{ kind, theme, title, blocks }` schema shared by every document kind. It renders blocks to DOCX with the Node `docx` package and the `executive-editorial` theme, uploads to Drive and returns the link. The model chooses words and structure, never fonts or sizes. Theme values live in code; writing rules stay in the owner's framework Doc.
2. (Step 4) Convert to PDF with headless LibreOffice on the VPS (`soffice --convert-to pdf`). Read back the page count and compare the extracted text order with the block order. This is the tool's verify hook. One failed check goes back to the model with the findings; a second failure reports BLOCKED and says what is wrong.
3. (Step 5) Render the PDF pages to PNG with `pdftoppm` and run one multimodal model check for overflow, orphaned headings and spacing.
4. (Step 6) Re-run RUNBOOK check 3 live: owner sends the Slack message, then you judge the run trace. It is done when the thread has DOCX and PDF links, the PDF is 2 pages, and every contact detail traces to `OWNER_PROFILE`.

**VPS packages.** LibreOffice (about 500 MB) and poppler-utils are installed system-wide, which is a VPS write outside `deploy/push.sh`. Ask the host owner before you install them, and provide the exact command.

**Hard rules (from the checks 4-7 brief, all still in force).**
- Fix the class, not the instance, and label every change "class" or "instance". Breadth before depth: when a step is correct, log the polish as backlog in PLAN and move on. Don't spend days on one check.
- Done means an e2e test plus a live trace, and nothing counts until it is seen in Slack. `run_traces.delivered_text` now holds the reply that reached Slack, so you can check replies yourself.
- Build in a local directory outside Google Drive: copy `src` there, then `rm -rf dist && npm run build && npm test`. `npm install` fails on Google Drive mounts, so add any new npm package to `package.json` in the repo and run `npm install` in the build dir, then copy `package-lock.json` back. Use Node, not Python.
- Deploy only committed HEAD with `bash deploy/push.sh`, one change per deploy. Afterwards check DEPLOYED_COMMIT and `/api/health`. `git push` to `origin` runs CI.
- Commit clean commits. Messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Update `docs/PLAN.md` in the same commit.
- Never print secret values. Never touch `/home/ellie/backups/v2-preservation/.env`. Before any `.env` edit, back it up to `~/backups/ellie/`. Ask before destructive or outward actions, `.env` edits, or VPS writes outside `deploy/push.sh`.
- No personalization in code or config: no Doc names, IDs or the owner's details. Ellie finds the owner's working Docs at run time.
- The repo stays on Google Drive for now (2026-10-15).

**Open items to keep in view (not this task).**
- RUNBOOK check 6: the scheduled `morning_brief` is due Fri 2026-10-16 08:00 Europe/Warsaw. Verify its trace and Slack post if nobody has yet.
- After formatted documents: recreate routines one at a time, each with Run now and a DELIVERED status before the next.

Start by reading the PLAN sections and the current `docs_create`, owner-sources and claims-guard code. Then post your step-3 design in a few lines (schema, theme values taken from the target PDF, Drive folder) and wait for the owner's go-ahead before you write code.
