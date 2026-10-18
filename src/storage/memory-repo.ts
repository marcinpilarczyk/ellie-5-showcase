import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

export interface MemoryFact {
  id: string;
  domain: string;
  category: string;
  statement: string;
  confidence: number;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface PreferenceCandidate {
  id: string;
  scope: string;
  key: string;
  preferred_value: string;
  occurrences: number;
  status: 'candidate' | 'promoted' | 'rejected';
  created_at: string;
  updated_at: string;
}

export type RrsiComponentType = 'preference' | 'memory_fact' | 'skill' | 'routine_rule';
export type RrsiStatus = 'candidate' | 'accepted' | 'rejected' | 'pruned';

export interface RrsiEditRecord {
  id: string;
  component_type: RrsiComponentType;
  target_id: string;
  hypothesis: string;
  diff_text: string;
  delta_score: number;
  delta_cost: number;
  accepted: number;
  status: RrsiStatus;
  trials: number;
  positive_trials: number;
  negative_trials: number;
  created_at: string;
  updated_at: string;
}

export function estimateTokenCost(text: string): number {
  return Math.max(1, Math.ceil((text || '').trim().length / 4));
}

export class MemoryRepository {
  constructor(private readonly db: DatabaseSync) {}

  private hasRrsiTable(): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rrsi_edit_ledger'"
    ).get();
    return Boolean(row);
  }

  public getExecutiveFacts(maxTokenBudget = 1000): MemoryFact[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_facts
      WHERE confidence >= 0.8
      ORDER BY confidence DESC, updated_at DESC
    `);
    const all = stmt.all() as unknown as MemoryFact[];
    const maxChars = maxTokenBudget * 4;
    const result: MemoryFact[] = [];
    let currentChars = 0;
    for (const f of all) {
      const len = f.statement.length;
      if (currentChars + len > maxChars && result.length > 0) {
        break;
      }
      result.push(f);
      currentChars += len;
    }
    return result;
  }

  public listAllFacts(): MemoryFact[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_facts
      ORDER BY domain ASC, created_at DESC
    `);
    return stmt.all() as unknown as MemoryFact[];
  }

  public addFact(statement: string, domain = 'general', category = 'FACT', confidence = 1.0, source = 'owner'): MemoryFact {
    const id = `fact_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO memory_facts (id, domain, category, statement, confidence, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, domain, category, statement, confidence, source, now, now);

    return this.getFact(id)!;
  }

  public getFact(id: string): MemoryFact | null {
    const stmt = this.db.prepare('SELECT * FROM memory_facts WHERE id = ?');
    const res = stmt.get(id);
    return (res ? (res as unknown as MemoryFact) : null);
  }

  public searchFacts(query: string): MemoryFact[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_facts
      WHERE statement LIKE ? OR domain LIKE ?
      ORDER BY domain ASC, confidence DESC
    `);
    const pattern = `%${query}%`;
    return stmt.all(pattern, pattern) as unknown as MemoryFact[];
  }

  public updateFact(id: string, statement: string, domain?: string): boolean {
    const now = new Date().toISOString();
    const existing = this.getFact(id);
    if (!existing) return false;
    const finalDomain = domain || existing.domain;
    const stmt = this.db.prepare(`
      UPDATE memory_facts
      SET statement = ?, domain = ?, updated_at = ?
      WHERE id = ?
    `);
    const res = stmt.run(statement, finalDomain, now, id);
    return res.changes > 0;
  }

  public deleteFact(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM memory_facts WHERE id = ?');
    const res = stmt.run(id);
    return res.changes > 0;
  }

  // --- RRSI Edit & Evidence Ledger (§3.2 / §3.3) ---

  public recordRrsiProposal(params: {
    componentType: RrsiComponentType;
    targetId: string;
    hypothesis: string;
    diffText: string;
    accepted?: boolean;
  }): RrsiEditRecord {
    if (!this.hasRrsiTable()) {
      throw new Error('rrsi_edit_ledger table does not exist');
    }

    const now = new Date().toISOString();
    const deltaCost = estimateTokenCost(params.diffText);
    const existing = this.db.prepare(`
      SELECT * FROM rrsi_edit_ledger
      WHERE component_type = ? AND target_id = ? AND status IN ('candidate', 'accepted')
      ORDER BY updated_at DESC LIMIT 1
    `).get(params.componentType, params.targetId) as unknown as RrsiEditRecord | undefined;

    if (existing) {
      const accepted = params.accepted ? 1 : existing.accepted;
      const status: RrsiStatus = accepted ? 'accepted' : existing.status;
      const newDeltaScore = existing.delta_score + 0.5;
      this.db.prepare(`
        UPDATE rrsi_edit_ledger
        SET diff_text = ?, delta_cost = ?, delta_score = ?, accepted = ?, status = ?,
            trials = trials + 1, positive_trials = positive_trials + 1, updated_at = ?
        WHERE id = ?
      `).run(params.diffText, deltaCost, newDeltaScore, accepted, status, now, existing.id);

      return this.getRrsiById(existing.id)!;
    }

    const id = `rrsi_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const accepted = params.accepted ? 1 : 0;
    const status: RrsiStatus = params.accepted ? 'accepted' : 'candidate';
    const initialScore = params.accepted ? 1.0 : 0.0;

    this.db.prepare(`
      INSERT INTO rrsi_edit_ledger (
        id, component_type, target_id, hypothesis, diff_text,
        delta_score, delta_cost, accepted, status,
        trials, positive_trials, negative_trials, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0, ?, ?)
    `).run(
      id,
      params.componentType,
      params.targetId,
      params.hypothesis,
      params.diffText,
      initialScore,
      deltaCost,
      accepted,
      status,
      now,
      now
    );

    return this.getRrsiById(id)!;
  }

  public getRrsiById(id: string): RrsiEditRecord | null {
    if (!this.hasRrsiTable()) return null;
    const row = this.db.prepare('SELECT * FROM rrsi_edit_ledger WHERE id = ?').get(id);
    return row ? (row as unknown as RrsiEditRecord) : null;
  }

  public getRrsiByTarget(targetId: string): RrsiEditRecord | null {
    if (!this.hasRrsiTable()) return null;
    const row = this.db.prepare(`
      SELECT * FROM rrsi_edit_ledger WHERE target_id = ? ORDER BY updated_at DESC LIMIT 1
    `).get(targetId);
    return row ? (row as unknown as RrsiEditRecord) : null;
  }

  public listRrsiLedger(status?: RrsiStatus, limit = 50): RrsiEditRecord[] {
    if (!this.hasRrsiTable()) return [];
    if (status) {
      return this.db.prepare(`
        SELECT * FROM rrsi_edit_ledger WHERE status = ? ORDER BY updated_at DESC LIMIT ?
      `).all(status, limit) as unknown as RrsiEditRecord[];
    }
    return this.db.prepare(`
      SELECT * FROM rrsi_edit_ledger ORDER BY updated_at DESC LIMIT ?
    `).all(limit) as unknown as RrsiEditRecord[];
  }

  public recordRrsiTrial(targetIdOrQuery: string, deltaScore: number): number {
    if (!this.hasRrsiTable()) return 0;
    const trimmed = (targetIdOrQuery || '').trim();
    if (!trimmed) return 0;

    const pattern = `%${trimmed}%`;
    const rows = this.db.prepare(`
      SELECT * FROM rrsi_edit_ledger
      WHERE status IN ('candidate', 'accepted')
        AND (target_id = ? OR diff_text LIKE ? OR hypothesis LIKE ?)
    `).all(trimmed, pattern, pattern) as unknown as RrsiEditRecord[];

    const now = new Date().toISOString();
    let updatedCount = 0;

    for (const r of rows) {
      const newTrials = r.trials + 1;
      const newPos = r.positive_trials + (deltaScore > 0 ? 1 : 0);
      const newNeg = r.negative_trials + (deltaScore < 0 ? 1 : 0);
      const newScore = r.delta_score + deltaScore;

      let newStatus: RrsiStatus = r.status;
      let newAccepted = r.accepted;
      if (r.status === 'candidate' && (newScore <= -1.0 || (newNeg >= 2 && newPos === 0))) {
        newStatus = 'rejected';
        newAccepted = 0;
      }

      this.db.prepare(`
        UPDATE rrsi_edit_ledger
        SET trials = ?, positive_trials = ?, negative_trials = ?,
            delta_score = ?, status = ?, accepted = ?, updated_at = ?
        WHERE id = ?
      `).run(newTrials, newPos, newNeg, newScore, newStatus, newAccepted, now, r.id);
      updatedCount++;
    }

    return updatedCount;
  }

  // --- Preference Candidates (Graduated Learning) ---

  public recordCandidate(key: string, preferredValue: string, scope = 'global'): PreferenceCandidate {
    const now = new Date().toISOString();
    const findStmt = this.db.prepare(`
      SELECT * FROM preference_candidates WHERE key = ? AND status = 'candidate'
    `);
    const existing = findStmt.get(key) as PreferenceCandidate | undefined;

    if (existing) {
      const occurrences = existing.occurrences + 1;
      const updateStmt = this.db.prepare(`
        UPDATE preference_candidates
        SET preferred_value = ?, occurrences = ?, updated_at = ?
        WHERE id = ?
      `);
      updateStmt.run(preferredValue, occurrences, now, existing.id);

      // Graduated learning: promote upon 3 occurrences
      if (occurrences >= 3) {
        this.promoteCandidate(existing.id);
      }
      const candidate = this.getCandidate(existing.id)!;
      this.recordRrsiProposal({
        componentType: 'preference',
        targetId: candidate.id,
        hypothesis: `Scoped candidate (${candidate.scope || scope}): ${key}`,
        diffText: preferredValue,
        accepted: candidate.status === 'promoted'
      });
      return candidate;
    }

    const id = `pref_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const insertStmt = this.db.prepare(`
      INSERT INTO preference_candidates (id, scope, key, preferred_value, occurrences, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 'candidate', ?, ?)
    `);
    insertStmt.run(id, scope, key, preferredValue, now, now);

    const candidate = this.getCandidate(id)!;
    this.recordRrsiProposal({
      componentType: 'preference',
      targetId: candidate.id,
      hypothesis: `Scoped candidate (${scope}): ${key}`,
      diffText: preferredValue,
      accepted: candidate.status === 'promoted'
    });

    return candidate;
  }

  public listCandidates(): PreferenceCandidate[] {
    const stmt = this.db.prepare(`
      SELECT * FROM preference_candidates
      ORDER BY status ASC, occurrences DESC, updated_at DESC
    `);
    return stmt.all() as unknown as PreferenceCandidate[];
  }

  public getCandidate(id: string): PreferenceCandidate | null {
    const stmt = this.db.prepare('SELECT * FROM preference_candidates WHERE id = ?');
    const res = stmt.get(id);
    return (res ? (res as unknown as PreferenceCandidate) : null);
  }

  public promoteCandidate(id: string): void {
    const candidate = this.getCandidate(id);
    if (!candidate) return;

    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE preference_candidates SET status = 'promoted', updated_at = ? WHERE id = ?
    `).run(now, id);

    if (this.hasRrsiTable()) {
      this.db.prepare(`
        UPDATE rrsi_edit_ledger
        SET accepted = 1, status = 'accepted', delta_score = MAX(delta_score, 1.0), updated_at = ?
        WHERE target_id = ?
      `).run(now, id);
    }

    const factStatement = `Learned preference: ${candidate.key} -> ${candidate.preferred_value}`;
    const allFacts = this.listAllFacts();
    const alreadyExists = allFacts.some(f => f.statement.trim().toLowerCase() === factStatement.trim().toLowerCase());
    if (!alreadyExists) {
      this.addFact(
        factStatement,
        'preferences',
        'PREFERENCE',
        1.0,
        'graduated_learning'
      );
    }
  }

  public recordNegativeEvidence(keyOrQuery: string): number {
    const trimmed = (keyOrQuery || '').trim();
    if (!trimmed) return 0;
    const pattern = `%${trimmed}%`;
    const candidates = this.db.prepare(`
      SELECT * FROM preference_candidates
      WHERE status = 'candidate' AND (key LIKE ? OR preferred_value LIKE ? OR scope LIKE ?)
    `).all(pattern, pattern, pattern) as unknown as PreferenceCandidate[];

    let updatedCount = 0;
    const now = new Date().toISOString();

    for (const c of candidates) {
      const newOccurrences = c.occurrences - 1;
      if (newOccurrences <= 0) {
        this.db.prepare(`
          UPDATE preference_candidates
          SET occurrences = ?, status = 'rejected', updated_at = ?
          WHERE id = ?
        `).run(newOccurrences, now, c.id);
      } else {
        this.db.prepare(`
          UPDATE preference_candidates
          SET occurrences = ?, updated_at = ?
          WHERE id = ?
        `).run(newOccurrences, now, c.id);
      }
      updatedCount++;
    }

    // In addition to decrementing preference_candidates.occurrences, call this.recordRrsiTrial(keyOrQuery, -1.0).
    const rrsiUpdated = this.recordRrsiTrial(trimmed, -1.0);

    return Math.max(updatedCount, rrsiUpdated);
  }

  public pruneStaleCandidates(maxAgeDays = 30): number {
    const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const cutoffIso = new Date(cutoffMs).toISOString();
    const now = new Date().toISOString();

    const deleteStmt = this.db.prepare(`
      DELETE FROM preference_candidates
      WHERE (status = 'rejected' OR (status = 'candidate' AND occurrences <= 1)) AND updated_at <= ?
    `);
    const deleteRes = deleteStmt.run(cutoffIso);
    let totalPruned = Number(deleteRes.changes);

    // Lasso (L1) structural pruning on rrsi_edit_ledger: prune unproductive rules with trials >= 3 and delta_score < 0
    if (this.hasRrsiTable()) {
      const unproductive = this.db.prepare(`
        SELECT * FROM rrsi_edit_ledger
        WHERE status IN ('candidate', 'accepted') AND trials >= 3 AND delta_score < 0
      `).all() as unknown as RrsiEditRecord[];

      for (const entry of unproductive) {
        this.db.prepare(`
          UPDATE rrsi_edit_ledger SET status = 'pruned', accepted = 0, updated_at = ? WHERE id = ?
        `).run(now, entry.id);
        totalPruned++;

        // Demote non-owner learned facts so they drop out of getExecutiveFacts (confidence >= 0.8)
        if (entry.component_type === 'memory_fact') {
          this.db.prepare(`
            UPDATE memory_facts
            SET confidence = 0.5, updated_at = ?
            WHERE id = ? AND source IN ('correction', 'graduated_learning')
          `).run(now, entry.target_id);
        } else if (entry.component_type === 'preference') {
          this.db.prepare(`
            UPDATE memory_facts
            SET confidence = 0.5, updated_at = ?
            WHERE source IN ('correction', 'graduated_learning') AND statement LIKE ?
          `).run(now, `%${entry.diff_text}%`);
        }
      }
    }

    // Deduplicate exact-match case-insensitive statements in memory_facts
    const facts = this.db.prepare(`
      SELECT * FROM memory_facts ORDER BY updated_at DESC
    `).all() as unknown as MemoryFact[];

    const seenStatements = new Set<string>();
    for (const f of facts) {
      const normalized = f.statement.trim().toLowerCase();
      if (seenStatements.has(normalized)) {
        this.db.prepare('DELETE FROM memory_facts WHERE id = ?').run(f.id);
        totalPruned++;
      } else {
        seenStatements.add(normalized);
      }
    }

    return totalPruned;
  }

  public searchCandidates(query: string): PreferenceCandidate[] {
    const stmt = this.db.prepare(`
      SELECT * FROM preference_candidates
      WHERE key LIKE ? OR preferred_value LIKE ?
      ORDER BY occurrences DESC, updated_at DESC
    `);
    const pattern = `%${query}%`;
    return stmt.all(pattern, pattern) as unknown as PreferenceCandidate[];
  }

  public updateCandidate(id: string, preferredValue: string): boolean {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE preference_candidates
      SET preferred_value = ?, updated_at = ?
      WHERE id = ?
    `);
    const res = stmt.run(preferredValue, now, id);
    return res.changes > 0;
  }

  public deleteCandidate(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM preference_candidates WHERE id = ?');
    const res = stmt.run(id);
    return res.changes > 0;
  }
}
