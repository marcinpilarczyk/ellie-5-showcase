import { z } from 'zod';
import { ToolDefinition } from '../types/tool.js';
import { OWNER_NAME } from '../config/owner.js';

/**
 * The owner's working Docs, discovered at runtime: the loose Google Docs in the owner's folder (the folder
 * that holds the config Doc) and everything under its Projects folder, plus Docs the deployment already links by role
 * (record, Claims Bank). No Doc names, IDs or purposes live in code: the owner adds, renames and
 * edits Docs without a deploy.
 */
export interface OwnerDoc {
  id: string;
  title: string;
  path: string;
  modifiedTime?: string;
}

export interface OwnerSourceDeps {
  /** The owner's folder, or undefined when it cannot be found. */
  folderId: () => Promise<string | undefined>;
  listDocs: (folderId: string) => Promise<OwnerDoc[]>;
  readDoc: (documentId: string) => Promise<string>;
  /** Docs outside the folder that the deployment links by role (record, Claims Bank). */
  linkedDocIds: () => string[];
}

interface Snapshot {
  docs: Array<OwnerDoc & { text?: string }>;
  missing: string[];
  loadedAt: number;
}

const PREVIEW_CHARS = 300;

import { DatabaseSync } from 'node:sqlite';

/** Folder layout, not content: besides its loose Docs, only this subfolder of the owner folder holds working Docs. */
export const OWNER_PROJECTS_FOLDER = 'Projects';

export class OwnerSources {
  private cached?: Snapshot;
  private cachedUntil = 0;

  constructor(
    private readonly deps: OwnerSourceDeps,
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly db?: DatabaseSync
  ) {}

  private async snapshot(force = false): Promise<Snapshot> {
    const now = Date.now();
    if (!force && this.cached && now < this.cachedUntil) return this.cached;

    const missing: string[] = [];
    let docs: OwnerDoc[] = [];
    try {
      const folderId = await this.deps.folderId();
      if (folderId) docs = await this.deps.listDocs(folderId);
      else missing.push(`${OWNER_NAME}'s folder (the config Doc is not set or has no folder)`);
    } catch (err: any) {
      missing.push(`${OWNER_NAME}'s folder (${err?.message ?? 'unreadable'})`);
    }
    for (const id of this.deps.linkedDocIds()) {
      if (!docs.some(d => d.id === id)) docs.push({ id, title: id, path: '(linked)' });
    }

    // Load cached SQLite docs if DB is available
    const dbCache = new Map<string, { title: string; path: string; modified_time: string | null; content: string }>();
    if (this.db) {
      try {
        const rows = this.db.prepare('SELECT doc_id, title, path, modified_time, content FROM owner_doc_cache').all() as any[];
        for (const r of rows) {
          dbCache.set(r.doc_id, {
            title: r.title,
            path: r.path,
            modified_time: r.modified_time,
            content: r.content
          });
        }
      } catch {}
    }

    const upsertStmt = this.db
      ? this.db.prepare(`
          INSERT INTO owner_doc_cache (doc_id, title, path, modified_time, content, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(doc_id) DO UPDATE SET
            title = excluded.title,
            path = excluded.path,
            modified_time = excluded.modified_time,
            content = excluded.content,
            updated_at = excluded.updated_at
        `)
      : null;

    const read = await Promise.all(docs.map(async (d): Promise<OwnerDoc & { text?: string }> => {
      const cached = dbCache.get(d.id);
      // If modifiedTime matches cached record, reuse content without Google Docs API call
      if (cached && d.modifiedTime && cached.modified_time === d.modifiedTime && cached.content) {
        return { ...d, text: cached.content };
      }

      try {
        const text = await this.deps.readDoc(d.id);
        if (upsertStmt && text !== undefined) {
          try {
            upsertStmt.run(d.id, d.title, d.path || '', d.modifiedTime ?? null, text, new Date().toISOString());
          } catch {}
        }
        return { ...d, text };
      } catch (err: any) {
        // Fall back to cached content if readDoc fails
        if (cached?.content) {
          return { ...d, text: cached.content };
        }
        missing.push(d.title);
        return { ...d };
      }
    }));
    // Linked Docs carry their first line as the title, since their name is not listed.
    for (const d of read) if (d.title === d.id && d.text) d.title = d.text.split('\n')[0].slice(0, 80) || d.id;

    const snap = { docs: read, missing, loadedAt: now };
    if (read.some(d => d.text !== undefined) || docs.length === 0) {
      this.cached = snap;
      this.cachedUntil = now + (missing.length === 0 ? this.ttlMs : Math.min(this.ttlMs, 60_000));
    }
    return snap;
  }

