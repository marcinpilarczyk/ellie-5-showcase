#!/usr/bin/env python3
"""Check an English draft against the Humanization Codex v4.3.

Usage (stock Python 3, no dependencies):
    python3 <skill-dir>/scripts/verify_humanization.py draft.md
    python3 <skill-dir>/scripts/verify_humanization.py draft.md --fiction
    python3 <skill-dir>/scripts/verify_humanization.py - < draft.md      # stdin
    python3 <skill-dir>/scripts/verify_humanization.py draft.md --allow landscape,ecosystem
    python3 <skill-dir>/scripts/verify_humanization.py draft.md --allow-dashes

Word and phrase lists are read from references/blacklist.md (fenced blocks).
Pattern IDs (P01..P34) and tiers are defined in references/patterns.md:
  A  fails on one sighting
  B  weak alone: fails only when 3+ Tier B hits share a paragraph
  R  printed for a read, never fails
Exit code 0 = PASS, 1 = at least one Tier A failure or Tier B cluster.

Front matter, fenced code, inline code, URLs, link targets, HTML comments
table rows and block quotations (> lines) are ignored, so the check can run on a file's prose only.
"""
import argparse
import bisect
import math
import re
import sys
from collections import defaultdict
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
BLACKLIST = SKILL_DIR / "references" / "blacklist.md"

FREQ_PER_1000 = 3.0
FICTION_FREQ_PER_1000 = 2.0
B_CLUSTER = 3

EMOJI = re.compile("[\U0001F300-\U0001FAFF☀-➿⭐⬆↔-⇿]")
NO_XYZ = re.compile(r"\bno\s+[a-z][\w\s]{1,25}\.\s*no\s+[a-z][\w\s]{1,25}\.\s*just\s+[a-z]", re.I)
SYNC_TWO = re.compile(r"\bIt (?:wasn't|isn't|weren't|aren't)\b[^.!?\n]*[.!?]\s+It(?:'s| is| was)\b", re.I)
SYNC_TRIAD = re.compile(r"\bNot\s+\w+[^.!?\n]*[.!?]\s+Not\b[^.!?\n]*[.!?]\s+\w", re.I)
SYNC_LESS = re.compile(r"\bless\s+\w+(?:\s+\w+)?\s+than\s+\w+", re.I)
QUALIFIERS = re.compile(
    r"\b(?:could|might|may|possibly|potentially|perhaps|arguably|somewhat|likely|probably|seemingly)"
    r"\s+(?:\w+\s+)?(?:possibly|potentially|perhaps|arguably|somewhat|probably|seemingly|be\s+argued)\b",
    re.I,
)
FRONTED = re.compile(r"^(?:[A-Z]\w+ing\b[^,]{0,30},\s|As (?:the |a |an |he |she |they |I |we )|With a \w|With an \w"
                     r"|For a moment|In the silence|In the quiet|[A-Z][a-z]+(?:ly)?, [A-Z][a-z]+ )")
LY_STOP = {"only", "family", "early", "reply", "supply", "july", "italy", "daily", "likely",
           "apply", "rely", "fly", "ally", "belly", "holy", "ugly", "lonely", "lovely", "friendly",
           "weekly", "monthly", "yearly", "silly", "jelly", "bully", "hilly", "rally", "tally"}
STOPWORDS = {"the", "and", "for", "with", "that", "this", "from", "your", "what", "how", "why",
             "when", "about", "into", "over", "more", "less", "than", "their", "there"}


# ---------------------------------------------------------------- lists

def load_lists(path):
    """Return list of (kind, pid, tier, options, terms) from fenced blocks."""
    out = []
    text = path.read_text(encoding="utf-8")
    for m in re.finditer(r"```([^\n`]+)\n(.*?)```", text, re.S):
        head = m.group(1).split()
        kind = head[0]
        if kind not in {"words", "frequency", "fiction-frequency", "phrases", "metadiscourse"}:
            continue
        pid = head[1] if len(head) > 1 else "?"
        tier = head[2] if len(head) > 2 else "A"
        opts = set(head[3:])
        body = m.group(2)
        if kind == "phrases" or kind == "metadiscourse":
            terms = [l.strip().lower() for l in body.splitlines() if l.strip()]
        else:
            terms = [t.strip().lower() for t in re.split(r"[,\n]", body) if t.strip()]
        out.append((kind, pid, tier, opts, terms))
    return out


