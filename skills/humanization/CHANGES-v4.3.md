# Humanization Codex v4.3: changes from v4.2

Drafted 2026-10-11 by claude. Input: comparison with blader/humanizer (MIT, built on Wikipedia's "Signs of AI writing"). The Codex Google Doc still reads v4.2. Apply these changes there so the doc and the skill match.

## Added patterns (ported from blader/humanizer)

- P03 Arguing with no one (A)
- P05 Sayings that sound deep (A)
- P17 Inflated significance phrases (A)
- P18 Shallow -ing riders after a comma (A strong set / B weak set)
- P19 Copula avoidance: serves as, stands as, boasts (A); functions as, represents a, features a (B)
- P20 Vague association (B)
- P21 Borrowed authority, exempt when the sentence carries a named, linked or dated source (A)
- P22 Sales language: nestled, breathtaking, must-see, world-class (A)
- P29 Chatbot residue (A)
- P30 Knowledge-limit hedges (A)
- P31 Heading echoed in the first sentence (R)
- P32 Writing about the document instead of its subject (A / R)
- P33 Re-explaining what the reader knows; lead with the decision (M)
- Strength tiers: A (one sighting), B (weak alone, fails at 3+ per paragraph), R (read), M (manual)

## Loosened (false positives on ordinary English)

- Moved from hard tier to frequency tier: rather than, supports, reflects, broader, essential, effectively, significantly, reducing, align, navigate, enhance, dynamic, comprehensive
- Frequency tier now fails only at 2+ uses and above the per-1,000-word rate, so one use in a short email is never a failure
- Comma/period ratio 1.5–2.5: now advisory (Tier R), not a hard failure
- Rule of three: "never three" replaced by "as many items as the meaning needs"; reflexive triads stay a Tier R read
- Removed the mandated digression and unresolved thread
- "Delete 90% of adverbs" replaced by an -ly adverb count for review
- Narrowed chatbot phrases so normal email lines ("let me know if Tuesday works", "happy to set it up") don't fail

## Structural changes to the skill

- SKILL.md is now a step-by-step workflow: classify, list facts, draft, check, critique, final
- New `references/patterns.md`: every pattern with ID, tier and before/after
- `references/blacklist.md` holds only word and phrase lists, in fenced blocks the script parses (single source of truth)
- Script: stock `python3` (no `uv`), finds its lists relative to itself, reads stdin, ignores front matter, code, URLs, tables and block quotations, reports line numbers grouped by tier, supports `--allow` and `--allow-dashes`
- Overrides documented: literal terms, author voice sample (never overrides the fabrication rule)
- Polish text routed to `humanizer`; broken `/mnt/project/Your_Writing_Style__A_Portrait` reference removed
- Fixed mislabels ("hedging verbs" list held adjectives and adverbs) and the doc/script mismatch (metadiscourse is now actually counted)
