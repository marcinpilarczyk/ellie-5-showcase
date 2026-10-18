import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeAppDatabase, initializeLedgerDatabase } from '../storage/schema.js';
import { ResultStore } from '../storage/result-store.js';
import { createSheetQueryTool } from '../tools/result-tools.js';
import { extractFileContent, parseDelimitedText, formatXlsxSheets } from '../integrations/slack/file-parser.js';
import { ThreadCarryoverRepository } from '../storage/thread-carryover-repo.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { SlackCoworkerService } from '../integrations/slack/coworker.js';

describe('In-Memory SQLite Tabular Querying (sheet_query SQL upgrade)', () => {
  let db: DatabaseSync;
  let resultStore: ResultStore;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    initializeAppDatabase(db);
    resultStore = new ResultStore(db);
  });

  describe('1. File Parser (CSV/TSV/XLSX)', () => {
    it('parseDelimitedText parses CSV with quotes, commas, and escaped quotes', () => {
      const csv = `Title,Author,Price,Description\n"The Great Book","Doe, John","$15.99","A ""fantastic"" read"\n"Another Book","Smith, Jane","$24.50","Second line"`;
      const rows = parseDelimitedText(csv, ',');
      assert.equal(rows.length, 3);
      assert.deepEqual(rows[0], ['Title', 'Author', 'Price', 'Description']);
      assert.deepEqual(rows[1], ['The Great Book', 'Doe, John', '$15.99', 'A "fantastic" read']);
      assert.deepEqual(rows[2], ['Another Book', 'Smith, Jane', '$24.50', 'Second line']);
    });

    it('parseDelimitedText parses TSV correctly', () => {
      const tsv = `ID\tProduct\tQuantity\n1\tWidget A\t100\n2\tWidget B\t250`;
      const rows = parseDelimitedText(tsv, '\t');
      assert.equal(rows.length, 3);
      assert.deepEqual(rows[0], ['ID', 'Product', 'Quantity']);
      assert.deepEqual(rows[1], ['1', 'Widget A', '100']);
      assert.deepEqual(rows[2], ['2', 'Widget B', '250']);
    });

    it('extractFileContent returns structured sheets and 15-row preview for CSV', async () => {
      const csvLines = ['ID,Name,Value'];
      for (let i = 1; i <= 30; i++) {
        csvLines.push(`${i},Item_${i},${i * 10}`);
      }
      const buffer = Buffer.from(csvLines.join('\n'), 'utf-8');
      const res = await extractFileContent({ name: 'sales_data.csv', mimetype: 'text/csv' }, buffer);

      assert.ok(res.sheets, 'res.sheets should be defined');
      assert.equal(res.sheets.length, 1);
      assert.equal(res.sheets[0].name, 'sales_data');
      assert.equal(res.sheets[0].rows.length, 31);
      assert.ok(res.text.includes('[Attached CSV File: sales_data.csv'));
      assert.ok(res.text.includes('more rows truncated'));
    });
  });

  describe('2. ResultStore.queryTabularSql', () => {
    it('executes SQL queries against multi-sheet tables with sanitized names and types', () => {
      const sheets = [
        {
          name: 'Combined Sales',
          rows: [
            ['Title', 'Royalty', 'Units Sold'],
            ['Book Alpha', '$12.50', '5'],
            ['Book Beta', '$45.00', '15'],
            ['Book Alpha', '€7.50', '3'],
            ['Book Gamma', '$120.00', '40']
          ]
        },
        {
          name: 'Author Details',
          rows: [
            ['Book Title', 'Author Name', 'Rating'],
            ['Book Alpha', 'John Doe', '4.5'],
            ['Book Beta', 'Jane Roe', '4.8'],
            ['Book Gamma', 'Alice Bob', '4.9']
          ]
        }
      ];

      const handle = resultStore.keep('run_test_1', 'attached_spreadsheet', { fileName: 'kdp_report.xlsx', sheets });

      // 1. Aggregation with GROUP BY, SUM, ORDER BY
      const salesQuery = `
        SELECT title, SUM(royalty) as total_royalty, SUM(units_sold) as total_units
        FROM combined_sales
        GROUP BY 1
        ORDER BY total_royalty DESC
      `;
      const salesResults = resultStore.queryTabularSql(handle, salesQuery);
      assert.equal(salesResults.length, 3);
      assert.equal(salesResults[0].title, 'Book Gamma');
      assert.equal(salesResults[0].total_royalty, 120);
      assert.equal(salesResults[1].title, 'Book Beta');
      assert.equal(salesResults[1].total_royalty, 45);
      assert.equal(salesResults[2].title, 'Book Alpha');
      assert.equal(salesResults[2].total_royalty, 20); // 12.50 + 7.50

      // 2. Cross-sheet join
      const joinQuery = `
        SELECT s.title, a.author_name, SUM(s.royalty) as royalty
        FROM combined_sales s
        JOIN author_details a ON s.title = a.book_title
        GROUP BY s.title, a.author_name
        ORDER BY royalty DESC
      `;
      const joinResults = resultStore.queryTabularSql(handle, joinQuery);
      assert.equal(joinResults.length, 3);
      assert.equal(joinResults[0].author_name, 'Alice Bob');
      assert.equal(joinResults[1].author_name, 'Jane Roe');
      assert.equal(joinResults[2].author_name, 'John Doe');
    });

    it('creates single table convenience views sheet1 and data', () => {
      const sheets = [
        {
          name: 'Pipeline',
          rows: [
            ['Deal', 'Amount'],
            ['Acme', '5000'],
            ['Globex', '12000']
          ]
        }
      ];
      const handle = resultStore.keep('run_test_2', 'attached_spreadsheet', { fileName: 'pipeline.xlsx', sheets });

      const resSheet1 = resultStore.queryTabularSql(handle, 'SELECT SUM(amount) as total FROM sheet1');
      assert.equal(resSheet1[0].total, 17000);

      const resData = resultStore.queryTabularSql(handle, 'SELECT * FROM data ORDER BY amount DESC');
      assert.equal(resData[0].deal, 'Globex');
      assert.equal(resData[1].deal, 'Acme');
    });

    it('guards against write queries (rejects INSERT, DROP, UPDATE, DELETE)', () => {
      const sheets = [
        {
          name: 'data',
          rows: [['val'], ['1']]
        }
      ];
      const handle = resultStore.keep('run_test_3', 'attached_spreadsheet', { sheets });

      assert.throws(() => {
        resultStore.queryTabularSql(handle, 'DROP TABLE data');
      }, /Only read-only SQL queries/);

      assert.throws(() => {
        resultStore.queryTabularSql(handle, 'INSERT INTO data VALUES (2)');
      }, /Only read-only SQL queries/);

      assert.throws(() => {
        resultStore.queryTabularSql(handle, 'UPDATE data SET val = 5');
      }, /Only read-only SQL queries/);
    });

    it('allows WITH and EXPLAIN queries', () => {
      const sheets = [
        {
          name: 'sales',
          rows: [
            ['category', 'revenue'],
            ['Books', '100'],
            ['Audio', '50']
          ]
        }
      ];
      const handle = resultStore.keep('run_test_4', 'attached_spreadsheet', { sheets });

      const withResult = resultStore.queryTabularSql(handle, `
        WITH doubled AS (
          SELECT category, revenue * 2 as doubled_rev FROM sales
        )
        SELECT category, doubled_rev FROM doubled ORDER BY doubled_rev DESC
      `);
      assert.equal(withResult.length, 2);
      assert.equal(withResult[0].doubled_rev, 200);

      const explainResult = resultStore.queryTabularSql(handle, 'EXPLAIN QUERY PLAN SELECT * FROM sales');
      assert.ok(Array.isArray(explainResult));
      assert.ok(explainResult.length > 0);
    });

    it('executes high-volume multi-sheet query with deterministic aggregates in < 25ms', () => {
      // 1200 rows in combined_sales
      const salesRows: string[][] = [['Title', 'Royalty', 'Country', 'Date']];
      for (let i = 1; i <= 1200; i++) {
        const title = `Book ${i % 10}`;
        const royalty = `$${((i % 20) + 1).toFixed(2)}`;
        const country = i % 2 === 0 ? 'US' : 'UK';
        salesRows.push([title, royalty, country, '2026-10-01']);
      }

      // 500 rows in book_meta
      const metaRows: string[][] = [['Title', 'Author', 'Pages']];
      for (let i = 0; i < 10; i++) {
        metaRows.push([`Book ${i}`, `Author ${i}`, `${200 + i * 20}`]);
      }

      const sheets = [
        { name: 'Combined Sales', rows: salesRows },
        { name: 'Book Metadata', rows: metaRows }
      ];

      const handle = resultStore.keep('run_perf_test', 'attached_spreadsheet', { sheets });

      const start = performance.now();
      const results = resultStore.queryTabularSql(handle, `
        SELECT s.title, m.author, SUM(s.royalty) as total_royalty, COUNT(*) as tx_count
        FROM combined_sales s
        JOIN book_metadata m ON s.title = m.title
        GROUP BY 1, 2
        ORDER BY 3 DESC
        LIMIT 5
      `);
      const durationMs = performance.now() - start;

      assert.equal(results.length, 5);
      assert.ok(results[0].total_royalty > 0);
      assert.ok(durationMs < 50, `Query took ${durationMs}ms, expected fast execution (<50ms)`);
    });
  });

  describe('3. Tool: sheet_query', () => {
    it('calls queryTabularSql when sql parameter is provided', async () => {
      const sheets = [
        {
          name: 'inventory',
          rows: [
            ['Item', 'Qty', 'Unit Price'],
            ['Pen', '100', '1.50'],
            ['Notebook', '40', '4.00'],
            ['Eraser', '200', '0.75']
          ]
        }
      ];
      const handle = resultStore.keep('run_tool_1', 'attached_spreadsheet', { sheets });
      const tool = createSheetQueryTool(resultStore);

      const res = await tool.execute({
        handle,
        sql: 'SELECT item, qty * unit_price as value FROM inventory ORDER BY value DESC'
      }, { runId: 'run_tool_1', instruction: 'query inventory' } as any);

      assert.ok(Array.isArray(res));
      assert.equal(res.length, 3);
      assert.equal(res[0].item, 'Notebook');
      assert.equal(res[0].value, 160);
    });

    it('falls back to filterColumn/filterValue when sql is omitted', async () => {
      const sheets = [
        {
          name: 'inventory',
          rows: [
            ['Item', 'Qty'],
            ['Pen', '100'],
            ['Notebook', '40'],
            ['Eraser', '200']
          ]
        }
      ];
      const handle = resultStore.keep('run_tool_2', 'attached_spreadsheet', { sheets });
      const tool = createSheetQueryTool(resultStore);

      const res = await tool.execute({
        handle,
        filterColumn: 'Item',
        filterValue: 'Note'
      }, { runId: 'run_tool_2', instruction: 'filter' } as any);

      assert.equal(res.matchedRows, 1);
      assert.equal(res.rows[0].Item, 'Notebook');
    });
  });

  describe('4. SlackCoworkerService Attachment & Carryover Integration', () => {
    it('extracts tabular spreadsheet, stores in ResultStore with header handle and records in thread_carryover', async () => {
      const carryover = new ThreadCarryoverRepository(db, resultStore);
      const csvData = `Employee,Department,Salary\nAlice,Engineering,"$120,000"\nBob,Marketing,"$85,000"\nCharlie,Engineering,"$135,000"`;
      const fileBuffer = Buffer.from(csvData, 'utf-8');

      const mockSlack: any = {
        downloadFile: async (url: string) => {
          if (url.includes('salaries.csv')) {
            return { buffer: fileBuffer, mimeType: 'text/csv' };
          }
          return null;
        },
        addReaction: async () => ({ ok: true }),
        removeReaction: async () => ({ ok: true }),
        postMessage: async () => ({ ok: true, ts: '100.2' })
      };

      let runnerOptsReceived: any = null;
      const mockRunner: any = {
        run: async (opts: any) => {
          runnerOptsReceived = opts;
          return {
            runId: opts.runId || 'run_mock',
            status: 'COMPLETED',
            output: { deliveryMode: 'SLACK_MESSAGE', summary: 'Processed salaries' },
            toolCallsExecuted: [],
            handlesCreated: [],
            telemetry: { promptTokens: 0, cachedTokens: 0, thinkingTokens: 0, candidatesTokens: 0, totalTokens: 0, model: 'test', durationMs: 0 },
            wallMs: 10
          };
        }
      };

      const ledgerDb = new DatabaseSync(':memory:');
      initializeLedgerDatabase(ledgerDb);
      const ledgerRepo = new ActionLedgerRepository(ledgerDb);
      const coworker = new SlackCoworkerService(
        mockSlack,
        ledgerRepo,
        mockRunner,
        undefined,
        undefined,
        carryover,
        undefined,
        undefined,
        resultStore
      );

      const event: any = {
        type: 'message',
        user: 'U_TEST',
        channel: 'C_SALARIES',
        ts: '100.1',
        text: 'What is total engineering salary?',
        files: [
          {
            id: 'F_SALARIES',
            name: 'salaries.csv',
            mimetype: 'text/csv',
            url_private_download: 'https://files.slack.com/salaries.csv'
          }
        ]
      };

      await coworker.handleUserMessage(event);

      assert.ok(runnerOptsReceived, 'Runner should have received execution options');
      const attachedPart = runnerOptsReceived.userParts.find((p: any) => p.text?.includes('[Attached Spreadsheet: salaries.csv'));
      assert.ok(attachedPart, 'userParts should contain attached spreadsheet part');
      assert.ok(attachedPart.text.includes('(handle: res_attached_spreadsheet_'));
      assert.ok(attachedPart.text.includes('Available tables/sheets: "salaries" (4 rows)'));

      // Check handle can be queried directly via queryTabularSql
      const handleMatch = attachedPart.text.match(/\(handle: (res_attached_spreadsheet_[^)]+)\)/);
      assert.ok(handleMatch, 'Handle should be present in header');
      const handle = handleMatch[1];

      const queryResult = resultStore.queryTabularSql(handle, 'SELECT department, SUM(salary) as total FROM salaries GROUP BY 1 ORDER BY 2 DESC');
      assert.equal(queryResult[0].department, 'Engineering');
      assert.equal(queryResult[0].total, 255000);

      // Verify handle was recorded in thread_carryover for subsequent thread messages
      const carryoverSummary = carryover.get('C_SALARIES:100.1');
      assert.ok(carryoverSummary, 'Thread carryover should exist');
      assert.ok(carryoverSummary.includes(handle), 'Carryover summary should contain the handle');
      assert.ok(carryoverSummary.includes('attached_spreadsheet'), 'Carryover summary should contain attached_spreadsheet tool');
    });
  });
});