def term_re(term, inflect):
    if term == "rather":
        return re.compile(r"\brather\b(?!\s+than)", re.I)
    t = re.escape(term).replace(r"\ ", r"\s+")
    left = r"\b" if term[0].isalnum() else ""
    if term[-1].isalnum():
        right = r"\w*\b" if inflect else r"\b"
    else:
        right = ""
    return re.compile(left + t + right, re.I)


# ---------------------------------------------------------------- text prep

def blank(s):
    return re.sub(r"[^\n]", " ", s)


def extract(text):
    """Return (prose, headings). prose keeps every character position of text;
    non-prose spans are replaced by spaces so line numbers stay correct."""
    lines = text.split("\n")
    headings = []
    in_fm = lines and lines[0].strip() == "---"
    in_code = False
    for i, line in enumerate(lines):
        s = line.strip()
        if in_fm:
            if i > 0 and s == "---":
                in_fm = False
            lines[i] = blank(line)
            continue
        if s.startswith(("```", "~~~")):
            in_code = not in_code
            lines[i] = blank(line)
            continue
        if in_code or s.startswith(("|", ">")):  # tables, block quotations
            lines[i] = blank(line)
            continue
        if s.startswith("#"):
            headings.append((i + 1, s.lstrip("#").strip()))
            lines[i] = blank(line)
            continue
    prose = "\n".join(lines)
    prose = re.sub(r"<!--.*?-->", lambda m: blank(m.group(0)), prose, flags=re.S)
    prose = re.sub(r"`[^`\n]*`", lambda m: blank(m.group(0)), prose)
    prose = re.sub(r"(\]\()([^)\s]*)(\))", lambda m: "  " + blank(m.group(2)) + " ", prose)
    prose = re.sub(r"https?://\S+", lambda m: blank(m.group(0)), prose)
    return prose, headings


class Doc:
    def __init__(self, text):
        self.text = text.replace("\r\n", "\n")
        self.prose, self.headings = extract(self.text)
        # matching copy: same length, curly apostrophes normalised
        self.norm = self.prose.replace("’", "'").replace("‘", "'")
        self.nl = [m.start() for m in re.finditer("\n", self.text)]
        self.words = len(re.findall(r"[A-Za-z][\w'’-]*", self.prose)) or 1
        self.paras = [(m.start(), m.end()) for m in re.finditer(r"[^\n]+(?:\n[^\n]+)*", self.prose)
                      if m.group(0).strip()]

    def line(self, pos):
        return bisect.bisect_right(self.nl, pos - 1) + 1 if pos else 1

    def para_of(self, pos):
        for i, (a, b) in enumerate(self.paras):
            if a <= pos < b:
                return i
        return -1

    def sentence_at(self, pos):
        """Original-text sentence around pos. A boundary is .!? followed by
        whitespace, or a newline, so URLs and decimals don't split it."""
        a = 0
        for m in re.finditer(r"[.!?](?=\s)|\n", self.text[:pos]):
            a = m.end()
        m = re.compile(r"[.!?](?=\s|$)|\n").search(self.text, pos)
        b = m.end() if m else len(self.text)
        return self.text[a:b]

    def sentences(self):
        out = []
        for a, b in self.paras:
            for m in re.finditer(r"[^.!?\n]+[.!?]*", self.prose[a:b]):
                s = m.group(0).strip()
                if s:
                    out.append((a + m.start(), s))
        return out


# ---------------------------------------------------------------- checks

class Report:
    def __init__(self):
        self.items = []  # (tier, pid, label, line, detail, pos)
        self.seen = set()

    def add(self, tier, pid, label, line, detail, pos=-1):
        key = (pid, pos)
        if pos >= 0 and key in self.seen:
            return  # e.g. "pivot" and "pivotal" both matching the same word
        self.seen.add(key)
        self.items.append((tier, pid, label, line, detail, pos))


