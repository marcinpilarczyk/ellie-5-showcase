import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

export interface StoredResultRecord {
  handle: string;
  run_id: string;
  tool_name: string;
  content: string;
  preview: string;
  size_bytes: number;
  created_at: string;
  /** 1 when the result repeats Ellie's own text (see ToolDefinition.notEvidence). */
  not_evidence?: number;
}

/** Whether a stored result may ground claims in owner text. */
export interface StoreOptions {
  notEvidence?: boolean;
}

export interface StoredResultSummary {
  isStored: boolean;
  handle?: string;
  preview?: string;
  toolName?: string;
  totalChars?: number;
  message?: string;
  raw?: any;
}

/** ~1.5k tokens. Larger results go to the store and the model gets a preview plus a handle. */
export const RESULT_STORE_THRESHOLD = 6000;
/** Head of a stored result shown inline: enough to answer from for most pages, always below the threshold. */
export const RESULT_PREVIEW_CHARS = 4000;
/** Upper bound for one result_read slice, and what a read with only a handle returns (the whole result when it fits).
 * Readers are never stored again, so this caps what they add to the prompt. */
export const MAX_SLICE_CHARS = 12000;
/** Tools that read the store. Their output must not be intercepted (that produced handles pointing at handles). */
export const RESULT_READER_TOOLS = new Set(['result_read', 'sheet_query']);
/** Self-diagnosis and check tools whose output is not factual external evidence and should not be carried over across turns. */
export const NON_EVIDENCE_TOOLS = new Set([
  'trace_inspect_recent',
  'trace_inspect_run',
  'repo_status',
  'repo_search',
  'repo_list_and_search',
  'repo_read_file',
  'vps_inspect',
  'owner_text_check',
  'memory_list_candidates'
]);

/**
 * Text view of a stored result for preview and result_read. Stored content stays JSON (sheet_query
 * parses it), but JSON puts a page of text on one escaped line, so line and query reads found nothing.
 * Here keys become "key: value" lines and multi-line strings keep their real line breaks.
 */
export function readableText(stored: string): string {
  let parsed: any;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return stored;
  }
  return typeof parsed === 'string' ? parsed : renderReadable(parsed, '').replace(/^\n/, '');
}

/** Block values (multi-line text, objects, long arrays) start with a newline; scalars do not. */
function renderReadable(value: any, indent: string): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value.includes('\n') ? `\n${value}` : value;
  if (typeof value !== 'object') return String(value);
  const join = (label: string, v: any) => {
    const rendered = renderReadable(v, indent + '  ');
    return `${indent}${label}${rendered.startsWith('\n') ? '' : ' '}${rendered}`;
  };
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const inline = JSON.stringify(value);
    if (value.every(v => v === null || typeof v !== 'object') && inline.length <= 200 && !inline.includes('\\n')) return inline;
    return '\n' + value.map(v => join('-', v)).join('\n');
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return '{}';
  return '\n' + keys.map(k => join(`${k}:`, value[k])).join('\n');
}

function cleanNumericString(val: any): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'number') return Number.isFinite(val) ? String(val) : '';
  let str = String(val).trim();
  if (!str) return '';

  let isNegativeParen = false;
  if (/^\(.*\)$/.test(str)) {
    isNegativeParen = true;
    str = str.slice(1, -1).trim();
  }

  const cleaned = str
    .replace(/[$€£¥]/g, '')
    .replace(/\b(eur|usd|gbp|cad|aud)\b/gi, '')
    .replace(/,/g, '')
    .trim();

  if (isNegativeParen && cleaned) {
    return `-${cleaned}`;
  }
  return cleaned;
}

function isNumericValue(val: any): boolean {
  const cleaned = cleanNumericString(val);
  if (!cleaned || cleaned === '-' || cleaned === '.' || cleaned === 'null' || cleaned === 'undefined') {
    return false;
  }
  const n = Number(cleaned);
  return Number.isFinite(n);
}

