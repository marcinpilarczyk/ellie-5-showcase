# Story-Level Structure Tells

Source: "Field Guide to Contemporary AI Fiction Tells" (2026), condensing findings from StoryScope (Russell, Rajendhran, Pham, Iyyer, Wieting — UMD/Google DeepMind, arXiv:2604.03136, 2026).

**This file is not a line-editing checklist.** Nothing here is greppable — `verify_humanization.py` can't check subplot density or causal-chain tightness the way it checks banned words. This is deliberate. StoryScope's own finding is that AI-generated fiction clusters in a shared region of *narrative* space, and that clustering survives sentence-level style rewrites — the paper's framing is that structure, not prose, is what actually separates AI-written stories from human ones. That means fixing every sentence in `fiction.md` and `blacklist.md` doesn't fix this. Read this at the outline stage, before drafting, or when revising a completed draft's architecture — not as a pre-publish pass.

## What StoryScope actually found (the [A]-grade, verified claims)

- 79% of AI-generated stories in the corpus had no subplot at all, vs. 57% of human stories. Subplots that did exist in AI fiction tended to echo the main theme at a different scale rather than create independent pressure.
- 77% of AI stories had the narrator directly state the theme, vs. 52% of human stories — the model doesn't trust inference.
- AI resolutions were more likely to hinge on protagonist choice/agency specifically, and more likely to resolve via internal understanding/acceptance rather than external change.
- Human stories used significantly more chronological discontinuity — flashbacks, flash-forwards, delayed revelation. AI fiction trends linear.
- Human stories occupied more locations and broader narrative configurations; AI trends toward a small controlled set (home, workplace, café, climactic location).
- Philosophical debate served as a dialogue function in 59% of AI stories vs. 34% of human stories.
- Embodied emotional expression (physiological description standing in for named emotion) appeared in 81% of AI stories vs. 38% of human stories.
- Smell imagery specifically appeared in 82% of AI stories vs. 57% of human stories.
- The deepest finding: different models given different premises make similar classes of narrative decisions. The question isn't "does this sentence sound AI" but "why did the story choose exactly the option thousands of other generated stories would also choose."

Treat the specific percentages as reported, not independently re-verified line by line — spot-check against the primary PDF (jenna-russell.github.io/assets/pdf/storyscope.pdf) before citing any of these numbers in published work.

## The planning-stage checklist

Ask these while outlining, not while editing prose:

1. **Does this book have a subplot that doesn't just restate the main theme at smaller scale?** A genuinely independent pressure — a secondary character's problem that doesn't resolve in service of the A-plot, a thread that stays open when the main plot closes.
2. **Is every event caused by the previous event, with nothing arising from coincidence, bureaucracy, bad timing, or irrelevant third parties?** If yes, that's the tell, not the craft achievement it looks like. Real causality has slack in it.
3. **Does the protagonist's choice resolve the central problem?** Consider whether an external event, someone else's decision, or plain bad luck should decide it instead, at least once.
4. **Is the timeline strictly linear?** A story that never uses delayed revelation, a flash-forward, or a scene understood only in retrospect is choosing the statistically safe structure.
5. **Does the narrator (or a character) state the theme directly at some point?** If the book's "about" statement is ever spoken aloud by anyone, cut it and see if the book still works — it should.
6. **Would a reader be able to predict this scene's ending from its premise?** Convenient confrontations (the right two people alone at the right moment), efficient revelations (backstory arriving just before it's needed), and calibrated escalation (obstacle → bigger obstacle → revelation → climax, each beat right on schedule) are all instances of the same problem.
7. **Is every object introduced early destined to matter later?** Real scenes have prop surplus — things that were just there, that never become symbolic.
8. **Does every strand of dialogue serve the book's central question?** Real conversation is sometimes about something that turns out not to matter.
9. **Named vs. vague cultural reference:** does a character think about "an old jazz song" and "some forgotten philosopher," or do they think about a specific track and a specific name? Vague allusion is cheaper to generate and reads as generic regardless of genre. For Miles Phoenix specifically, this cuts both ways — invented in-universe references (a specific unit designation, a named prior campaign) are fine and often better than real-world ones, but they still need to be *specific*, not "a famous battle" or "an old war story."
10. **Institutional/technical specificity:** characters who drink "coffee" and work at "the base" instead of a specific unit's specific mess hall and a named installation. This one maps directly onto the GROM/folk-NATO concept's own stated aesthetic (deadpan procedural language, the supernatural rendered as bureaucratic institution with protocols) — getting this right is simultaneously good craft for that project and structurally resistant to this whole tell category.
11. **Is there anything in the book that's genuinely eccentric, unexplained, or irrelevant to the theme** — a detail that exists because it's true to a character or setting, not because it pays off? StoryScope's authors call this the "irreducible local weirdness" that's disproportionately absent from AI-generated fiction.

## Caveat

Several of these overlap with ordinary competent-genre-fiction craft advice independent of authorship — tight causality and calibrated escalation are also just... solid plotting. The field guide that condensed this material flags this itself: clustering across many of these signals at once is informative, no single one is proof of anything. Don't treat "my book has tight causal chains" as evidence of a problem in isolation — treat "my book has tight causal chains AND no subplot AND linear chronology AND protagonist-resolved ending AND narrator states the theme" as worth a structural read-through.
