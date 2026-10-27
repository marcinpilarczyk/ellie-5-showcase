/**
 * Deterministic Claims Bank check for generated positioning / outreach text.
 * The owner's Claims Bank (a Google Doc) lists the only specifics Ellie may assert.
 */

import { OWNER_NAME, OWNER_FULL_NAME, readPrivateJson } from '../config/owner.js';

export function claimsBankDocId(): string {
  const id = process.env.ELLIE_CLAIMS_BANK_DOC_ID?.trim();
  if (!id) throw new Error('No Claims Bank is configured (ELLIE_CLAIMS_BANK_DOC_ID).');
  return id;
}

export type ClaimConfidence = 'V' | 'C';

export interface ClaimKey {
  kind: string;      // 'num' | 'pct' | 'cur:eur' | 'cur:usd' ...
  value: string;     // normalised numeric value
  unit: string;      // stemmed unit word when recognised, else ''
  raw: string;       // text as written in the source
}

export interface BankEntry {
  id: string;
  confidence: ClaimConfidence;
  text: string;
  keys: ClaimKey[];
  words: Set<string>;
}

export interface ParsedClaimsBank {
  entries: BankEntry[];
  neverPhrases: string[];
  neverBullets: string[];
  wordSet: Set<string>;
}

export type ClaimViolationKind = 'UNSOURCED_CLAIM' | 'NEVER_CLAIM';

export interface ClaimViolation {
  kind: ClaimViolationKind;
  claim: string;
  reason: string;
}

export interface ClaimFlag {
  claim: string;
  entryId: string;
  reason: string;
}

export type ClaimsCheckStatus = 'OK' | 'NEEDS_PHRASING_CHECK' | 'UNSOURCED_CLAIM' | 'CLAIMS_BANK_UNAVAILABLE';

export interface ClaimsCheckResult {
  status: ClaimsCheckStatus;
  blocked: boolean;
  violations: ClaimViolation[];
  flags: ClaimFlag[];
  message: string;
}

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

const UNITS = new Set([
  'year', 'yr', 'month', 'week', 'day', 'quarter',
  'person', 'people', 'engineer', 'architect', 'report', 'employee', 'staff', 'rep', 'agent', 'fte', 'hire', 'member',
  'customer', 'client', 'account', 'partner', 'listing', 'launch', 'unit', 'sku', 'page', 'market', 'country', 'team',
  'skill', 'tvc', 'lead', 'manager', 'csm', 'ticket', 'project', 'integration', 'office', 'site', 'user', 'seat'
]);

const NUMBER_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100
};

const SUFFIX_MULT: Record<string, number> = { k: 1e3, thousand: 1e3, tys: 1e3, m: 1e6, mm: 1e6, million: 1e6, mln: 1e6, bn: 1e9, billion: 1e9 };
const CURRENCY: Record<string, string> = { '€': 'eur', '$': 'usd', '£': 'gbp', eur: 'eur', euro: 'eur', euros: 'eur', usd: 'usd', dollar: 'usd', dollars: 'usd', gbp: 'gbp', pln: 'pln', 'zł': 'pln', zl: 'pln' };

function mask(text: string, pattern: RegExp): string {
  return text.replace(pattern, m => ' '.repeat(m.length));
}

