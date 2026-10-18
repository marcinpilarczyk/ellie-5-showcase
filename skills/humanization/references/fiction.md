# Prose-Specific Guidance (Fiction, Blurbs, Narrative)

Companion to `blacklist.md`. Apply when writing fiction, book blurbs, or narrative content. Source: Humanization Codex v4.2, triad rule updated in v4.3.

## Dialogue & narrative

- Kill direct emotional statements — characters never say "I'm afraid"; show through physical deflection.
- Force miscommunication — dialogue should make situations messier, not resolve them.
- **Characters who are too articulate** — distinct from the miscommunication rule above. A character can deliver a perfectly complete, well-formed evasion and still fail this check. Real people stumble, interrupt themselves, trail off mid-sentence, restart. If every line of dialogue is a grammatically whole sentence, that's a tell on its own even if the content is evasive rather than honest.
- **Dialogue debris** — related but distinct: real conversation between people who know each other also contains repetition, false starts, forgotten nouns, and remarks nobody answers. A character starting a sentence and not finishing it because the other person already knows how it ends is different from a character being evasive on purpose. Dialogue that's consistently clean — every line complete, every question addressed — has already undergone a compression a real exchange wouldn't have, even when the content itself is tense or clipped.
- 20% Physical Beat Rule — replace 20% of dialogue lines with physical actions implying subtext.
- No filtering verbs ("he felt," "she saw," "he smelled") — describe sensory input directly.

## Sensory authenticity

- Ban cliché clusters: "ozone and sweat," "sulfur and brimstone," "the smell of old books."
- The Flinch Rule: describe subtle physiological reactions before actions (sharp breath, cold prickle, averted eyes).
- **Embedded sensory triads** – the triad pattern (P08 in `patterns.md`) isn't only about bullet lists. "The room smelled of smoke, sweat, and fear" is a reflexive sensory triad with zero list markup, and `verify_humanization.py` prints it as a triad candidate. Default to one sharp sensory detail per beat. Three details are fine only when each does separate work in the scene; never pad to four or cut to two just to dodge the count.

## Deep interiority

- Tangential thoughts: characters think about irrelevant things (a stain on a sleeve, a hunger pang) during high-stakes moments.
- Internal contradiction: think one thing, do another.
- Stream of association over logical A→B transitions — sensory triggers, not logic chains.
- **Paraphrase ladders** — interiority that explains itself three times in a row: one sentence gives an image, the next translates it into psychology, the next translates the psychology into theme. By the third sentence nothing is left for the reader to infer. Pick the single strongest rung — usually the first or the last — and cut the other two. This is a distinct failure from the tangential-thought and stream-of-association rules above, which are about how interiority moves; this is about how much of it is redundant restatement of the same beat.

## Asymmetric focus

- Linger Rule: three sentences on an insignificant object, one sentence on a major action.
- Micro-pacing: in tension, slow the internal clock — describe the mechanics of a single movement in detail.

## Cognitive distortion

- Enforce unreliability: characters misinterpret others' motives.
- Emotional filter: environment described through the character's current emotion (the "aggressive" ticking of a clock, when angry).

## Technical

- No bolded keywords in narrative scenes.
- No bullet points in fiction.
- Curly/smart quotes, consistently.
- **Em dash exception, narrower than the general rule.** `blacklist.md` bans em dashes outright for non-fiction. In fiction, em dashes are permitted — but *only* for interrupted dialogue (a line cut off mid-sentence by another character or an event), max once per 500 words. This is not a general em-dash budget for any use in prose — a narrative sentence using an em dash as a parenthetical aside still falls under the general ban. `verify_humanization.py --fiction` flags em-dash hits for a human read rather than hard-failing them, because intent (interrupted dialogue vs. parenthetical) can't be determined by a grep.
- No formal sign-posting.
- **Fronted opening cap.** A fronted participial or adjectival opening ("Curious, Mara opened the box.") or a decorative dependent clause ("As the last light faded...", "With a quiet sigh...") is a legitimate structure used occasionally, but becomes conspicuous scene-transition machinery when repeated — this pattern is empirically grounded, not just observed (a 2025 short-story comparison found it significantly overrepresented in ChatGPT text specifically). No more than two in close proximity. `verify_humanization.py --fiction` counts these across the whole document and flags for a human read if the rate looks high; it can't reliably judge "close proximity" on its own, so a low overall count doesn't guarantee they aren't clustered in one scene.

## POV lock

- Every sentence must be "colored" by the character's current state of mind.
- No head-hopping or objective reporting.

## Vague substitute verbs (added from the Field Guide to Contemporary AI Fiction Tells, 2026)

A distinct failure mode from filtering verbs above — these aren't "he felt/she saw" distancing the reader from sensation, they're verbs that announce a change happened while declining to say what changed. All of them are checkable the same way as the general blacklist: if the sentence still means the same thing with the verb deleted, or if you can't name the specific event it's standing in for, it fails.

**The list:** shift/shifted (mood, dynamic, perspective, "something"), soften/softened (voice, expression, eyes, features), settle/settled (silence, understanding, calm), land/landed (mentally — "the words landed differently"), hold/held ("hold space," "hold the silence," "hold the contradiction"), shape/shaped ("shaped who she became" — ask what causal mechanism this is replacing), weight ("the weight of what happened"), space/distance used as an emotional substance ("the space between them," "she felt the distance").

The fix isn't a synonym swap — "the mood pivoted" is the same failure as "the mood shifted." The fix is naming the actual change: not "something shifted between them" but what specifically changed, in whose behavior, observable how.

## Stock kinetics and gesture vocabulary

The "tranquilized body" problem: characters move, gesture, and breathe through a small, interchangeable set of pre-sedated actions that communicate emotion without requiring anything character-specific. Ban or heavily ration:

- **Motion:** moved softly, stepped quietly, turned slowly, reached carefully, breathed gently, closed the door quietly.
- **Dialogue tags defaulting to low volume:** murmured, whispered, breathed, said softly/quietly — used as the default rather than the exception.
- **The micro-nod:** "a small nod," "he nodded once," "a slight nod."
- **The small smile:** "a small smile," "the hint of a smile," "a faint smile," "the ghost of a smile."
- **Eyes as an emotional display screen:** softening, darkening, hardening, widening, flickering, glinting, shining.
- **The interchangeable tension beats:** jaw tightened, hands clenched, shoulders tensed, throat worked, breath caught.
- **The interchangeable release beats:** shoulders dropped, tension left his shoulders, she let her shoulders relax.
- **Breath choreography as emotion-substitute:** inhaled/exhaled/released a breath/held a breath/let out a breath they didn't realize they were holding.
- **Chest/throat/stomach localization:** "something tightened in her chest," "warmth spread through his chest" — emotion defaulting to the same three body cavities regardless of the specific feeling.

The diagnostic question, same one that runs through the rest of this file: could this exact gesture be dropped unchanged into a different scene, different character, different book? If yes, it's doing atmosphere instead of character work.

## Story-level structure — separate concern, separate file

Everything above is checkable in a line-edit pass against a finished draft. A distinct and arguably harder-to-fix category — subplot presence, causal-chain tightness, chronological linearity, how resolution gets reached — isn't visible at the sentence level at all and can't be caught by `verify_humanization.py`. Read `references/story_structure.md` at the outline/planning stage, before drafting, not as a post-hoc check.