function parseNumericValue(val: any): number | null {
  const cleaned = cleanNumericString(val);
  if (!cleaned || cleaned === '-' || cleaned === '.' || cleaned === 'null' || cleaned === 'undefined') {
    return null;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export class ResultStore {
  constructor(private readonly db: DatabaseSync) {}

  public intercept(runId: string, toolName: string, output: any, opts?: StoreOptions): StoredResultSummary {
    const serialized = typeof output === 'string' ? output : JSON.stringify(output, null, 2);

    if (serialized.length <= RESULT_STORE_THRESHOLD) {
      return { isStored: false, raw: output };
    }
    return this.store(runId, toolName, output, serialized, opts);
  }

  /** Stores a result whatever its size, so a later run can reopen it by handle (thread carryover). */
  public keep(runId: string, toolName: string, output: any, opts?: StoreOptions): string {
    const serialized = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
    return this.store(runId, toolName, output, serialized, opts).handle!;
  }

  private store(runId: string, toolName: string, output: any, serialized: string, opts?: StoreOptions): StoredResultSummary {
    const handle = `res_${toolName}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const sizeBytes = Buffer.byteLength(serialized, 'utf8');

    // Generate intelligent preview
    let previewHeader = '';
    if (typeof output === 'object' && output !== null) {
      if (Array.isArray(output)) {
        previewHeader = `[Array of ${output.length} items. First item: ${JSON.stringify(output[0]).slice(0, 150)}...]`;
      } else if (Array.isArray(output.values)) {
        previewHeader = `[Sheet table with ${output.values.length} rows. Headers: ${JSON.stringify(output.values[0])}]`;
      } else {
        const keys = Object.keys(output);
        previewHeader = `[Object with keys: ${keys.slice(0, 10).join(', ')}]`;
      }
    }

    // Preview, totalChars and result_read offsets all refer to the same readable text
    const text = readableText(serialized);
    const preview = `${previewHeader}\n${text.slice(0, RESULT_PREVIEW_CHARS)}... [${Math.max(0, text.length - RESULT_PREVIEW_CHARS)} more characters stored under handle '${handle}']`;

    const stmt = this.db.prepare(`
      INSERT INTO tool_results (handle, run_id, tool_name, content, preview, size_bytes, not_evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(handle, runId, toolName, serialized, preview, sizeBytes, opts?.notEvidence ? 1 : 0);

    return {
      isStored: true,
      handle,
      preview,
      toolName,
      totalChars: text.length,
      message: `Tool result exceeded ${RESULT_STORE_THRESHOLD} chars and was saved to the Result Store; the preview holds the first ${RESULT_PREVIEW_CHARS}. If you need more, call 'result_read' with only handle '${handle}' (it returns the whole result up to ${MAX_SLICE_CHARS} chars in one call), a query for one section, or 'sheet_query' for tabular data.`
    };
  }

  public get(handle: string): StoredResultRecord | null {
    const stmt = this.db.prepare('SELECT * FROM tool_results WHERE handle = ?');
    const res = stmt.get(handle);
    return (res ? (res as unknown as StoredResultRecord) : null);
  }

  /** False when the stored result repeats Ellie's own text, or the handle is unknown. */
  public isEvidence(handle: string): boolean {
    const row = this.db.prepare('SELECT not_evidence FROM tool_results WHERE handle = ?').get(handle) as { not_evidence: number } | undefined;
    return Boolean(row) && row!.not_evidence !== 1;
  }

  public readSlice(handle: string, opts?: { offset?: number; maxChars?: number; startLine?: number; endLine?: number; query?: string }): {
    handle: string;
    totalChars: number;
    totalLines: number;
    slice: string;
    /** Characters after this slice; 0 means the reader has everything from its offset on. */
    remainingChars?: number;
  } {
    const record = this.get(handle);
    if (!record) throw new Error(`Stored result with handle '${handle}' not found.`);

    const text = readableText(record.content);
    const lines = text.split('\n');
    const totalLines = lines.length;
    const totalChars = text.length;

    if (opts?.query) {
      const q = opts.query.toLowerCase();
      const matchingLines: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          const start = Math.max(0, i - 2);
          const end = Math.min(lines.length, i + 3);
          matchingLines.push(`--- Line ${i + 1} match ---`);
          matchingLines.push(...lines.slice(start, end));
        }
      }
      const slice = matchingLines.length > 0
        ? matchingLines.join('\n')
        : `No lines matching query "${opts.query}" found.`;
      return { handle, totalChars, totalLines, slice: slice.slice(0, MAX_SLICE_CHARS) };
    }

    if (opts?.startLine !== undefined || opts?.endLine !== undefined) {
      const start = Math.max(1, opts?.startLine || 1) - 1;
      const end = Math.min(totalLines, opts?.endLine || totalLines);
      const slice = lines.slice(start, end).join('\n').slice(0, MAX_SLICE_CHARS);
      return { handle, totalChars, totalLines, slice };
    }

    // No range: one call returns everything that fits, so nobody pages through a result in small slices
    const offset = Math.max(0, opts?.offset || 0);
    const maxChars = Math.min(opts?.maxChars || MAX_SLICE_CHARS, MAX_SLICE_CHARS);
    const slice = text.slice(offset, offset + maxChars);

    return { handle, totalChars, totalLines, slice, remainingChars: Math.max(0, totalChars - offset - slice.length) };
  }

  public querySheet(handle: string, opts?: {
    filterColumn?: string;
    filterValue?: string;
    selectColumns?: string[];
    limit?: number;
  }): {
    handle: string;
    totalRows: number;
    matchedRows: number;
    headers: string[];
    rows: any[];
  } {
    const record = this.get(handle);
    if (!record) throw new Error(`Stored sheet with handle '${handle}' not found.`);

    let parsed: any;
    try {
      parsed = JSON.parse(record.content);
    } catch {
      throw new Error(`Content under handle '${handle}' is not valid JSON.`);
    }

    let rows: any[] = [];
    let headers: string[] = [];

    if (Array.isArray(parsed)) {
      if (parsed.length > 0 && typeof parsed[0] === 'object') {
        headers = Object.keys(parsed[0]);
        rows = parsed;
      }
    } else if (Array.isArray(parsed.values)) {
      if (parsed.values.length > 0) {
        headers = parsed.values[0].map(String);
        for (let i = 1; i < parsed.values.length; i++) {
          const rowObj: Record<string, any> = {};
          headers.forEach((h, colIdx) => {
            rowObj[h] = parsed.values[i][colIdx] ?? '';
          });
          rows.push(rowObj);
        }
      }
    } else if (Array.isArray(parsed.rows)) {
      rows = parsed.rows;
      if (rows.length > 0) headers = Object.keys(rows[0]);
    } else if (parsed && Array.isArray(parsed.sheets) && parsed.sheets.length > 0) {
      const firstSheet = parsed.sheets[0];
      if (firstSheet.rows && firstSheet.rows.length > 0) {
        headers = firstSheet.rows[0].map(String);
        for (let i = 1; i < firstSheet.rows.length; i++) {
          const rowObj: Record<string, any> = {};
          headers.forEach((h: string, colIdx: number) => {
            rowObj[h] = firstSheet.rows[i][colIdx] ?? '';
          });
          rows.push(rowObj);
        }
      }
    }

    const totalRows = rows.length;
    let filtered = rows;

    if (opts?.filterColumn && opts?.filterValue !== undefined) {
      const col = opts.filterColumn.toLowerCase();
      const val = opts.filterValue.toLowerCase();
      filtered = filtered.filter(r => {
        const cell = String(r[opts.filterColumn!] ?? '').toLowerCase();
        return cell.includes(val);
      });
    }

    if (opts?.selectColumns && opts.selectColumns.length > 0) {
      const cols = opts.selectColumns;
      filtered = filtered.map(r => {
        const proj: Record<string, any> = {};
        for (const c of cols) proj[c] = r[c] ?? '';
        return proj;
      });
    }

    const limit = opts?.limit || 20;
    const sliced = filtered.slice(0, limit);

    return {
      handle,
      totalRows,
      matchedRows: filtered.length,
      headers: opts?.selectColumns || headers,
      rows: sliced
    };
  }

  /**
   * Executes an ephemeral, read-only SQL query against an in-memory SQLite database
   * containing all sheets as tables.
   */
  public queryTabularSql(handle: string, sql: string): any[] {
    const record = this.get(handle);
    if (!record) {
      throw new Error(`Stored result with handle '${handle}' not found.`);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(record.content);
    } catch {
      throw new Error(`Content under handle '${handle}' is not valid JSON.`);
    }

    // Guard against write queries: reject if sql does not start with SELECT, WITH, or EXPLAIN
    const trimmedSql = sql.trim().replace(/^(--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/g, '').trim();
    if (!/^(SELECT|WITH|EXPLAIN)\b/i.test(trimmedSql)) {
      throw new Error('Only read-only SQL queries (SELECT, WITH, EXPLAIN) are allowed.');
    }

    let sheets: Array<{ name: string; rows: string[][] }> = [];
    if (parsed && Array.isArray(parsed.sheets)) {
      sheets = parsed.sheets;
    } else if (Array.isArray(parsed)) {
      if (parsed.length > 0 && typeof parsed[0] === 'object' && 'name' in parsed[0] && 'rows' in parsed[0]) {
        sheets = parsed;
      } else if (parsed.length > 0 && typeof parsed[0] === 'object') {
        const headers = Object.keys(parsed[0]);
        const rows = [headers, ...parsed.map(obj => headers.map(h => String(obj[h] ?? '')))];
        sheets = [{ name: 'sheet1', rows }];
      }
    } else if (parsed && Array.isArray(parsed.values)) {
      sheets = [{ name: 'sheet1', rows: parsed.values.map((r: any[]) => (Array.isArray(r) ? r.map(c => String(c ?? '')) : [String(r ?? '')])) }];
    } else if (parsed && Array.isArray(parsed.rows)) {
      if (parsed.rows.length > 0 && typeof parsed.rows[0] === 'object') {
        const headers = Object.keys(parsed.rows[0]);
        const rows = [headers, ...parsed.rows.map((obj: any) => headers.map((h: string) => String(obj[h] ?? '')))];
        sheets = [{ name: 'sheet1', rows }];
      }
    }

    if (sheets.length === 0) {
      throw new Error(`Stored result under handle '${handle}' does not contain tabular sheets or rows.`);
    }

    let memDb: DatabaseSync | null = null;
    try {
      memDb = new DatabaseSync(':memory:');
      const usedTableNames = new Set<string>();

      for (let sIdx = 0; sIdx < sheets.length; sIdx++) {
        const sheet = sheets[sIdx];
        let rawTableName = (sheet.name || '')
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, '_')
          .replace(/^_+|_+$/g, '');
        if (!rawTableName || /^[0-9]/.test(rawTableName)) {
          rawTableName = `sheet_${sIdx + 1}${rawTableName ? '_' + rawTableName : ''}`;
        }
        let tableName = rawTableName;
        let counter = 1;
        while (usedTableNames.has(tableName)) {
          tableName = `${rawTableName}_${counter++}`;
        }
        usedTableNames.add(tableName);

        const rows = sheet.rows || [];
        if (rows.length === 0) {
          memDb.exec(`CREATE TABLE "${tableName}" (empty_sheet TEXT);`);
          continue;
        }

        const headerRow = rows[0] || [];
        const dataRows = rows.slice(1);
        const maxCols = Math.max(headerRow.length, ...dataRows.map(r => r.length));

        const colNames: string[] = [];
        const usedColNames = new Set<string>();

        for (let cIdx = 0; cIdx < maxCols; cIdx++) {
          const rawCol = cIdx < headerRow.length ? String(headerRow[cIdx] ?? '').trim() : '';
          let colName = rawCol.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
          if (!colName || /^[0-9]/.test(colName)) {
            colName = `col_${cIdx + 1}`;
          }
          let finalColName = colName;
          let colCounter = 1;
          while (usedColNames.has(finalColName)) {
            finalColName = `${colName}_${colCounter++}`;
          }
          usedColNames.add(finalColName);
          colNames.push(finalColName);
        }

        // Infer column types (TEXT vs REAL) by sampling rows
        const colTypes: string[] = [];
        for (let c = 0; c < colNames.length; c++) {
          let sampleCount = 0;
          let numericCount = 0;
          for (const row of dataRows) {
            const cell = row[c];
            if (cell !== undefined && cell !== null && String(cell).trim() !== '') {
              sampleCount++;
              if (isNumericValue(cell)) {
                numericCount++;
              }
              if (sampleCount >= 100) break;
            }
          }
          if (sampleCount > 0 && numericCount === sampleCount) {
            colTypes.push('REAL');
          } else {
            colTypes.push('TEXT');
          }
        }

        const createCols = colNames.map((c, i) => `"${c}" ${colTypes[i]}`).join(', ');
        memDb.exec(`CREATE TABLE "${tableName}" (${createCols});`);

        if (sheets.length === 1 && tableName !== 'sheet1') {
          try { memDb.exec(`CREATE VIEW "sheet1" AS SELECT * FROM "${tableName}";`); } catch {}
          try { memDb.exec(`CREATE VIEW "data" AS SELECT * FROM "${tableName}";`); } catch {}
        }

        if (dataRows.length > 0) {
          const placeholders = colNames.map(() => '?').join(', ');
          const insertStmt = memDb.prepare(`INSERT INTO "${tableName}" (${colNames.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`);

          memDb.exec('BEGIN');
          for (const row of dataRows) {
            const values: any[] = [];
            for (let c = 0; c < colNames.length; c++) {
              const cell = row[c];
              if (cell === undefined || cell === null || String(cell).trim() === '') {
                values.push(null);
              } else if (colTypes[c] === 'REAL') {
                const num = parseNumericValue(cell);
                values.push(num !== null ? num : null);
              } else {
                values.push(String(cell));
              }
            }
            insertStmt.run(...values);
          }
          memDb.exec('COMMIT');
        }
      }

      const rows = memDb.prepare(sql).all();
      return rows;
    } finally {
      if (memDb) {
        try {
          memDb.close();
        } catch {}
      }
    }
  }

  /**
   * Prunes expired tool_results older than retentionDays (default 14 days).
   * Never deletes results whose handles are currently referenced in active thread_carryover.
   */
  public pruneOldResults(retentionDays = 14): number {
    try {
      // 1. Gather all active handles from thread_carryover entries_json
      const activeHandles = new Set<string>();
      try {
        const carryoverRows = this.db.prepare(`
          SELECT entries_json FROM thread_carryover WHERE entries_json IS NOT NULL
        `).all() as Array<{ entries_json: string }>;

        for (const row of carryoverRows) {
          try {
            const entries = JSON.parse(row.entries_json);
            if (Array.isArray(entries)) {
              for (const e of entries) {
                if (e?.handle && typeof e.handle === 'string') {
                  activeHandles.add(e.handle);
                }
              }
            }
          } catch {
            // Ignore corrupted json row
          }
        }
      } catch {
        // Table or column might not exist in some unit test setups
      }

      // 2. Select candidates older than retentionDays
      const candidates = this.db.prepare(`
        SELECT handle FROM tool_results
        WHERE created_at < datetime('now', '-' || ? || ' days')
      `).all(retentionDays) as Array<{ handle: string }>;

      if (!candidates || candidates.length === 0) {
        return 0;
      }

      const toDelete = candidates
        .map(c => c.handle)
        .filter(handle => !activeHandles.has(handle));

      if (toDelete.length === 0) {
        return 0;
      }

      // 3. Delete in batches or single transaction
      const deleteStmt = this.db.prepare('DELETE FROM tool_results WHERE handle = ?');
      let deletedCount = 0;
      for (const handle of toDelete) {
        deleteStmt.run(handle);
        deletedCount++;
      }

      return deletedCount;
    } catch (err: any) {
      console.warn(`[ResultStore] pruneOldResults error: ${err.message}`);
      return 0;
    }
  }
}

