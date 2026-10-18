import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { parseXlsxBuffer, formatXlsxSheets, extractFileContent } from '../integrations/slack/file-parser.js';

describe('file-parser: XLSX and attached file extraction', () => {
  async function createTestXlsxBuffer(): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets>' +
      '<sheet name="Employees" sheetId="1" r:id="rId1"/>' +
      '<sheet name="Q1 Sales" sheetId="2" r:id="rId2"/>' +
      '</sheets>' +
      '</workbook>'
    );
    zip.file(
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>' +
      '</Relationships>'
    );
    zip.file(
      'xl/sharedStrings.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<sst count="4" uniqueCount="4">' +
      '<si><t>Name</t></si>' +
      '<si><t>Role</t></si>' +
      '<si><t>Alice &amp; Bob</t></si>' +
      '<si><t>Staff Engineer</t></si>' +
      '</sst>'
    );
    // Sheet 1: Employees (headers + row with shared strings and numeric cells)
    zip.file(
      'xl/worksheets/sheet1.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData>' +
      '<row r="1">' +
      '<c r="A1" t="s"><v>0</v></c>' +
      '<c r="B1" t="s"><v>1</v></c>' +
      '<c r="C1"><v>Salary</v></c>' +
      '</row>' +
      '<row r="2">' +
      '<c r="A2" t="s"><v>2</v></c>' +
      '<c r="B2" t="s"><v>3</v></c>' +
      '<c r="C2"><v>185000</v></c>' +
      '</row>' +
      '</sheetData>' +
      '</worksheet>'
    );
    // Sheet 2: Q1 Sales
    zip.file(
      'xl/worksheets/sheet2.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData>' +
      '<row r="1">' +
      '<c r="A1"><v>450000</v></c>' +
      '<c r="B1" t="b"><v>1</v></c>' +
      '</row>' +
      '</sheetData>' +
      '</worksheet>'
    );

    return await zip.generateAsync({ type: 'nodebuffer' });
  }

  it('parses multi-sheet XLSX buffer accurately with shared strings and booleans', async () => {
    const buffer = await createTestXlsxBuffer();
    const sheets = await parseXlsxBuffer(buffer);

    assert.equal(sheets.length, 2);
    assert.equal(sheets[0].name, 'Employees');
    assert.equal(sheets[0].rows.length, 2);
    assert.deepEqual(sheets[0].rows[0], ['Name', 'Role', 'Salary']);
    assert.deepEqual(sheets[0].rows[1], ['Alice & Bob', 'Staff Engineer', '185000']);

    assert.equal(sheets[1].name, 'Q1 Sales');
    assert.equal(sheets[1].rows.length, 1);
    assert.deepEqual(sheets[1].rows[0], ['450000', 'TRUE']);
  });

  it('formats sheets into readable markdown tables', async () => {
    const buffer = await createTestXlsxBuffer();
    const sheets = await parseXlsxBuffer(buffer);
    const formatted = formatXlsxSheets(sheets);

    assert.ok(formatted.includes('### Sheet: "Employees"'));
    assert.ok(formatted.includes('| Name | Role | Salary |'));
    assert.ok(formatted.includes('| Alice & Bob | Staff Engineer | 185000 |'));
    assert.ok(formatted.includes('### Sheet: "Q1 Sales"'));
    assert.ok(formatted.includes('| 450000 | TRUE |'));
  });

  it('extractFileContent extracts XLSX spreadsheet data and sets isSpreadsheet true', async () => {
    const buffer = await createTestXlsxBuffer();
    const result = await extractFileContent(
      {
        name: 'budget_2026.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: buffer.length
      },
      buffer
    );

    assert.equal(result.isSpreadsheet, true);
    assert.equal(result.sheetCount, 2);
    assert.ok(result.text.includes('[Attached Spreadsheet: budget_2026.xlsx'));
    assert.ok(result.text.includes('Alice & Bob'));
  });

  it('extractFileContent extracts CSV file data', async () => {
    const csvContent = 'Date,Item,Amount\n2026-10-01,Groceries,45.50\n2026-10-02,Internet,80.00';
    const buffer = Buffer.from(csvContent, 'utf-8');
    const result = await extractFileContent(
      { name: 'expenses.csv', mimetype: 'text/csv' },
      buffer
    );

    assert.equal(result.isSpreadsheet, true);
    assert.ok(result.text.includes('[Attached CSV File: expenses.csv'));
    assert.ok(result.text.includes('Groceries'));
    assert.ok(result.text.includes('45.50'));
  });

  it('extractFileContent extracts plain text and json files', async () => {
    const jsonContent = JSON.stringify({ project: 'Ellie', active: true }, null, 2);
    const buffer = Buffer.from(jsonContent, 'utf-8');
    const result = await extractFileContent(
      { name: 'project.json', mimetype: 'application/json' },
      buffer
    );

    assert.equal(result.isSpreadsheet, false);
    assert.ok(result.text.includes('[Attached Text File: project.json'));
    assert.ok(result.text.includes('"project": "Ellie"'));
  });

  it('extractFileContent returns metadata for unknown binary files', async () => {
    const buffer = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const result = await extractFileContent(
      { name: 'unknown.bin', mimetype: 'application/octet-stream', size: 4 },
      buffer
    );

    assert.equal(result.isSpreadsheet, false);
    assert.equal(result.text, '[Attached File: unknown.bin (4 bytes, type: application/octet-stream)]');
  });
});
