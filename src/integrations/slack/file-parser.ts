import JSZip from 'jszip';

export interface ExtractedSheet {
  name: string;
  rows: string[][];
}

export interface FileExtractResult {
  text: string;
  sheets?: ExtractedSheet[];
  isSpreadsheet?: boolean;
  sheetCount?: number;
}

export type ExtractedFileResult = FileExtractResult;

/**
 * Decodes XML entities in text nodes and attributes.
 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Converts Excel column letters (A, B, ..., Z, AA, AB, ...) to a 0-based column index.
 */
function colLettersToIndex(letters: string): number {
  let idx = 0;
  const upper = letters.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    idx = idx * 26 + (upper.charCodeAt(i) - 64);
  }
  return idx - 1;
}

/**
 * Parses an XLSX buffer using JSZip, extracting sheets and cell values.
 */
export async function parseXlsxBuffer(buffer: Buffer): Promise<ExtractedSheet[]> {
  const zip = await JSZip.loadAsync(buffer);

  // 1. Parse shared strings table (xl/sharedStrings.xml)
  const sharedStrings: string[] = [];
  const sstFile = zip.file('xl/sharedStrings.xml') || zip.file(/xl\/sharedStrings\.xml/i)[0];
  if (sstFile) {
    const sstXml = await sstFile.async('string');
    const siMatches = sstXml.match(/<si\b[\s\S]*?<\/si>/g) || [];
    for (const si of siMatches) {
      const tMatches = [...si.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)];
      const text = tMatches.map(m => decodeXmlEntities(m[1])).join('');
      sharedStrings.push(text);
    }
  }

  // 2. Parse workbook relationships (xl/_rels/workbook.xml.rels)
  const relsMap = new Map<string, string>();
  const relsFile = zip.file('xl/_rels/workbook.xml.rels') || zip.file(/xl\/_rels\/workbook\.xml\.rels/i)[0];
  if (relsFile) {
    const relsXml = await relsFile.async('string');
    const relMatches = [...relsXml.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g)];
    for (const m of relMatches) {
      relsMap.set(m[1], m[2]);
    }
  }

  // 3. Parse workbook sheets list (xl/workbook.xml)
  const workbookFile = zip.file('xl/workbook.xml') || zip.file(/xl\/workbook\.xml/i)[0];
  if (!workbookFile) {
    throw new Error('Invalid XLSX: missing xl/workbook.xml');
  }
  const workbookXml = await workbookFile.async('string');

  const sheetsMeta: Array<{ name: string; targetPath: string }> = [];
  const sheetMatches = [...workbookXml.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/?>/g)];
  if (sheetMatches.length > 0) {
    for (const m of sheetMatches) {
      const sheetName = decodeXmlEntities(m[1]);
      const rId = m[2];
      let target = relsMap.get(rId) || `worksheets/sheet${sheetsMeta.length + 1}.xml`;
      if (target.startsWith('/')) target = target.slice(1);
      if (!target.startsWith('xl/')) target = `xl/${target}`;
      sheetsMeta.push({ name: sheetName, targetPath: target });
    }
  } else {
    // Fallback if r:id not present or different attribute ordering
    const fallbackMatches = [...workbookXml.matchAll(/<sheet\b[^>]*name="([^"]+)"/g)];
    for (let i = 0; i < fallbackMatches.length; i++) {
      const sheetName = decodeXmlEntities(fallbackMatches[i][1]);
      sheetsMeta.push({ name: sheetName, targetPath: `xl/worksheets/sheet${i + 1}.xml` });
    }
  }

  // 4. Extract rows and cell values for each sheet
  const extractedSheets: ExtractedSheet[] = [];
  for (const meta of sheetsMeta) {
    let sheetFile = zip.file(meta.targetPath);
    if (!sheetFile) {
      const basename = meta.targetPath.split('/').pop() || '';
      sheetFile = zip.file(`xl/worksheets/${basename}`) || zip.file(new RegExp(`worksheets/${basename}$`, 'i'))[0];
    }
    if (!sheetFile) continue;

    const sheetXml = await sheetFile.async('string');
    const rows: string[][] = [];
    const rowMatches = sheetXml.match(/<row\b[\s\S]*?<\/row>/g) || [];

    for (const rowXml of rowMatches) {
      const cellMatches = [...rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)];
      const rowCells: string[] = [];
      let maxCol = -1;

      for (const cm of cellMatches) {
        const attrs = cm[1];
        const inner = cm[2];

        const rMatch = attrs.match(/\br="([A-Za-z]+)(\d+)"/);
        const colLetters = rMatch ? rMatch[1] : null;
        const colIdx = colLetters ? colLettersToIndex(colLetters) : maxCol + 1;

        const typeMatch = attrs.match(/\bt="([^"]+)"/);
        const cellType = typeMatch ? typeMatch[1] : null;

        let val = '';
        if (cellType === 's') {
          const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
          if (vMatch) {
            const sstIdx = parseInt(vMatch[1], 10);
            val = sharedStrings[sstIdx] ?? '';
          }
        } else if (cellType === 'inlineStr') {
          const tMatch = inner.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
          val = tMatch ? decodeXmlEntities(tMatch[1]) : '';
        } else if (cellType === 'b') {
          const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
          val = vMatch && vMatch[1] === '1' ? 'TRUE' : 'FALSE';
        } else {
          const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
          val = vMatch ? decodeXmlEntities(vMatch[1]) : '';
        }

        if (colIdx >= 0) {
          rowCells[colIdx] = val;
          if (colIdx > maxCol) maxCol = colIdx;
        }
      }

      // Fill empty slots up to maxCol with empty string
      for (let c = 0; c <= maxCol; c++) {
        if (rowCells[c] === undefined) rowCells[c] = '';
      }

      // Include row if it contains at least one non-empty cell
      if (rowCells.some(c => c.trim().length > 0)) {
        rows.push(rowCells);
      }
    }

    extractedSheets.push({ name: meta.name, rows });
  }

  return extractedSheets;
}

