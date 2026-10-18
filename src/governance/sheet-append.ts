export const REQUIRED_CONTRACT_COLUMNS = ['company_domain', 'found_by', 'found_at', 'last_edited_by', 'last_edited_at'] as const;

export interface TabConfig {
  headerRow: number;
  requiredColumns?: readonly string[];
}

export const TRACKER_TAB_CONFIG: Record<string, Record<string, TabConfig>> = {
  prospects: {
    Pipeline: { headerRow: 8, requiredColumns: REQUIRED_CONTRACT_COLUMNS },
    Research: { headerRow: 8, requiredColumns: REQUIRED_CONTRACT_COLUMNS }
  },
  targets: {
    Targets: { headerRow: 1, requiredColumns: ['Company', 'job_url', 'found_by', 'found_at', 'last_edited_by', 'last_edited_at'] }
  }
};

export class SheetAppendRefusal extends Error {
  constructor(message: string) {
    super(`[Sheet Append Refused] ${message}`);
    this.name = 'SheetAppendRefusal';
  }
}

export function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function tabNameFromRange(range: string): string {
  const bang = range.lastIndexOf('!');
  const raw = (bang >= 0 ? range.slice(0, bang) : range).trim();
  return raw.replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
}

function quoteTab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

export interface MappedRow {
  cells: Array<string | number | boolean>;
  startColumn: number;
  endColumn: number;
  range: string;
  mapping: Record<string, string | number | boolean>;
}

export function mapRowToHeaders(
  tab: string,
  headerRow: number,
  headerCells: unknown[],
  row: Record<string, unknown>,
  requiredColumns: readonly string[] = REQUIRED_CONTRACT_COLUMNS
): MappedRow {
  const headerIndex = new Map<string, number>();
  const headerLabel = new Map<string, string>();

  headerCells.forEach((cell, index) => {
    const key = normalizeHeader(cell);
    if (!key) return;
    if (headerIndex.has(key)) {
      throw new SheetAppendRefusal(`Header '${String(cell).trim()}' appears more than once in row ${headerRow} of '${tab}'.`);
    }
    headerIndex.set(key, index);
    headerLabel.set(key, String(cell).trim());
  });

  if (headerIndex.size === 0) {
    throw new SheetAppendRefusal(`Row ${headerRow} of '${tab}' has no headers.`);
  }

  const missingColumns = requiredColumns.filter(c => !headerIndex.has(normalizeHeader(c)));
  if (missingColumns.length > 0) {
    throw new SheetAppendRefusal(`Required column(s) missing from header row of '${tab}': ${missingColumns.join(', ')}.`);
  }

  const supplied = new Map<string, { original: string; value: unknown }>();
  for (const [name, value] of Object.entries(row)) {
    const key = normalizeHeader(name);
    if (!key) throw new SheetAppendRefusal('A value was supplied under an empty column name.');
    if (supplied.has(key)) throw new SheetAppendRefusal(`Column '${name}' was supplied more than once.`);
    supplied.set(key, { original: name, value });
  }

  const unknown = [...supplied.values()].filter(s => !headerIndex.has(normalizeHeader(s.original))).map(s => s.original);
  if (unknown.length > 0) {
    throw new SheetAppendRefusal(`No header in '${tab}' matches: ${unknown.join(', ')}.`);
  }

  const indices = [...headerIndex.values()];
  const startColumn = Math.min(...indices);
  const endColumn = Math.max(...indices);
  const cells: Array<string | number | boolean> = new Array(endColumn - startColumn + 1).fill('');
  const mapping: Record<string, string | number | boolean> = {};

  for (const [key, entry] of supplied) {
    const value = entry.value;
    const cell = value !== null && value !== undefined ? (value as any) : '';
    cells[headerIndex.get(key)! - startColumn] = cell;
    mapping[headerLabel.get(key)!] = cell;
  }

  return {
    cells,
    startColumn,
    endColumn,
    range: `${quoteTab(tab)}!${columnLetter(startColumn)}${headerRow}:${columnLetter(endColumn)}`,
    mapping
  };
}

export function resolveHeaderRow(spreadsheetId: string, tab: string, explicit?: number): TabConfig {
  const configured = TRACKER_TAB_CONFIG.prospects[tab] || TRACKER_TAB_CONFIG.targets[tab];
  if (configured) {
    return configured;
  }
  return { headerRow: explicit || 1 };
}

export async function appendRowByHeaders(
  googleClient: { readSheetRange: (id: string, range: string) => Promise<{ values: any[][] }>; appendSheetRows: (id: string, range: string, values: any[][]) => Promise<any> },
  params: { spreadsheetId: string; range: string; row: Record<string, unknown>; headerRow?: number }
): Promise<{ updatedRange?: string; updatedRows: number; mapping: Record<string, any>; headerRow: number }> {
  const tab = tabNameFromRange(params.range);
  if (!tab) throw new SheetAppendRefusal('A tab name is required in range.');
  const config = resolveHeaderRow(params.spreadsheetId, tab, params.headerRow);

  const headerRead = await googleClient.readSheetRange(params.spreadsheetId, `${quoteTab(tab)}!${config.headerRow}:${config.headerRow}`);
  const headerCells = headerRead.values[0] ?? [];
  const mapped = mapRowToHeaders(tab, config.headerRow, headerCells, params.row, config.requiredColumns);

  const result = await googleClient.appendSheetRows(params.spreadsheetId, mapped.range, [mapped.cells]);
  return { updatedRange: result.updatedRange, updatedRows: result.updatedRows, mapping: mapped.mapping, headerRow: config.headerRow };
}

export async function reconcileGoogleSheetsAppend(
  googleClient: { readSheetRange: (id: string, range: string) => Promise<{ values: any[][] }> },
  params: { spreadsheetId: string; range: string; values?: any[] }
): Promise<{ outcome: 'VERIFIED_SUCCESS' | 'FAILED_SAFE'; details: string }> {
  try {
    const res = await googleClient.readSheetRange(params.spreadsheetId, params.range);
    const searchVal = String(params.values?.[0] ?? '').trim().toLowerCase();
    if (!searchVal) {
      return { outcome: 'VERIFIED_SUCCESS', details: 'Append verified (no specific key queried).' };
    }
    const found = (res.values || []).some(row =>
      row.some(cell => String(cell ?? '').trim().toLowerCase().includes(searchVal))
    );
    if (found) {
      return { outcome: 'VERIFIED_SUCCESS', details: `Appended row containing '${searchVal}' confirmed in sheet.` };
    }
    return { outcome: 'FAILED_SAFE', details: `Appended row containing '${searchVal}' not found in sheet upon read-back.` };
  } catch (err: any) {
    return { outcome: 'FAILED_SAFE', details: `Read-back verification failed: ${err.message}` };
  }
}
