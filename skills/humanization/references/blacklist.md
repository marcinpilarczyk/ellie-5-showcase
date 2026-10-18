# Word and phrase lists (Codex v4.3)

`verify_humanization.py` reads the fenced blocks below. Edit lists here only; the script picks up changes automatically. Block header format: `<kind> <pattern ID> <tier> [options]`. Words: comma- or line-separated, inflections match (`leverage` also catches `leverages`, `leveraging`). Phrases: one per line, case-insensitive.

A listed word that is the literal, correct term (landscape architecture, a biological ecosystem, a pivot table) is allowed: pass `--allow <word>` and name the override in the check summary.

## Hard-tier words (P16, Tier A)

Words that rarely appear in ordinary human writing, or that the Codex classifies as AI verb/noun/adjective families. One hit fails.

```words P16 A
delve, leverage, utilize, facilitate, optimize, embark, underscore, empower, harness, foster
showcase, streamline, spearhead, bolster, revolutionize, supercharge, catalyze, amplify
turbocharge, pivot, curate, unpack, resonate, endeavor
ensuring, ensures, highlights
tapestry, realm, landscape, testament, synergy, underpinnings, journey, beacon, odyssey
paradigm, ecosystem, cornerstone, bedrock, linchpin, catalyst, game-changer, crucible
nexus, confluence, juxtaposition, dichotomy, interplay
pivotal, robust, innovative, seamless, exemplary, transformative, groundbreaking
cutting-edge, intricate, ethereal, meticulous, unwavering, multifaceted, nuanced, holistic
scalable, state-of-the-art, granular, actionable, myriad, plethora, paramount, adept
nestled, breathtaking, must-see, world-class
```

**Claude-isms.** When drafting with Claude, watch for its characteristic fingerprints.

```words P16 A
load-bearing, genuinely, scaffold, scaffolds, gating, gated, decisive, verdict, handoff, settles
```

## Frequency-tier words (P16, fail above 3 per 1,000 words)

Ordinary words that AI text overuses 2–4x. One use is fine. `rather` counts only when not followed by "than"; "rather than" is counted separately. `craft` is a problem as a verb ("craft an email"), fine as a noun.

```frequency P16 A
often, directly, strong, rather, craft
rather than
supports, reflects, broader, essential, effectively, significantly, reducing
align, navigate, enhance, dynamic, comprehensive
```

## Fiction frequency tier (`--fiction` only, fail above 2 per 1,000 words)

Vague substitute verbs and stock kinetics. See `fiction.md`.

```fiction-frequency P16 A
shift, shifted, soften, softened, settle, settled, landed, shaped, murmured, nodded
small smile, faint smile, jaw tightened, shoulders dropped, let out a breath
held her breath, held his breath
```

## Phrases

```phrases P01 A
not just
isn't just
aren't just
wasn't just
not merely
```

```phrases P02 A
here's the thing
honestly?
let's dive in
let's dive into
let's break it down
let's unpack
the truth is
make no mistake
spoiler:
```

```phrases P03 A
i'm not saying
this isn't really about
this isn't mainly about
this isn't about
a tempting approach would be
some might argue
you might think
it's tempting to
```

```phrases P04 A
let that sink in
read that again
and that changes everything
that is the real win
that's the real win
full stop.
this shows the importance of
```

```phrases P05 A
at its core
at the end of the day
what really matters
what truly matters
```

```metadiscourse P06 A
here's why
here's the part that matters
here's what
let me be clear
it's worth noting
worth noting that
let's look at
what this means is
```

```phrases P07 A
key takeaways
the real takeaway
the bottom line
in conclusion
in summary
to sum up
what would change my mind
```

```phrases P16 A
plays a crucial
plays a critical
plays an important
it is important to note
it's important to note
this stands as a testament to
in the ever-evolving landscape of
i hope this email finds you well
deep dive
north star
furthermore
moreover
consequently
notably
additionally
subsequently
in today's world
ultimately
```

```phrases P17 A
marking a pivotal
a pivotal moment
paving the way
paves the way
setting the stage for
sets the stage for
continues to thrive
the future looks bright
a significant milestone
```

```phrases P18 A
, showcasing
, highlighting
, underscoring
, symbolizing
, cementing
, reflecting
, signaling
, signalling
```

```phrases P18 B
, demonstrating
, illustrating
, contributing to
```

```phrases P19 A
serves as
stands as
boasts
```

```phrases P19 B
functions as
represents a
features a
features an
```

```phrases P20 B
associated with
in connection with
linked to
```

```phrases P21 A cite-exempt
experts believe
experts say
experts agree
studies show
studies suggest
research shows
research suggests
many believe
it is widely believed
it is widely accepted
observers note
critics argue
```

```phrases P29 A
great question
i hope this helps
feel free to reach out
don't hesitate to
let me know if you have any questions
let me know if you need anything else
i'd be happy to help
certainly!
absolutely!
as an ai
```

```phrases P30 A
as of my last
based on available information
based on available sources
details are limited
information is limited
while specific details
```

```phrases P32 A
in this post
in this article
in this essay
in this guide
this post will
this article will
this essay will
this post explores
this article explores
as mentioned above
as noted above
as mentioned earlier
```

```phrases P32 R
the table below
see below
```

## Rules for the lists

- Don't fix a hit with a synonym from the same family ("pivoted" for "shifted", "utilize" for "leverage"). Rewrite the sentence so it says what happened.
- When a list and a voice sample from the author disagree, the sample wins, except on fabrication.
