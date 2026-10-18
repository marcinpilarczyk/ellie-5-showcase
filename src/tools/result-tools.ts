import { z } from 'zod';
import { ToolDefinition } from '../types/tool.js';
import { ResultStore, RESULT_STORE_THRESHOLD, MAX_SLICE_CHARS } from '../storage/result-store.js';

export function createResultReadTool(resultStore: ResultStore): ToolDefinition {
  return {
    name: 'result_read',
    description: `Reads a stored tool result by its handle. With only the handle it returns the whole result (up to ${MAX_SLICE_CHARS} chars) in one call: use that when you need the full text. Use query (a word or phrase such as "Requirements"; returns matching lines with context) for one section of a long result. Never read slice after slice.`,
    effectClass: 'READ',
    schema: z.object({
      handle: z.string().describe(`The result handle (res_...) returned when a tool output exceeded ${RESULT_STORE_THRESHOLD} characters`),
      query: z.string().optional().describe('Search query/term to find matching lines or sections within the stored result'),
      startLine: z.number().int().positive().optional().describe('1-based start line number to retrieve'),
      endLine: z.number().int().positive().optional().describe('1-based end line number to retrieve'),
      offset: z.number().int().nonnegative().optional().describe('Character offset to start reading from (only for results longer than one read; remainingChars says what is left)'),
      maxChars: z.number().int().positive().optional().describe(`Maximum number of characters to return (default and maximum ${MAX_SLICE_CHARS})`)
    }),
    execute: async (params) => {
      return resultStore.readSlice(params.handle, {
        query: params.query,
        startLine: params.startLine,
        endLine: params.endLine,
        offset: params.offset,
        maxChars: params.maxChars
      });
    }
  };
}

export function createSheetQueryTool(resultStore: ResultStore): ToolDefinition {
  return {
    name: 'sheet_query',
    description: 'Filters, counts, and projects columns, or executes in-memory SQL queries across sheets for tabular spreadsheets stored under a result handle.',
    effectClass: 'READ',
    schema: z.object({
      handle: z.string().describe('The sheet result handle (res_...) returned by sheets_read or attached spreadsheet'),
      sql: z.string().optional().describe('ANSI SQL query to execute across sheets (e.g. "SELECT title, SUM(royalty) FROM combined_sales GROUP BY 1 ORDER BY 2 DESC LIMIT 10")'),
      filterColumn: z.string().optional().describe('Column name or header to filter on'),
      filterValue: z.string().optional().describe('Substring or value that filterColumn must contain'),
      selectColumns: z.array(z.string()).optional().describe('Subset of column headers to return'),
      limit: z.number().int().positive().optional().describe('Maximum rows to return (default 20)')
    }),
    execute: async (params) => {
      if (params.sql) {
        return resultStore.queryTabularSql(params.handle, params.sql);
      }
      return resultStore.querySheet(params.handle, {
        filterColumn: params.filterColumn,
        filterValue: params.filterValue,
        selectColumns: params.selectColumns,
        limit: params.limit
      });
    }
  };
}