/**
 * Formats extracted sheets into a clean, markdown-friendly text representation.
 */
export function formatXlsxSheets(
  sheets: ExtractedSheet[],
  maxRowsPerSheet = 15,
  maxCols = 25
): string {
  if (sheets.length === 0) {
    return '(No sheets or data found in spreadsheet)';
  }

  const sections: string[] = [];

  for (const sheet of sheets) {
    const totalRows = sheet.rows.length;
    const header = `### Sheet: "${sheet.name}" (${totalRows} row${totalRows === 1 ? '' : 's'})`;

    if (totalRows === 0) {
      sections.push(`${header}\n(empty sheet)`);
      continue;
    }

    const displayedRows = sheet.rows.slice(0, maxRowsPerSheet);
    const lines: string[] = [header];

    for (const [rowIdx, row] of displayedRows.entries()) {
      const truncatedRow = row.slice(0, maxCols).map(cell => cell.replace(/\r?\n/g, ' ').trim());
      const rowLine = `| ${truncatedRow.join(' | ')} |`;
      lines.push(rowLine);
      if (rowIdx === 0 && displayedRows.length > 1) {
        // Add markdown separator after header row
        const separator = `| ${truncatedRow.map(() => '---').join(' | ')} |`;
        lines.push(separator);
      }
    }

    if (totalRows > maxRowsPerSheet) {
      lines.push(`... [${totalRows - maxRowsPerSheet} more rows truncated]`);
    }

    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}

/**
 * Parses delimited text (CSV/TSV) into a 2D string array handling quoted cells.
 */
export function parseDelimitedText(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          currentCell += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        currentCell += char;
        i++;
        continue;
      }
    }

    if (char === '"') {
      inQuotes = true;
      i++;
    } else if (char === delimiter) {
      currentRow.push(currentCell.trim());
      currentCell = '';
      i++;
    } else if (char === '\r') {
      if (i + 1 < text.length && text[i + 1] === '\n') {
        i++;
      }
      currentRow.push(currentCell.trim());
      if (currentRow.some(c => c.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentCell = '';
      i++;
    } else if (char === '\n') {
      currentRow.push(currentCell.trim());
      if (currentRow.some(c => c.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentCell = '';
      i++;
    } else {
      currentCell += char;
      i++;
    }
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    if (currentRow.some(c => c.length > 0)) {
      rows.push(currentRow);
    }
  }

  return rows;
}

/**
 * Extracts content or metadata from a downloaded file buffer.
 */
export async function extractFileContent(
  file: { name?: string; mimetype?: string; size?: number },
  buffer: Buffer
): Promise<FileExtractResult> {
  const fileName = file.name || 'unnamed_file';
  const fileSize = file.size ?? buffer.length;
  const mime = (file.mimetype || '').toLowerCase();
  const lowerName = fileName.toLowerCase();

  // 1. XLSX Spreadsheets
  const isXlsx = lowerName.endsWith('.xlsx') ||
    mime.includes('spreadsheetml') ||
    mime.includes('vnd.ms-excel') ||
    (buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4B && lowerName.endsWith('.xls'));

  if (isXlsx) {
    try {
      const sheets = await parseXlsxBuffer(buffer);
      const formatted = formatXlsxSheets(sheets, 15);
      return {
        text: `[Attached Spreadsheet: ${fileName} (${fileSize} bytes)]\n${formatted}`,
        isSpreadsheet: true,
        sheetCount: sheets.length,
        sheets
      };
    } catch (err: any) {
      return {
        text: `[Attached Spreadsheet: ${fileName} (${fileSize} bytes) - Note: Failed to parse spreadsheet: ${err.message}]`,
        isSpreadsheet: true
      };
    }
  }

  // 2. CSV / TSV tabular files
  const isCsv = lowerName.endsWith('.csv') || mime === 'text/csv';
  const isTsv = lowerName.endsWith('.tsv') || mime === 'text/tab-separated-values';
  if (isCsv || isTsv) {
    const delimiter = isTsv ? '\t' : ',';
    const rows = parseDelimitedText(buffer.toString('utf-8'), delimiter);
    const sheetName = fileName.replace(/\.[^/.]+$/, '') || fileName;
    const sheets: ExtractedSheet[] = [{ name: sheetName, rows }];
    const formatted = formatXlsxSheets(sheets, 15);
    return {
      text: `[Attached ${isTsv ? 'TSV' : 'CSV'} File: ${fileName} (${fileSize} bytes)]\n${formatted}`,
      isSpreadsheet: true,
      sheetCount: 1,
      sheets
    };
  }

  // 3. DOCX Documents
  const isDocx = lowerName.endsWith('.docx') || mime.includes('wordprocessingml');
  if (isDocx && buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4B) {
    try {
      const zip = await JSZip.loadAsync(buffer);
      const docXmlFile = zip.file('word/document.xml');
      if (docXmlFile) {
        const xml = await docXmlFile.async('string');
        const paragraphs = [...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map(pMatch => {
          const tMatches = [...pMatch[0].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)];
          return tMatches.map(m => decodeXmlEntities(m[1])).join('');
        }).filter(p => p.trim().length > 0);
        const docText = paragraphs.slice(0, 100).join('\n\n');
        return {
          text: `[Attached Document: ${fileName} (${fileSize} bytes)]\n${docText}`,
          isSpreadsheet: false
        };
      }
    } catch {}
  }

  // 4. Plain text / JSON / Markdown / XML / YAML
  const isText = mime.startsWith('text/') ||
    mime === 'application/json' ||
    /\.(txt|json|md|yaml|yml|xml|log|sh|js|ts|py|html|css|sql)$/i.test(lowerName);

  if (isText) {
    const text = buffer.toString('utf-8');
    const maxChars = 20_000;
    const truncated = text.length > maxChars ? `${text.slice(0, maxChars)}\n... [content truncated]` : text;
    return {
      text: `[Attached Text File: ${fileName} (${fileSize} bytes)]\n\`\`\`\n${truncated}\n\`\`\``,
      isSpreadsheet: false
    };
  }

  // 5. Fallback for binary / PDF / unrecognized files: return clear metadata
  return {
    text: `[Attached File: ${fileName} (${fileSize} bytes, type: ${mime || 'application/octet-stream'})]`,
    isSpreadsheet: false
  };
}
