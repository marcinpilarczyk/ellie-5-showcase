---
name: humanization
description: Strip AI tells from English prose before it ships: essays, newsletters, emails, LinkedIn posts, fiction, blurbs. Humanization Codex v4.3 with a Claude-specific blacklist. Use when writing or editing prose in the owner's name, when asked to "humanize" or "de-AI" a draft, and proactively before handing back any prose longer than a few sentences. Polish text goes to the `humanizer` skill instead.
---

# Humanization (Codex v4.3)

AI text is too predictable and too even. The goal is prose a human reader trusts. Detectors are not the target, and the script's numbers are proxies: never write to a number.

## Scope

- **Run on:** English prose in the owner's name or for publication, longer than about three sentences.
- **Skip:** chat replies to the owner, code, legal or official text, quotations from other people (never edit those).
- **Polish text:** use `humanizer` with `poprawna-polszczyzna`, not this skill.
- **Outlines and story architecture:** read `references/story_structure.md` and stop. This skill works on prose only.

## The three rules

1. **Say the unpredictable thing.** Take a position. Use specific numbers, dates and names instead of "various" and "significant". Never invent a fact, quote, number or anecdote; that is the one failure the owner rejects outright. If a detail is needed and missing, write `[NEEDS: what's missing]`.
2. **Break the rhythm, but not by rule.** Vary sentence length a lot. Use as many list items as the meaning needs. A quirk applied on schedule (always two items, a forced digression) is just another tell.
3. **Check against the lists, don't trust memory.** Lists live in `references/blacklist.md`, patterns in `references/patterns.md`. The script reads both.

## Workflow

1. **Classify and load.** Non-fiction (essay, newsletter, email, status update): no extra file. LinkedIn post or cold email: read `references/linkedin.md`. Fiction, blurb or excerpt: read `references/fiction.md` and use `--fiction`.
2. **List the facts.** Note every name, number, date and claim available from the source or from the owner. Anything else needed becomes `[NEEDS: …]`.
3. **Draft.** Write or rewrite from the facts. Don't treat the source's structure as fixed. Lead with the decision or answer (P33).
4. **Run the check.** Save the draft to a file or pipe it in. The script uses stock Python 3:
   ```bash
   python3 <skill-dir>/scripts/verify_humanization.py draft.md            # non-fiction
   python3 <skill-dir>/scripts/verify_humanization.py draft.md --fiction  # fiction/blurbs
   python3 <skill-dir>/scripts/verify_humanization.py - < draft.md        # stdin
   ```
   `<skill-dir>` is the folder containing this file. Fix every Tier A hit and every Tier B cluster. Read each Tier R line and fix only the real ones.
5. **Critique.** Check the manual patterns in `patterns.md` (P10, P23, P24, P33, P34; for fiction also the `fiction.md` reads). Read the draft aloud: if it sounds like a TED talk, rewrite. Write down 2–5 specific things that still sound generated.
6. **Final.** Apply the critique, rerun the check, and repeat until it passes or every remaining hit is a deliberate override.

## Tiers

| Tier | Meaning | Action |
|---|---|---|
| A | Fails on one sighting | Fix every hit |
| B | Weak alone | Fix the paragraph only when 3+ Tier B hits share it |
| R | Candidate, often a false positive | Read; fix the real ones |
| M | Not greppable | Check in the critique step |

## Overrides

- **Correct literal term** (landscape architecture, a biological ecosystem, a pivot table): `--allow landscape,ecosystem`. Name the override in the summary.
- **The owner's own voice sample** beats the stylistic rules (dashes, rhythm, list length) but never the fabrication rule. If the sample uses dashes, add `--allow-dashes`.
- **A fix must rewrite the sentence, not swap a synonym** from the same family ("pivoted" for "shifted").

## Output

- **The user pasted text to humanize:** show the first rewrite, a short critique (bullets), then the final version, then one line: `Check: PASS` or the remaining overrides.
- **You wrote the piece:** deliver the final version plus the one-line check summary. Show draft and critique only if asked.
- **Editing a file:** change prose only. Leave code, front matter, URLs, link targets and quotations untouched. The script skips code, front matter, URLs, tables and `>` block quotations; inline quotations it still checks, so ignore hits inside them.

## Voice

Use the owner's writing-voice notes when they're available (English: operational, information-dense, data first, minimal pleasantries), or a sample provided. If the project has a writing-style document, use it. Don't imitate a voice you haven't seen.

## Format notes

- **Newsletter email:** lowercase or plain subject line, plain text, one real specific detail in line one. No bolded labels, bulleted benefits or closing summary sentence.
- **Substack / Indie Lab essays:** highest risk of enumerated frameworks (P11), metadiscourse stacking (P06) and meta-label endings (P07). The script catches all three, but read the ending paragraph yourself.

Canonical long-form source: *Humanization Codex* (v4.3 changes are listed in `CHANGES-v4.3.md`).
