import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataDir } from '../storage/database.js';

// P12: owner data lives in config, never in src/. `npm run doctor` reports what is missing.
export const OWNER_NAME = process.env.ELLIE_OWNER_NAME?.trim() || 'the owner';
export const OWNER_FULL_NAME = process.env.ELLIE_OWNER_FULL_NAME?.trim() || OWNER_NAME;
export const OWNER_ACTOR = process.env.ELLIE_OWNER_ACTOR?.trim() || 'owner';

/** Owner files (e.g. never-claims.json): ELLIE_PRIVATE_DIR, defaulting to <data dir>/private. */
export function privateDir(): string {
  return path.resolve(process.env.ELLIE_PRIVATE_DIR?.trim() || path.join(dataDir(), 'private'));
}

export function readPrivateJson<T>(fileName: string): T | undefined {
  const file = path.join(privateDir(), fileName);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export interface MeetingWindow {
  startMinute: number;
  endMinute: number;
}

export interface MeetingException {
  weekday: number;
  minute: number;
  titleContains: string;
}

export interface OwnerConfig {
  about: string;
  searchPhilosophy: string;
  pay: string;
  targetRoles: string[];
  eligibleWork: string[];
  dealBreakers: string[];
  neverResurface: string[];
  meetingWindows: MeetingWindow[];
  meetingExceptions: MeetingException[];
  rules: string[];
  professionalRecord: string;
}

export const DEFAULT_MEETING_WINDOWS: readonly MeetingWindow[] = [{ startMinute: 9 * 60, endMinute: 17 * 60 }];

export const EMPTY_OWNER_CONFIG: OwnerConfig = {
  about: '',
  searchPhilosophy: '',
  pay: '',
  targetRoles: [],
  eligibleWork: [],
  dealBreakers: [],
  neverResurface: [],
  meetingWindows: [...DEFAULT_MEETING_WINDOWS],
  meetingExceptions: [],
  rules: [],
  professionalRecord: ''
};

type SectionKey = 'about' | 'searchPhilosophy' | 'pay' | 'targetRoles' | 'eligibleWork' | 'dealBreakers' | 'neverResurface' | 'meetingWindows' | 'meetingExceptions' | 'rules';

const SECTION_TITLES: Record<string, SectionKey> = {
  'about': 'about',
  'search philosophy': 'searchPhilosophy',
  'pay': 'pay',
  'target roles': 'targetRoles',
  'eligible work': 'eligibleWork',
  'deal-breakers': 'dealBreakers',
  'dealbreakers': 'dealBreakers',
  'deal breakers': 'dealBreakers',
  'never resurface': 'neverResurface',
  'meeting windows': 'meetingWindows',
  'meeting exceptions': 'meetingExceptions',
  'rules': 'rules',
  'preferences': 'rules',
  'owner rules': 'rules',
  'owner preferences': 'rules',
  'guidelines': 'rules',
  'style rules': 'rules',
  'style': 'rules',
  'tone': 'rules',
  'communication': 'rules',
  'communication preferences': 'rules'
};

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function clock(h: string, m: string): number | null {
  const hour = parseInt(h, 10);
  const minute = parseInt(m, 10);
  return hour <= 24 && minute <= 59 ? hour * 60 + minute : null;
}

export function parseOwnerConfig(docText: string, professionalRecord = ''): OwnerConfig {
  const sections = new Map<SectionKey, string[]>();
  let currentKey: SectionKey | null = null;

  for (const raw of (docText ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, '$1').trim();
    if (!line) continue;
    const title = line.replace(/^#+\s*/, '').replace(/:$/, '').trim().toLowerCase();
    if (SECTION_TITLES[title]) {
      currentKey = SECTION_TITLES[title];
      if (!sections.has(currentKey)) {
        sections.set(currentKey, []);
      }
      continue;
    } else if (/^#+\s+/.test(line)) {
      currentKey = 'rules';
      if (!sections.has(currentKey)) {
        sections.set(currentKey, []);
      }
      continue;
    }
    if (currentKey) {
      sections.get(currentKey)!.push(line.replace(/^[-*•]\s+/, ''));
    } else if (/^[-*•]\s+/.test(line)) {
      if (!sections.has('rules')) sections.set('rules', []);
      sections.get('rules')!.push(line.replace(/^[-*•]\s+/, ''));
    }
  }

  const text = (key: SectionKey) => (sections.get(key) ?? []).join('\n');
  const list = (key: SectionKey) => sections.get(key) ?? [];

  const meetingWindows: MeetingWindow[] = [];
  for (const item of list('meetingWindows')) {
    const m = item.match(/(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})/);
    const start = m && clock(m[1], m[2]);
    const end = m && clock(m[3], m[4]);
    if (start !== null && end !== null && start < end) meetingWindows.push({ startMinute: start, endMinute: end });
  }

  const meetingExceptions: MeetingException[] = [];
  for (const item of list('meetingExceptions')) {
    const m = item.match(/^([A-Za-z]{3})[a-z]*\s+(\d{1,2}):(\d{2})\s+(.+)$/);
    const weekday = m ? WEEKDAYS.indexOf(m[1].toLowerCase()) : -1;
    const minute = m && clock(m[2], m[3]);
    if (m && weekday >= 0 && minute !== null) meetingExceptions.push({ weekday, minute, titleContains: m[4].trim().toLowerCase() });
  }

  return {
    about: text('about'),
    searchPhilosophy: text('searchPhilosophy'),
    pay: text('pay'),
    targetRoles: list('targetRoles'),
    eligibleWork: list('eligibleWork'),
    dealBreakers: list('dealBreakers'),
    neverResurface: list('neverResurface'),
    meetingWindows: meetingWindows.length > 0 ? meetingWindows : [...DEFAULT_MEETING_WINDOWS],
    meetingExceptions,
    rules: list('rules'),
    professionalRecord: professionalRecord.trim()
  };
}

let activeConfig: OwnerConfig = EMPTY_OWNER_CONFIG;
let onReadHook: (() => void) | undefined;

export function ownerConfig(): OwnerConfig {
  onReadHook?.();
  return activeConfig;
}

export function setOwnerConfig(config: Partial<OwnerConfig>): void {
  activeConfig = { ...EMPTY_OWNER_CONFIG, ...config };
}

export function ownerIntro(): string {
  const cfg = ownerConfig();
  const parts: string[] = [];

  const about = cfg.about ? `${OWNER_FULL_NAME}. ${cfg.about}` : OWNER_FULL_NAME;
  parts.push(about);

  if (cfg.targetRoles && cfg.targetRoles.length > 0) {
    parts.push(`Target Roles: ${cfg.targetRoles.join(', ')}`);
  }
  if (cfg.eligibleWork && cfg.eligibleWork.length > 0) {
    parts.push(`Eligible Work: ${cfg.eligibleWork.join(', ')}`);
  }
  if (cfg.dealBreakers && cfg.dealBreakers.length > 0) {
    parts.push(`Deal Breakers: ${cfg.dealBreakers.join(', ')}`);
  }
  if (cfg.searchPhilosophy) {
    parts.push(`Search Philosophy: ${cfg.searchPhilosophy}`);
  }
  if (cfg.pay) {
    parts.push(`Pay / Compensation: ${cfg.pay}`);
  }
  if (cfg.neverResurface && cfg.neverResurface.length > 0) {
    parts.push(`Never Resurface: ${cfg.neverResurface.join(', ')}`);
  }
  if (cfg.rules && cfg.rules.length > 0) {
    parts.push(`Owner Rules & Preferences:\n${cfg.rules.map(r => `• ${r}`).join('\n')}`);
  }
  if (cfg.professionalRecord) {
    parts.push(`\nVERIFIED PROFESSIONAL RECORD OF ${OWNER_FULL_NAME.toUpperCase()}:\n${cfg.professionalRecord}`);
  }

  return parts.join('\n');
}

export class OwnerConfigLoader {
  private inFlight?: Promise<void>;
  private refreshedAt = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly readDoc?: (documentId: string) => Promise<string>,
    private readonly configDocId = process.env.ELLIE_OWNER_CONFIG_DOC_ID?.trim(),
    private readonly profRecordDocId = process.env.ELLIE_PROFESSIONAL_RECORD_DOC_ID?.trim(),
    private readonly ttlMs = 10 * 60 * 1000
  ) {
    if (!configDocId && !profRecordDocId) return;
    this.apply();
    if (!this.cached(this.configDocId) || !this.cached(this.profRecordDocId)) {
      this.refresh().catch(() => {});
    }
    onReadHook = () => this.refreshIfStale();
  }

  public detach(): void {
    onReadHook = undefined;
  }

  public refreshIfStale(): void {
    if (Date.now() - this.refreshedAt < this.ttlMs || this.inFlight) return;
    this.refresh().catch(() => {});
  }

  public async refresh(): Promise<void> {
    const readDoc = this.readDoc;
    if (!readDoc || (!this.configDocId && !this.profRecordDocId)) return;
    if (this.inFlight) return this.inFlight;
    this.refreshedAt = Date.now();

    this.inFlight = (async () => {
      for (const id of [this.configDocId, this.profRecordDocId]) {
        if (!id) continue;
        try {
          const text = await readDoc(id);
          if (text.trim()) {
            this.db.prepare(`
              INSERT INTO owner_config_cache (doc_id, text, loaded_at) VALUES (?, ?, ?)
              ON CONFLICT(doc_id) DO UPDATE SET text = excluded.text, loaded_at = excluded.loaded_at
            `).run(id, text, new Date().toISOString());
          }
        } catch (err: any) {
          console.warn(`[OwnerConfigLoader] Could not read Doc ${id}: ${err.message}`);
        }
      }
      this.apply();
    })().finally(() => {
      this.inFlight = undefined;
    });

    return this.inFlight;
  }

  private cached(id?: string): string {
    if (!id) return '';
    const row = this.db.prepare('SELECT text FROM owner_config_cache WHERE doc_id = ?').get(id) as { text: string } | undefined;
    return row?.text ?? '';
  }

  public apply(): void {
    setOwnerConfig(parseOwnerConfig(this.cached(this.configDocId), this.cached(this.profRecordDocId)));
  }

  public getConfig(): OwnerConfig {
    return ownerConfig();
  }

  public getRawConfigDoc(): string {
    return this.cached(this.configDocId);
  }

  public getRawProfessionalRecord(): string {
    return this.cached(this.profRecordDocId);
  }
}