def snippet(s, n=90):
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def run(doc, lists, fiction, allow, allow_dashes):
    r = Report()
    low = doc.norm.lower()

    for kind, pid, tier, opts, terms in lists:
        terms = [t for t in terms if t not in allow]
        if kind == "words":
            for t in terms:
                for m in term_re(t, True).finditer(low):
                    r.add(tier, pid, "hard-tier word", doc.line(m.start()), m.group(0), m.start())
        elif kind in ("frequency", "fiction-frequency"):
            if kind == "fiction-frequency" and not fiction:
                continue
            cap = FICTION_FREQ_PER_1000 if kind == "fiction-frequency" else FREQ_PER_1000
            for t in terms:
                hits = list(term_re(t, kind == "frequency").finditer(low))
                if not hits:
                    continue
                rate = len(hits) * 1000 / doc.words
                lines = sorted({doc.line(h.start()) for h in hits})
                detail = f"{t}: {len(hits)}x ({rate:.1f}/1000w) lines {lines}"
                # Needs 2+ uses AND a rate above cap: one "rather than" in a
                # 100-word email is not overuse, whatever the per-1000 rate says.
                if len(hits) >= 2 and rate > cap:
                    r.add("A", pid, f"overused (2+ and >{cap:g}/1000w)", lines[0], detail)
                else:
                    r.add("R", pid, "frequency-tier word, within limit", lines[0], detail)
        elif kind == "phrases":
            for t in terms:
                for m in term_re(t, False).finditer(low):
                    if "cite-exempt" in opts:
                        sent = doc.sentence_at(m.start())
                        if re.search(r"\]\(|https?://|\(\s*[A-Z][^)]*\d{4}\s*\)|according to [A-Z]", sent):
                            continue
                    r.add(tier, pid, "phrase", doc.line(m.start()), m.group(0).strip(), m.start())
        elif kind == "metadiscourse":
            hits = [(m.start(), m.group(0)) for t in terms for m in term_re(t, False).finditer(low)]
            cap = 2 * max(1, math.ceil(doc.words / 2000))
            if len(hits) > cap:
                lines = sorted(doc.line(p) for p, _ in hits)
                r.add("A", pid, f"metadiscourse over cap ({len(hits)} > {cap})", lines[0],
                      f"lines {lines}")
            elif hits:
                r.add("R", pid, f"metadiscourse within cap ({len(hits)}/{cap})",
                      doc.line(hits[0][0]), ", ".join(h for _, h in hits))

    # P01 syncrisis regexes, NO X. NO Y. JUST Z.
    for rx, label in ((NO_XYZ, "no X. no Y. just Z."), (SYNC_TWO, "It wasn't X. It was Y."),
                      (SYNC_TRIAD, "Not X. Not Y. Something else."), (SYNC_LESS, "less X than Y")):
        for m in rx.finditer(doc.norm):
            r.add("A", "P01", label, doc.line(m.start()), snippet(m.group(0)), m.start())

    # P14 stacked qualifiers (B)
    for m in QUALIFIERS.finditer(doc.norm):
        r.add("B", "P14", "stacked qualifiers", doc.line(m.start()), m.group(0), m.start())

    # P12 dashes
    em = [m.start() for m in re.finditer("—", doc.prose)]
    if fiction:
        cap = max(1, doc.words // 500)
        if len(em) > cap:
            r.add("A", "P12", f"em dashes over fiction cap ({len(em)} > {cap})", doc.line(em[0]),
                  "permitted only for interrupted dialogue")
        elif em:
            r.add("R", "P12", "em dashes (fiction): interrupted dialogue only", doc.line(em[0]),
                  f"lines {sorted({doc.line(p) for p in em})}")
    elif not allow_dashes:
        for p in em:
            r.add("A", "P12", "em dash (non-fiction)", doc.line(p), snippet(doc.sentence_at(p), 70), p)
    en = [m.start() for m in re.finditer("–", doc.prose)
          if not re.search(r"\d\s*$", doc.prose[max(0, m.start() - 3):m.start()])]
    cap = doc.words // 500
    if len(en) > cap and not allow_dashes:
        r.add("A", "P12", f"grammatical en dashes over cap ({len(en)} > {cap})", doc.line(en[0]),
              f"lines {sorted({doc.line(p) for p in en})}")

    sents = doc.sentences()

    # P09 same-start runs
    def first_word(s):
        s = re.sub(r"^(?:[-*+]|\d+[.)])\s+", "", s)
        w = s.split()
        return w[0].lower().strip("\"'“‘*_,") if w else ""
    run_len, prev = 1, None
    for pos, s in sents:
        fw = first_word(s)
        if fw and fw == prev:
            run_len += 1
            if run_len == 3:
                r.add("A", "P09", "same-start run (3+)", doc.line(pos), f"'{fw}' x3+", pos)
        else:
            run_len = 1
        prev = fw

    # P13 tailing negations
    for m in re.finditer(r",\s*(?:no|without)\s+\w+[^.\n]{0,25}\.", doc.norm):
        r.add("A", "P13", "tailing negation", doc.line(m.start()), m.group(0).strip(), m.start())

    # P11 enumerated frameworks
    for m in re.finditer(r"(?m)^\s*(?:Day \w+|First|Second|Third|Fourth|Step \d+):", doc.prose):
        r.add("A", "P11", "enumerated framework opener", doc.line(m.start()), m.group(0).strip(), m.start())

    # P25 labeled listicle / P26 bold density
    for m in re.finditer(r"\*\*[^*\n]{2,40}\*\*:|\*\*[^*\n]{2,40}:\*\*", doc.prose):
        r.add("A", "P25", "bold-colon label", doc.line(m.start()), m.group(0), m.start())
    label_lines = [m for m in re.finditer(r"(?m)^\s*(?:[-*]\s+)?[A-Z][A-Za-z0-9 /&'-]{1,30}:\s+\S", doc.prose)]
    runs, cur = [], []
    for m in label_lines:
        ln = doc.line(m.start())
        if cur and ln == doc.line(cur[-1].start()) + 1:
            cur.append(m)
        else:
            cur = [m]
            runs.append(cur)
    for run_ in runs:
        if len(run_) >= 3:
            r.add("A", "P25", "3+ consecutive label lines", doc.line(run_[0].start()),
                  snippet(run_[0].group(0)), run_[0].start())
    bolds = [m.start() for m in re.finditer(r"\*\*[^*\n]+\*\*", doc.prose)]
    if fiction and bolds:
        r.add("A", "P26", "bold in fiction", doc.line(bolds[0]), f"{len(bolds)} spans")
    elif len(bolds) > max(1, doc.words / 150):
        r.add("R", "P26", "bold density", doc.line(bolds[0]),
              f"{len(bolds)} bold spans in {doc.words} words")

    # P27 headings, P31 heading echo
    for ln, h in doc.headings:
        if EMOJI.search(h):
            r.add("A", "P27", "emoji in heading", ln, h)
        words = re.findall(r"[A-Za-z]+", h)
        long_words = [w for w in words if len(w) >= 4]
        if len(words) >= 3 and long_words and all(w[0].isupper() for w in long_words):
            r.add("R", "P27", "Title Case heading", ln, h)
        key = {w.lower() for w in long_words if w.lower() not in STOPWORDS}
        nxt = [s for pos, s in sents if doc.line(pos) > ln]
        if key and nxt:
            first = set(re.findall(r"[a-z]+", nxt[0].lower()))
            if len(key & first) >= max(1, math.ceil(len(key) / 2)):
                r.add("R", "P31", "heading echoed in first sentence", ln, f"{h} -> {snippet(nxt[0], 60)}")

    # P28 quote consistency
    straight = len(re.findall(r"[\"']", doc.prose))
    curly = len(re.findall("[‘’“”]", doc.prose))
    if straight and curly:
        r.add("A", "P28", "mixed straight and curly quotes", 1, f"{straight} straight, {curly} curly")

    # P04 short closing fragments (R)
    for a, b in doc.paras:
        ps = [(p, s) for p, s in sents if a <= p < b]
        if len(ps) >= 2:
            p, s = ps[-1]
            if len(s.split()) <= 5 and not s.endswith("?"):
                r.add("R", "P04", "short closing fragment", doc.line(p), s, p)

    # P15 fronted openings (R)
    fronted = [(p, s) for p, s in sents if FRONTED.match(s)]
    if fronted:
        cap = max(2, doc.words // 250)
        note = f" (over rough cap {cap})" if len(fronted) > cap else ""
        r.add("R", "P15", f"fronted openings: {len(fronted)}{note}", doc.line(fronted[0][0]),
              " | ".join(snippet(s, 40) for _, s in fronted[:5]))

    # P08 triad candidates (R)
    for m in re.finditer(r"([^,.;:\n]{3,70}), ([^,.;:\n]{3,70}),? (?:and|or) ([^,.;:!?\n]{3,70})", doc.prose):
        r.add("R", "P08", "triad candidate", doc.line(m.start()), snippet(m.group(0)), m.start())

    # -ly adverbs (R): cut any that don't change meaning
    ly = [m for m in re.finditer(r"\b[a-z]{3,}ly\b", doc.norm.lower()) if m.group(0) not in LY_STOP]
    if ly:
        top = defaultdict(int)
        for m in ly:
            top[m.group(0)] += 1
        common = ", ".join(f"{w} x{n}" for w, n in sorted(top.items(), key=lambda x: -x[1])[:8])
        r.add("R", "M", f"-ly adverbs: {len(ly)} ({len(ly) * 1000 / doc.words:.0f}/1000w)",
              doc.line(ly[0].start()), common)

    # comma/period ratio (R, advisory only)
    periods = doc.prose.count(".") - len(re.findall(r"\d\.\d", doc.prose))
    commas = doc.prose.count(",")
    if periods:
        ratio = commas / periods
        flag = "" if 1.5 <= ratio <= 2.5 else " (outside the old 1.5-2.5 band; advisory)"
        r.add("R", "M", f"comma/period ratio {ratio:.2f}{flag}", 1, f"{commas}/{periods}")

    return r


def tier_b_clusters(doc, r):
    per = defaultdict(list)
    for tier, pid, label, line, detail, pos in r.items:
        if tier == "B" and pos >= 0:
            per[doc.para_of(pos)].append((pid, line, detail))
    return {k: v for k, v in per.items() if len(v) >= B_CLUSTER}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", nargs="?", default="-", help="file, or - for stdin")
    ap.add_argument("--fiction", action="store_true", help="fiction/blurb mode (see fiction.md)")
    ap.add_argument("--allow", default="", help="comma-separated listed words/phrases to permit as literal terms")
    ap.add_argument("--allow-dashes", action="store_true",
                    help="skip dash checks; only when author's own voice sample uses dashes")
    args = ap.parse_args()

    text = sys.stdin.read() if args.path == "-" else Path(args.path).read_text(encoding="utf-8")
    allow = {a.strip().lower() for a in args.allow.split(",") if a.strip()}
    doc = Doc(text)
    r = run(doc, load_lists(BLACKLIST), args.fiction, allow, args.allow_dashes)
    clusters = tier_b_clusters(doc, r)

    a_items = sorted((i for i in r.items if i[0] == "A"), key=lambda i: (i[3], i[1]))
    b_items = [i for i in r.items if i[0] == "B"]
    r_items = sorted((i for i in r.items if i[0] == "R"), key=lambda i: (i[1], i[3]))

    mode = "fiction" if args.fiction else "non-fiction"
    print(f"HUMANIZATION CHECK v4.3 | {mode} | {doc.words} words"
          + (f" | allowed: {', '.join(sorted(allow))}" if allow else "")
          + (" | dashes allowed" if args.allow_dashes else ""))

    print(f"\nTIER A: fix every hit ({len(a_items)})")
    for _, pid, label, line, detail, _ in a_items:
        print(f"  L{line:<4} {pid}  {label}: {detail}")
    if not a_items:
        print("  none")

    print(f"\nTIER B CLUSTERS: 3+ weak tells in one paragraph ({len(clusters)}); {len(b_items)} weak hits total")
    for _, hits in sorted(clusters.items()):
        print(f"  L{hits[0][1]:<4} " + "; ".join(f"{pid} {d}" for pid, _, d in hits))
    if not clusters:
        print("  none")

    print(f"\nTIER R: read, fix only the real ones ({len(r_items)})")
    for _, pid, label, line, detail, _ in r_items:
        print(f"  L{line:<4} {pid}  {label}: {detail}")

    print("\nMANUAL (critique step, see patterns.md): P10 sentence-length variety, P23 object agency,")
    print("  P24 vague quantities, P33 decision first, P34 take a position, read-aloud test")
    if args.fiction:
        print("  fiction: paraphrase ladders, dialogue debris, POV lock (fiction.md)")

    fails = len(a_items) + len(clusters)
    print(f"\nRESULT: {'PASS' if fails == 0 else f'FAIL ({len(a_items)} Tier A, {len(clusters)} Tier B clusters)'}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
