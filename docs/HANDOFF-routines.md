# Handoff: recreate routines (Ellie v5, Phase 0 finish)

Paste everything below the line into a fresh development session for Ellie v5.

---

Finish Phase 0 of `docs/PLAN.md`: verify RUNBOOK check 6, then recreate Ellie's routines one at a time until the set the owner actually uses is back and delivering. Before you start, read `docs/PLAN.md` (top Status entries, "Phase 0", "Phase 1" and its exit criteria) and `RUNBOOK.md` (checks 5-6, "Getting something back from the pre-v5 archive", "Where does a problem belong?").

**Step 1: check 6.** The routine `morning_brief` (cron `0 8 * * 1-5`, Europe/Warsaw) first fires on its own on Fri 2026-10-16 at 08:00 Warsaw (06:00 UTC), through the wake timer. After it fires, read its run trace (`run_traces`, trigger `routine`) and `routines.last_run_status`. `run_traces.delivered_text` holds the exact post that reached Slack. It passes when it fired within one wake interval (15 min) of 08:00, reached DELIVERED and posted once. Record the result in PLAN. If it fails, fix that first.

**Step 2: inventory.** Earlier routines are preserved in the pre-v5 archive on the VPS, at `backups/v2-preservation/routines.json` inside `/var/backups/ellie-archive/ellie-home-pre-v5-20261014.tar.zst`. Extract that one file to `/tmp/restore` using the RUNBOOK command. That is a read-only use of the archive, but ask the host owner before running it, because it is a VPS write outside deploy/push.sh. Summarise each routine in one line (what it did, schedule, tools it needs, whether v5 has those tools). Ask the owner which ones to bring back and in what order. Don't assume all of them. The leftover `test_digest` routine (Mon-Fri 08:30, made for a test) gets deleted or kept as the owner specifies.

**Step 3: one routine at a time.**
1. The owner creates the routine from Slack, in their own words, for example "create a routine called X every weekday at 9:00 that ...". Ellie now confirms it in text with the schedule she understood. If the wording or schedule is wrong, it is corrected in Slack, because routine wording is an Ellie fix, not a code fix.
2. The owner triggers Run now on the control page (Routines tab). You judge the trace: the right tools were used, the post matches what the tools returned, the status is DELIVERED, there is one post, and the trace's `delivered_text` matches.
3. Only then go on to the next routine. A routine that needs a tool v5 lacks is backlog in PLAN, not a reason to build the tool now. Ask the owner first.
4. Record each routine in PLAN: id, schedule, Run now trace, status.

**Done for this task:** every chosen routine has a DELIVERED Run now. Phase 1's exit criteria (each delivered twice on schedule, no unexplained FAILED runs for 3 days) are watched afterwards. Note in PLAN when that window closes.

**Working alongside another session.** The formatted-documents session (`docs/HANDOFF-formatted-documents.md`) may be changing code in the same checkout. Never `git add -A`; stage only your own paths. `deploy/push.sh` refuses a dirty tree, so if you need a code fix while that session has uncommitted work, log the fix with its trace, notify the owner, and wait. Don't stash or commit its files.

**Hard rules (all still in force).**
- Fix the class, not the instance, and label every change "class" or "instance". Breadth before depth: log polish as backlog and move on.
- Done means an e2e test plus a live trace. Code fixes start from a real trace turned into a failing test made of made-up data.
- Build in a local directory outside Google Drive: copy `src` there, then `rm -rf dist && npm run build && npm test`. Use Node, not Python.
- Deploy only committed HEAD with `bash deploy/push.sh`, one change per deploy. Afterwards check DEPLOYED_COMMIT and health (`curl http://127.0.0.1:3001/api/health` over SSH). `git push` runs CI on the repo.
- Commit clean commits. Messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Update `docs/PLAN.md` in the same commit.
- Never print secret values. Never touch `/home/ellie/backups/v2-preservation/.env`. Before any `.env` edit, back it up to `~/backups/ellie/`. Ask before destructive or outward actions, `.env` edits, or VPS writes outside `deploy/push.sh`. The owner sends the Slack messages and approves cards; you read traces.
- No personalization in code or config. Routines live only in SQLite and are created from Slack.
- The repo stays on Google Drive for now.

Start by checking whether check 6 has fired yet. If it hasn't, do step 2's inventory while you wait.