  /** Every readable Doc with its text, for the nightly inventory. */
  public async documents(): Promise<{ docs: Array<OwnerDoc & { text: string }>; missing: string[] }> {
    const snap = await this.snapshot();
    return { docs: snap.docs.filter((d): d is OwnerDoc & { text: string } => d.text !== undefined), missing: snap.missing };
  }

  /** Every readable Doc's text, for the claims guard. */
  public async allTexts(): Promise<{ texts: string[]; missing: string[] }> {
    const snap = await this.snapshot();
    return { texts: snap.docs.map(d => d.text).filter((t): t is string => Boolean(t)), missing: snap.missing };
  }

  public async index() {
    const snap = await this.snapshot();
    return {
      docs: snap.docs.filter(d => d.text !== undefined).map(d => ({
        title: d.title,
        folder: d.path || '/',
        modified: d.modifiedTime,
        chars: d.text!.length,
        preview: d.text!.slice(0, PREVIEW_CHARS)
      })),
      missing: snap.missing.length > 0 ? snap.missing : undefined
    };
  }

  /** Full text of the Docs whose title (or ID) matches each selector, case-insensitively. */
  public async read(selectors: string[]) {
    const snap = await this.snapshot();
    const picked = new Map<string, { title: string; text: string }>();
    const notFound: string[] = [];
    for (const sel of selectors) {
      const s = sel.trim().toLowerCase();
      const hits = snap.docs.filter(d => d.text !== undefined && (d.id.toLowerCase() === s || d.title.toLowerCase().includes(s)));
      if (hits.length === 0) notFound.push(sel);
      for (const d of hits) picked.set(d.id, { title: d.title, text: d.text! });
    }
    return { docs: [...picked.values()], notFound: notFound.length > 0 ? notFound : undefined };
  }
}

export function createOwnerSourceTools(sources: OwnerSources): ToolDefinition[] {
  return [{
    name: 'owner_sources_read',
    description: `${OWNER_NAME}'s own working Docs (profile, career record, Claims Bank, writing rules and whatever else ${OWNER_NAME} keeps there). ` +
      `Your instructions list them (the working-Docs inventory): call with docs (titles or parts of titles) to read those in full. Call without docs only if a Doc you need is not in the inventory; that lists them live (title, folder, preview). ` +
      `Before writing anything in ${OWNER_NAME}'s name (resume, cover letter, bio, outreach), read the Docs that hold the facts, contact details and writing rules for it; drafts and documents are refused until you have.`,
    effectClass: 'READ',
    // Only reading Docs in full counts; listing them does not.
    providesOwnerSources: (params: { docs?: string[] }) => (params.docs?.length ?? 0) > 0,
    keepsFullResult: true,
    schema: z.object({
      docs: z.array(z.string()).optional().describe('Titles (or parts of titles) of Docs to read in full; omit to list them')
    }),
    execute: async (params: { docs?: string[] }) => {
      if (!params.docs || params.docs.length === 0) return sources.index();
      const result = await sources.read(params.docs);
      return {
        ...result,
        howToUse: `Use only facts, contact details and claims these Docs support, and follow any writing rules in them. Leave out what they do not support rather than inventing it.`
      };
    }
  }];
}
