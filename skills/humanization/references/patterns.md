# Patterns (Codex v4.3)

Every structural tell, with its tier and a before/after. Word and phrase lists live in `blacklist.md`. The script reads its lists from there, so that file is the only place to change them.

## Tiers

| Tier | Meaning | What to do |
|---|---|---|
| **A** | Fails on one sighting | Fix every hit |
| **B** | Weak alone; careful writers use any one on purpose | Fix the paragraph only when 3+ Tier B hits share it |
| **R** | Script prints candidates, most are false positives | Read each, fix the real ones |
| **M** | Not greppable | Check during the critique step |

Check column: **S** = `verify_humanization.py` catches it, **M** = manual.

## 1. Staging instead of stating

| ID | Pattern | Tier | Before → After | Check |
|---|---|---|---|---|
| P01 | Negate-and-reframe (syncrisis), every form: "not just X, it's Y", "It wasn't X. It was Y.", "Not X. Not Y. Something older.", "not merely X but Y", "less X than Y" | A | "It's not a feature, it's a shift." → "Two people can now edit the same doc at once." | S |
| P02 | Staged run-up before the point: "Here's the thing.", "Honestly?", "Let's dive in", "The truth is", "Make no mistake" | A | "Here's the thing: most ARC readers never review." → "Most ARC readers never review." | S |
| P03 | Arguing with no one: an objection or option nobody raised | A | "I'm not saying ads are useless, but…" → state what ads did or didn't do | S |
| P04 | One-line closers and dramatic fragments | A (stock lines) / R (any paragraph ending in a sentence of 5 words or fewer) | "Let that sink in." → delete. "No prior. No nostalgia." → one specific claim | S |
| P05 | Sayings that sound deep | A | "At its core, what matters is trust." → the specific claim about trust | S |
| P06 | Metadiscourse stacking: max 2 signposts per 2,000 words | A above cap | Third "here's why" → delete it | S |
| P07 | Summary ending or meta-label header ("Key takeaways", "The bottom line") | A (labels) / M (restated thesis) | End on the last real thought | S + M |

## 2. Rhythm by rule

| ID | Pattern | Tier | Before → After | Check |
|---|---|---|---|---|
| P08 | Reflexive triads. Use as many items as the meaning needs. Three real items are fine. The tell is the reflex: three abstract nouns, three examples plus a lesson, three parallel takeaways. Don't fix a triad by padding to four or cutting a real item: that is the same reflex inverted. | R | "innovation, inspiration, and insights" → name the one thing that happened | S |
| P09 | More than 2 consecutive sentences opening with the same word | A | "She noted… She noted… She filed…" → merge or change subject | S |
| P10 | Uniform sentence length (a paragraph of 15–20-word sentences) | M | Mix a 4-word sentence with a 30-word one | M |
| P11 | Enumerated framework openers in prose: "First:", "Step 3:", "Day two:" | A | Fold into the sentence, or use a real numbered list | S |
| P12 | Dashes as the universal connector. Non-fiction: zero em dashes, max 1 grammatical en dash per 500 words (numeric ranges exempt). Fiction: see `fiction.md`. | A | "institutions—not people—yet" → commas, colon, parentheses or a period | S |
| P13 | Tailing negation tacked onto a clause | A | "It syncs instantly, no refresh needed." → "It syncs instantly." | S |
| P14 | Stacked qualifiers | B | "could potentially be argued" → "is arguable" or cut | S |
| P15 | Fronted openings: "As the sun set, …", "With a sigh, …", "Curious, Mara…". Max 2 in close proximity. | R | Start with the subject | S |

## 3. Inflation and borrowed authority

| ID | Pattern | Tier | Before → After | Check |
|---|---|---|---|---|
| P16 | Blacklisted vocabulary. Hard tier fails on one hit; frequency tier fails only above 3 per 1,000 words. | A | "leverage" → "use" | S |
| P17 | Inflated significance | A | "marking a pivotal moment for indie publishing" → keep the fact, drop the significance | S |
| P18 | Shallow -ing rider after a comma | A (showcasing, highlighting, underscoring, symbolizing, cementing, reflecting, signaling) / B (demonstrating, illustrating, contributing to) | "Shipped in March, showcasing our commitment to speed." → "Shipped in March, two weeks early." | S |
| P19 | Avoiding is/has | A (serves as, stands as, boasts) / B (functions as, represents a, features a) | "The app serves as a hub and boasts 40 templates." → "The app is a hub with 40 templates." | S |
| P20 | Vague association | B | "associated with the relaunch" → "caused by", "launched during", whatever the source says | S |
| P21 | Borrowed authority. Exempt when the same sentence carries a link, a citation "(Name, 2025)" or "according to [Named Source]". | A | "Experts believe ARC teams lift launch sales." → name the source and what it found, or cut | S |
| P22 | Sales language: nestled, breathtaking, must-see, world-class | A (listed words) / M | "nestled in the breathtaking hills" → "in the hills above Kraków" | S + M |
| P23 | Object agency: "the data shows", "the algorithm decided", "the math looks worse" | M | Name who acted: "Amazon's ranking dropped the book" | M |
| P24 | Vague quantities: "various", "significant", "a number of" | M | A number, a date, a name, or `[NEEDS: figure]` | M |

## 4. Formatting by rule

| ID | Pattern | Tier | Before → After | Check |
|---|---|---|---|---|
| P25 | Bold-colon or labeled listicle: `**Label:** text`, or 3+ consecutive "Label: text" lines | A | Turn it into prose, or a plain list without labels | S |
| P26 | Bold as decoration (more than 1 bold span per 150 words). In fiction any bold is Tier A. | R | "**OKRs** and **KPIs**" → plain text | S |
| P27 | Decorative headings: emoji in a heading (A), Title Case or slogan headings (R) | A / R | "🚀 Launch Phase:" → "Launch plan" | S |
| P28 | Mixed straight and curly quotes or apostrophes | A | Pick one. Curly for published prose. | S |

## 5. Leftovers from the chat and the draft

| ID | Pattern | Tier | Before → After | Check |
|---|---|---|---|---|
| P29 | Chatbot residue: "Great question", "I hope this helps", "Feel free to" | A | Delete the wrapper, keep the content | S |
| P30 | Knowledge-limit hedges: "based on available information", "details are limited" | A | State what the source shows, or cut the sentence | S |
| P31 | Heading echoed in the first sentence | R | "## Pricing" + "Pricing matters." → start with the price | S |
| P32 | Writing about the document instead of its subject: "In this post", "As mentioned above" (A); "the table below", "see below" (R) | A / R | "This post explores ARC timing." → the first finding about ARC timing | S |

## 6. Writing for the wrong reader

| ID | Pattern | Tier | Before → After | Check |
|---|---|---|---|---|
| P33 | Re-explaining what the reader already knows; diagnosis before the decision | M | Lead with the decision or answer; put diagnosis and proof after it, or in a separate note | M |
| P34 | Both-sides hedge with no position | M | Take the position the evidence supports and say what would change it | M |