export function cleanForExtraction(text: string): string {
  let s = (text ?? '')
    .replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, '$1')
    .replace(/[‐-―]/g, '-')
    .replace(/ /g, ' ')
    .replace(/(?:-\s*>|–>|→|⟶|=>)/g, ' → ')
    .replace(/^\s*\d+[a-z]?[.)]\s+/gm, '')
    .replace(/(\d+(?:\.\d+)?)\s*(?:→|\bto\b|-)\s*(\d+(?:\.\d+)?)\s+([A-Za-zł]+)/g, (m, a, b, w) => (stemUnit(w) ? `${a} ${w} → ${b} ${w}` : m));
  s = mask(s, /https?:\/\/\S+|www\.\S+/gi);
  s = mask(s, /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g);
  s = mask(s, /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?\b/g);
  s = mask(s, /\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g);
  s = mask(s, /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?m\.?)?/gi);
  s = mask(s, new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\b\\.?(?:,?\\s+\\d{4})?`, 'gi'));
  s = mask(s, new RegExp(`\\b(?:${MONTHS})\\b\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?`, 'gi'));
  s = mask(s, /\b(?:19|20)\d{2}\s?-\s?(?:19|20)?\d{2}\b/g);
  s = s.replace(/(?<![€$£\d,.])\b(?:19|20)\d{2}\b(?![,.]\d)(\s?(?:%|[A-Za-zł]+))?/g, (m, after) => {
    const next = (after ?? '').trim();
    if (next === '%' || (next && (stemUnit(next) !== '' || CURRENCY[next.toLowerCase()] !== undefined))) return m;
    return ' '.repeat(m.length);
  });
  s = mask(s, /\+?\d[\d\s().-]{7,}\d/g);
  s = mask(s, /\b\d{6,}\b/g);
  s = mask(s, /\b[A-Za-z_]+[-_#]?\d+[A-Za-z0-9_-]*\b/g);
  s = mask(s, /\b\d+(?:st|nd|rd|th)\b/gi);
  s = mask(s, /\b\d+(?:[.,]\d+)?[\s-]*(?:min(?:ute)?s?|hours?|hrs?|secs?|seconds?)\b/gi);
  s = mask(s, /\b\d+(?:[.,]\d+)?[\s-]*(?:days?|weeks?|months?|quarters?)\b/gi);
  s = mask(s, /\b\d+-(?:day|week|month|quarter)\b/gi);
  s = mask(s, /\(?\b\d+\s*(?:characters?|chars?)\b\)?/gi);
  s = mask(s, /(?:\b(over|more than|nearly|almost|about|around|ponad|prawie)\s+)?\b\d{1,2}\s*\+?\s*(?:years?|yrs|lat)\b/gi);
  return s;
}

function stemUnit(word: string): string {
  const w = word.toLowerCase().replace(/[^a-zł]/g, '');
  if (UNITS.has(w)) return w;
  if (w.endsWith('ies') && UNITS.has(w.slice(0, -3) + 'y')) return w.slice(0, -3) + 'y';
  if (w.endsWith('s') && UNITS.has(w.slice(0, -1))) return w.slice(0, -1);
  if (w === 'ftes') return 'fte';
  if (w === 'csms') return 'csm';
  if (w === 'tvcs') return 'tvc';
  if (w === 'skus') return 'sku';
  return '';
}

function formatValue(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6);
}

const NUMBER_RE = new RegExp(
  '([€$£])?\\s?' +
  '(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d+))?' +
  '(?:\\s?(k|mm|m|bn|million|billion|thousand|mln|tys)\\b)?' +
  '(\\+)?' +
  '(?:\\s?(%|percent\\b|per cent\\b))?' +
  '(?:[\\s-]+([A-Za-zł]+))?',
  'gi'
);

export function extractClaimKeys(text: string): ClaimKey[] {
  const s = cleanForExtraction(text);
  const keys: ClaimKey[] = [];

  const TIME_UNITS = new Set(['year', 'yr', 'month', 'week', 'day', 'quarter']);

  for (const m of s.matchAll(NUMBER_RE)) {
    const [raw, cur, intPart, dec, suffix, , pct, nextWord] = m;
    let value = parseFloat(intPart.replace(/,/g, '') + (dec ? '.' + dec : ''));
    if (Number.isNaN(value)) continue;
    if (suffix) value *= SUFFIX_MULT[suffix.toLowerCase()] ?? 1;

    let kind = 'num';
    let unit = '';
    if (pct) {
      kind = 'pct';
    } else if (cur) {
      kind = `cur:${CURRENCY[cur]}`;
    } else if (nextWord && CURRENCY[nextWord.toLowerCase()]) {
      kind = `cur:${CURRENCY[nextWord.toLowerCase()]}`;
    } else if (nextWord) {
      unit = stemUnit(nextWord);
    }
    if (kind === 'pct' || kind.startsWith('cur:') || (unit !== '' && !TIME_UNITS.has(unit))) {
      keys.push({ kind, value: formatValue(value), unit, raw: raw.trim() });
    }
  }

  const tokens = s.match(/[A-Za-zł]+|[^\sA-Za-zł]+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i].toLowerCase();
    const n = NUMBER_WORDS[w];
    if (n === undefined) continue;
    const after = tokens.slice(i + 1, i + 4);
    const unitIdx = after.findIndex(t => stemUnit(t) !== '');
    const teamOf = i > 0 && tokens[i - 1].toLowerCase() === 'of' && /^(team|squad|group)$/i.test(tokens[i - 2] ?? '');
    const unit = unitIdx >= 0 ? stemUnit(after[unitIdx]) : '';
    if ((unitIdx >= 0 && !TIME_UNITS.has(unit)) || teamOf) {
      keys.push({ kind: 'num', value: String(n), unit: teamOf && !unit ? 'person' : unit, raw: [tokens[i], ...after.slice(0, unitIdx + 1)].join(' ') });
    }
  }
  return keys;
}

const keyId = (k: ClaimKey) => `${k.kind}:${k.value}`;

function unitCompatible(a: string, b: string): boolean {
  return a === '' || b === '' || a === b;
}

const GREETINGS = new Set(['hi', 'hello', 'hey', 'dear', 'cześć', 'czesc', 'witaj', 'szanowny', 'szanowna']);
const STOP_WORDS_FOR_NAMES = new Set(['i', OWNER_NAME.toLowerCase(), 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
const OWNER_TAG = new RegExp(`\\[(V|C|${OWNER_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b)`);

function wordsOf(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []));
}

export function parseClaimsBank(docText: string): ParsedClaimsBank {
  const lines = (docText ?? '').replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, '$1').trim());
  const entries: BankEntry[] = [];
  const neverPhrases: string[] = [];
  const neverBullets: string[] = [];
  let section: 'normal' | 'never' | 'index' = 'normal';

  for (const line of lines) {
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s*(.*)$/);
    if (heading) {
      const title = heading[1].trim();
      if (/^\[X\]/i.test(title) || /never claim/i.test(title)) section = 'never';
      else if (/topic index/i.test(title)) section = 'index';
      else section = 'normal';
      continue;
    }
    if (section === 'index') continue;

    if (section === 'never') {
      const bullet = line.match(/^[-*•]\s+(.*)$/);
      if (bullet) {
        neverBullets.push(bullet[1]);
        for (const q of bullet[1].matchAll(/["“”']([^"“”']{3,60})["“”']/g)) neverPhrases.push(q[1].trim().toLowerCase());
      }
      continue;
    }

    const entry = line.match(/^(\d+[a-z]?)[.)]\s+(.*)$/);
    if (!entry) continue;
    const [, id, body] = entry;
    const tag = body.match(OWNER_TAG);
    if (!tag) continue;
    const text = body.slice(0, tag.index).trim();
    const confidence: ClaimConfidence = tag[1] === 'C' ? 'C' : 'V';
    entries.push({ id, confidence, text, keys: extractClaimKeys(text), words: wordsOf(text) });
  }

  const wordSet = new Set<string>();
  for (const e of entries) for (const w of e.words) wordSet.add(w);
  return { entries, neverPhrases, neverBullets, wordSet };
}

export interface NeverRule { id: string; re: RegExp; reason: string }

interface NeverClaimsFile {
  allowedFigures?: string[];
  rules?: Array<{ id: string; pattern: string; reason: string }>;
}

export interface NeverClaims {
  rules: NeverRule[];
  allowedKeys: Set<string>;
}

export function loadNeverClaims(): NeverClaims {
  const file = readPrivateJson<NeverClaimsFile>('never-claims.json') ?? {};
  return {
    rules: (file.rules ?? []).map(r => ({ id: r.id, re: new RegExp(r.pattern, 'i'), reason: r.reason })),
    allowedKeys: new Set((file.allowedFigures ?? []).flatMap(figure => extractClaimKeys(figure).map(keyId)))
  };
}

let NEVER_CLAIMS = loadNeverClaims();

export function setNeverClaims(neverClaims: NeverClaims): void {
  NEVER_CLAIMS = neverClaims;
}

const RESULT_VERBS = new Set([
  'cut', 'reduced', 'launched', 'built', 'led', 'ran', 'grew', 'increased', 'scaled', 'delivered', 'directed',
  'co-led', 'implemented', 'saved', 'doubled', 'halved', 'improved', 'shipped', 'drove', 'managed', 'owned',
  'created', 'established', 'generated', 'helped', 'moved', 'automated', 'standardised', 'standardized', 'sustained', 'stood'
]);

export interface CheckOptions {
  allowNames?: string[];
  neverClaims?: NeverClaims;
  skipNamedEntities?: boolean;
}

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
}

function namedEntities(sentence: string): string[] {
  const tokens = sentence.match(/[\p{L}][\p{L}'’-]*/gu) ?? [];
  const out: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.length < 2 || !/^\p{Lu}/u.test(t)) continue;
    if (STOP_WORDS_FOR_NAMES.has(t.toLowerCase())) continue;
    if (GREETINGS.has(tokens[i - 1].toLowerCase())) continue;
    out.push(t);
  }
  return out;
}

export function checkAgainstBank(bank: ParsedClaimsBank, text: string, options: CheckOptions = {}): ClaimsCheckResult {
  const violations: ClaimViolation[] = [];
  const flags: ClaimFlag[] = [];
  const body = (text ?? '').replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, '$1');

  // 1. [X] never-claim rules
  const never = options.neverClaims ?? NEVER_CLAIMS;
  for (const rule of never.rules) {
    const m = body.match(rule.re);
    if (m) violations.push({ kind: 'NEVER_CLAIM', claim: m[0].trim(), reason: rule.reason });
  }
  const lower = body.toLowerCase();
  for (const phrase of bank.neverPhrases) {
    if (lower.includes(phrase) && !violations.some(v => v.claim.toLowerCase().includes(phrase))) {
      violations.push({ kind: 'NEVER_CLAIM', claim: phrase, reason: 'Quoted in Claims Bank [X] never-claim list.' });
    }
  }

  // 2. Numbers, percentages, amounts
  const seen = new Set<string>();
  for (const key of extractClaimKeys(body)) {
    const dedupe = `${keyId(key)}:${key.unit}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    if (never.allowedKeys.has(keyId(key))) continue;

    const matches = bank.entries.filter(e => e.keys.some(k => k.kind === key.kind && k.value === key.value && unitCompatible(k.unit, key.unit)));
    if (matches.length === 0) {
      violations.push({
        kind: 'UNSOURCED_CLAIM',
        claim: key.raw,
        reason: `"${key.raw}" matches no Claims Bank entry.`
      });
    } else if (!matches.some(e => e.confidence === 'V')) {
      flags.push({ claim: key.raw, entryId: matches[0].id, reason: `Only context-dependent entry ${matches[0].id} supports "${key.raw}".` });
    }
  }

  // 3. Named results
  if (!options.skipNamedEntities) {
    const allowed = new Set((options.allowNames ?? []).map(n => n.toLowerCase()));
    for (const sentence of sentencesOf(body)) {
      const tokens = (sentence.toLowerCase().match(/[\p{L}][\p{L}'’-]*/gu) ?? []);
      if (!tokens.some(t => RESULT_VERBS.has(t))) continue;
      for (const name of namedEntities(sentence)) {
        const n = name.toLowerCase();
        if (bank.wordSet.has(n) || allowed.has(n)) continue;
        violations.push({
          kind: 'UNSOURCED_CLAIM',
          claim: name,
          reason: `"${name}" appears in a result statement but is not named in Claims Bank.`
        });
      }
    }
  }

  const blocked = violations.length > 0;
  const status: ClaimsCheckStatus = blocked ? 'UNSOURCED_CLAIM' : flags.length > 0 ? 'NEEDS_PHRASING_CHECK' : 'OK';
  const message = blocked
    ? `UNSOURCED_CLAIM: ${violations.map(v => `${v.kind === 'NEVER_CLAIM' ? '[X] ' : ''}${v.claim} (${v.reason})`).join('; ')}`
    : flags.length > 0
      ? `NEEDS_PHRASING_CHECK: ${flags.map(f => f.reason).join('; ')}`
      : 'All claims match the Claims Bank.';
  return { status, blocked, violations, flags, message };
}

// ---------------------------------------------------------------------------
// Identity details: contact data, profile links, years of experience and titles.
// The figure check above masks emails, URLs and years, so these need their own pass.
// ---------------------------------------------------------------------------

export type IdentityKind = 'email' | 'url' | 'phone' | 'experience' | 'title';

export interface IdentityDetail {
  kind: IdentityKind;
  raw: string;
  /** Contains the owner's name: only the owner's own sources can ground it, never run evidence. */
  aboutOwner: boolean;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL_RE = /\bhttps?:\/\/[^\s<>()"'\]]+|\bwww\.[^\s<>()"'\]]+|\b(?:[a-z0-9-]+\.)+(?:com|io|pl|net|org|ai|co|dev|eu|me|app|uk|de|info|biz)\b(?:\/[^\s<>()"'\]]*)?/gi;
const PHONE_RE = /(?<![\w/])\+?\(?\d[\d \t()-]{7,}\d(?![\w/])/g;
const EXPERIENCE_RE = /(?:\b(over|more than|nearly|almost|about|around|ponad|prawie)\s+)?\b(\d{1,2})\s*(\+)?\s*(?:years?|yrs|lat)\b([^.\n]{0,40})/gi;
const TITLE_HEAD = String.raw`(?:Chief\s+[A-Z][a-z]+\s+Officer|C[A-Z]O|Vice\s+President|S?E?VP|Head|Director|General\s+Manager|Managing\s+Director|Country\s+Manager)`;
const TITLE_RE = new RegExp(
  String.raw`\b(?:(?:Senior|Sr\.?|Global|Regional|Interim|Fractional|Executive|Group|Deputy|Associate)[ \t]+)*${TITLE_HEAD}\b` +
  String.raw`(?:[ \t]*(?:,|of|for|-|–)?[ \t]*(?:the[ \t]+)?[A-Z][\w&/+-]*(?:[ \t]+(?:&|and|[A-Z][\w&/+-]*))*)?`,
  'g'
);

function foldDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L');
}

function ownerNameTokens(): string[] {
  return foldDiacritics(process.env.ELLIE_OWNER_FULL_NAME?.trim() || OWNER_FULL_NAME).toLowerCase().split(/[^a-z]+/).filter(t => t.length >= 3 && t !== 'the');
}

function mentionsOwner(raw: string, tokens: string[]): boolean {
  const s = foldDiacritics(raw).toLowerCase();
  return tokens.some(t => s.includes(t));
}

function normUrl(u: string): string {
  return u.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
}

function normTitle(t: string): string {
  return foldDiacritics(t).toLowerCase()
    .replace(/vice\s+president/g, 'vp')
    .replace(/\b(?:of|for|the|and)\b|[,&–-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function phoneDigits(raw: string): string | undefined {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return undefined;
  const groups = raw.match(/\d+/g) ?? [];
  if (groups.every(g => /^(?:19|20)\d{2}$/.test(g))) return undefined; // year ranges, not phones
  return digits;
}

export function extractIdentityDetails(text: string, ownerTokens: string[] = ownerNameTokens()): IdentityDetail[] {
  const out: IdentityDetail[] = [];
  const seen = new Set<string>();
  const add = (kind: IdentityKind, raw: string) => {
    const key = `${kind}:${raw.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, raw, aboutOwner: (kind === 'email' || kind === 'url') && mentionsOwner(raw, ownerTokens) });
  };
  let s = (text ?? '').replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, '$1');

  for (const m of s.matchAll(EMAIL_RE)) add('email', m[0].replace(/[.,;:]+$/, ''));
  s = mask(s, EMAIL_RE);
  for (const m of s.matchAll(URL_RE)) add('url', m[0].replace(/[.,;:!?]+$/, ''));
  s = mask(s, URL_RE);
  for (const m of s.matchAll(PHONE_RE)) if (phoneDigits(m[0])) add('phone', m[0].trim());
  for (const m of s.matchAll(EXPERIENCE_RE)) {
    const [, qualifier, n, plus, after] = m;
    if (plus || qualifier || /\b(?:experience|doświadczenia|doswiadczenia)\b/i.test(after ?? '')) add('experience', `${n}${plus ? '+' : ''} years`);
  }
  for (const m of s.matchAll(TITLE_RE)) {
    const raw = m[0].trim().replace(/[\s,–-]+$/, '');
    // A bare "Head" or "Director" says nothing checkable; a title needs its area (or is a C-level acronym).
    if (/^(?:(?:Senior|Sr\.?|Global|Regional|Interim|Fractional|Executive|Group|Deputy|Associate)\s+)*(?:Head|Director|VP|SVP|EVP|Vice\s+President|General\s+Manager|Managing\s+Director|Country\s+Manager)$/.test(raw)) continue;
    add('title', raw);
  }
  return out;
}

/** A searchable form of the texts that may ground identity details. */
export interface IdentityCorpus {
  lower: string;
  urls: string;
  titles: string;
  phones: string[];
}

export function buildIdentityCorpus(texts: readonly string[]): IdentityCorpus {
  const joined = texts.join('\n');
  const lower = foldDiacritics(joined).toLowerCase();
  return {
    lower,
    urls: lower.replace(/https?:\/\//g, '').replace(/\bwww\./g, ''),
    titles: normTitle(joined),
    phones: [...joined.matchAll(PHONE_RE)].map(m => phoneDigits(m[0])).filter((d): d is string => Boolean(d))
  };
}

function grounded(detail: IdentityDetail, corpus: IdentityCorpus): boolean {
  switch (detail.kind) {
    case 'email': return corpus.lower.includes(foldDiacritics(detail.raw).toLowerCase());
    case 'url': return corpus.urls.includes(normUrl(foldDiacritics(detail.raw)));
    case 'phone': {
      const tail = phoneDigits(detail.raw)!.slice(-9);
      return corpus.phones.some(p => p.endsWith(tail));
    }
    case 'experience': {
      const n = detail.raw.match(/\d+/)![0];
      return new RegExp(`(?<!\\d)${n}\\s*\\+?\\s*(?:years?|yrs|lat)\\b`).test(corpus.lower);
    }
    case 'title': return corpus.titles.includes(normTitle(detail.raw));
  }
}

/**
 * Identity details in `text` that no source supports. Details naming the owner must appear in
 * the owner's own sources; everything else may also come from what the run read (a recruiter's
 * address from the posting, a link from a search result).
 */
export function findUngroundedIdentity(text: string, ownerSources: IdentityCorpus, runEvidence: IdentityCorpus, ownerTokens?: string[]): IdentityDetail[] {
  return extractIdentityDetails(text, ownerTokens).filter(d =>
    !grounded(d, ownerSources) && (d.aboutOwner || !grounded(d, runEvidence))
  );
}

const IDENTITY_LABEL: Record<IdentityKind, string> = {
  email: 'email address', url: 'link', phone: 'phone number', experience: 'years of experience', title: 'job title'
};

export function identityCheckResult(unverified: IdentityDetail[], sourceNote = ''): ClaimsCheckResult {
  if (unverified.length === 0) {
    return { status: 'OK', blocked: false, violations: [], flags: [], message: 'All identity details trace to a source.' };
  }
  const violations: ClaimViolation[] = unverified.map(d => ({
    kind: 'UNSOURCED_CLAIM',
    claim: d.raw,
    reason: d.aboutOwner
      ? `${IDENTITY_LABEL[d.kind]} naming ${OWNER_NAME} is not in ${OWNER_NAME}'s own sources`
      : `${IDENTITY_LABEL[d.kind]} is not in ${OWNER_NAME}'s sources or in anything read in this run`
  }));
  return {
    status: 'UNSOURCED_CLAIM',
    blocked: true,
    violations,
    flags: [],
    message: `UNVERIFIED_IDENTITY: ${violations.map(v => `"${v.claim}" (${v.reason})`).join('; ')}. ` +
      `Use only details from ${OWNER_NAME}'s profile, record or Claims Bank, or from a source you read in this run; otherwise leave them out.${sourceNote}`
  };
}

export interface ClaimsGuard {
  /** Claims Bank figures, named results and never-claims (text in the owner's voice). */
  check(text: string, options?: CheckOptions): Promise<ClaimsCheckResult>;
  checkText?(text: string, options?: CheckOptions): Promise<ClaimsCheckResult>;
  /** Emails, links, phones, years of experience and titles must trace to the owner's sources or the run's evidence. */
  checkIdentity?(text: string, runEvidence?: readonly string[]): Promise<ClaimsCheckResult>;
}

const UNAVAILABLE = (why: string): ClaimsCheckResult => ({
  status: 'CLAIMS_BANK_UNAVAILABLE',
  blocked: true,
  violations: [{ kind: 'UNSOURCED_CLAIM', claim: '*', reason: why }],
  flags: [],
  message: `CLAIMS_BANK_UNAVAILABLE: ${why}`
});

import { scanHumanization, mustFixFindings } from './humanizer-scanner.js';

export interface OwnerTextReview {
  /** Reasons a write of this text is refused; empty when it may be written. */
  refusals: string[];
  /** Humanization scanner lines that must be fixed (advice to the model, never a refusal). */
  style?: { language: string; mustFix: string[] };
}

/**
 * The one review of owner text, shared by the dispatcher gate (before any write) and by
 * owner_text_check (a dry run the model calls on a draft), so the two can never disagree.
 * Messages get the Claims Bank check; identity details are checked unless the owner already
 * approved this exact text.
 */
export async function reviewOwnerText(
  guard: ClaimsGuard,
  kind: 'message' | 'document',
  text: string,
  options: { evidence?: readonly string[]; identity: boolean; style?: boolean }
): Promise<OwnerTextReview> {
  const refusals: string[] = [];
  const checkFn = typeof guard.check === 'function'
    ? guard.check.bind(guard)
    : (typeof guard.checkText === 'function' ? guard.checkText.bind(guard) : undefined);
  if (checkFn) {
    const checkOpts: CheckOptions = kind === 'document' ? { skipNamedEntities: true } : {};
    const bank = await checkFn(text, checkOpts);
    if (bank.blocked) {
      refusals.push(bank.message);
    }
  }
  if (options.identity && typeof guard.checkIdentity === 'function') {
    const identity = await guard.checkIdentity(text, options.evidence ?? []);
    if (identity.blocked) refusals.push(identity.message);
  }
  const review: OwnerTextReview = { refusals };
  if (options.style) {
    const scan = scanHumanization(text);
    review.style = { language: scan.language, mustFix: scan.passed ? [] : mustFixFindings(scan.output, scan.language).slice(0, 30) };
  }
  return review;
}

export interface OwnerSources {
  texts: string[];
  /** Sources that could not be read; named in refusals so the gap is visible. */
  missing: string[];
}

export class ClaimsBankGuard implements ClaimsGuard {
  private cached?: { bank: ParsedClaimsBank; loadedAt: number };
  private cachedSources?: { corpus: IdentityCorpus; missing: string[]; loadedAt: number };

  constructor(
    private readonly loadDocText: () => Promise<string>,
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly loadOwnerSources?: () => Promise<OwnerSources>
  ) {}

  private async bank(): Promise<ParsedClaimsBank> {
    const now = Date.now();
    if (this.cached && now - this.cached.loadedAt < this.ttlMs) return this.cached.bank;
    const bank = parseClaimsBank(await this.loadDocText());
    if (bank.entries.length === 0) throw new Error('Claims Bank contains no usable entries.');
    this.cached = { bank, loadedAt: now };
    return bank;
  }

  private async ownerSources(): Promise<{ corpus: IdentityCorpus; missing: string[] }> {
    const now = Date.now();
    if (this.cachedSources && now - this.cachedSources.loadedAt < this.ttlMs) return this.cachedSources;
    let sources: OwnerSources = { texts: [], missing: [] };
    try {
      sources = this.loadOwnerSources ? await this.loadOwnerSources() : { texts: [await this.loadDocText()], missing: [] };
    } catch (err: any) {
      sources = { texts: [], missing: [err?.message ? String(err.message) : 'owner sources unreadable'] };
    }
    const entry = { corpus: buildIdentityCorpus(sources.texts), missing: sources.missing, loadedAt: now };
    // A partial load is not cached, so the next check retries the missing source.
    if (sources.missing.length === 0) this.cachedSources = entry;
    return entry;
  }

  public async checkIdentity(text: string, runEvidence: readonly string[] = []): Promise<ClaimsCheckResult> {
    const { corpus, missing } = await this.ownerSources();
    const unverified = findUngroundedIdentity(text, corpus, buildIdentityCorpus(runEvidence));
    return identityCheckResult(unverified, missing.length > 0 ? ` (Could not read: ${missing.join(', ')}.)` : '');
  }

  public async checkText(text: string, options: CheckOptions = {}): Promise<ClaimsCheckResult> {
    return this.check(text, options);
  }

  public async check(text: string, options: CheckOptions = {}): Promise<ClaimsCheckResult> {
    let bank: ParsedClaimsBank;
    try {
      bank = await this.bank();
    } catch (err: any) {
      this.cached = undefined;
      return UNAVAILABLE(err?.message ? String(err.message) : 'Claims Bank unreadable');
    }
    const result = checkAgainstBank(bank, text, options);

    // Mandatory humanization / humanizer-pl scanner for drafts written in the owner's name
    if (!options.skipNamedEntities) {
      try {
        const humanScan = scanHumanization(text);
        if (!humanScan.passed) {
          result.flags.push({
            claim: text.slice(0, 80),
            entryId: 'HUMANIZATION_VIOLATION',
            reason: `[${humanScan.language.toUpperCase()}] Humanizer Scanner flagged: ${humanScan.output.slice(0, 150)}`
          });
          if (humanScan.violationsCount >= 1 && result.status === 'OK') {
            result.status = 'NEEDS_PHRASING_CHECK';
            result.message += ` | Humanizer flagged style issues: ${humanScan.output.slice(0, 120)}`;
          }
        }
      } catch (hErr: any) {
        console.warn('[ClaimsBankGuard] Humanizer scan warning:', hErr.message);
      }
    }

    return result;
  }
}
