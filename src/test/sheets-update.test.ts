import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntime } from '../runtime/build-runtime.js';

describe('sheets_update Tool & Governance Suite', () => {
  const runtime = buildRuntime({
    appDbPath: ':memory:',
    ledgerDbPath: ':memory:'
  });

  const dispatcher = runtime.dispatcher;

  it('registers sheets_update tool with correct metadata and schema', () => {
    const tool = dispatcher.getTool('sheets_update');
    assert.ok(tool, 'sheets_update tool should be registered');
    assert.equal(tool.name, 'sheets_update');
    assert.equal(tool.effectClass, 'INTERNAL_REVERSIBLE_WRITE');
    assert.ok(tool.verify !== undefined || tool.reconcile !== undefined, 'sheets_update must have a read-back hook');
  });

  it('successfully updates a sheet range and passes read-back verification', async () => {
    let updateCalledWith: any = null;
    let readCalledWith: any = null;

    (runtime.googleClient as any).updateSheetRange = async (spreadsheetId: string, range: string, values: any[][]) => {
      updateCalledWith = { spreadsheetId, range, values };
      return {
        updatedRange: 'Inbox!F2:F2',
        updatedRows: 1,
        updatedColumns: 1,
        updatedCells: 1
      };
    };

    (runtime.googleClient as any).readSheetRange = async (spreadsheetId: string, range: string) => {
      readCalledWith = { spreadsheetId, range };
      return {
        values: [['Reviewed']]
      };
    };

    const res: any = await dispatcher.dispatch(
      'sheets_update',
      {
        spreadsheetId: 'prospects',
        range: 'Inbox!F2:F2',
        values: [['Reviewed']]
      },
      {
        runId: 'run_sheets_test_1',
        isInteractive: true,
        toolGrant: { allowedToolNames: new Set(['sheets_update']), allowConsequential: false }
      }
    );

    assert.equal(res.updatedRange, 'Inbox!F2:F2');
    assert.deepEqual(updateCalledWith, {
      spreadsheetId: 'prospects',
      range: 'Inbox!F2:F2',
      values: [['Reviewed']]
    });
    assert.deepEqual(readCalledWith, {
      spreadsheetId: 'prospects',
      range: 'Inbox!F2:F2'
    });
    assert.ok(res.readBack);
    assert.equal(res.readBack.status, 'VERIFIED');
    assert.match(res.readBack.detail, /Inbox!F2:F2/);
  });

  it('marks readBack ABSENT if readSheetRange returns empty/not found', async () => {
    (runtime.googleClient as any).updateSheetRange = async () => ({
      updatedRange: 'Inbox!F2:F2',
      updatedRows: 1,
      updatedColumns: 1,
      updatedCells: 1
    });

    (runtime.googleClient as any).readSheetRange = async () => ({
      values: undefined as any
    });

    const res: any = await dispatcher.dispatch(
      'sheets_update',
      {
        spreadsheetId: 'prospects',
        range: 'Inbox!F2:F2',
        values: [['Reviewed']]
      },
      {
        runId: 'run_sheets_test_2',
        isInteractive: true,
        toolGrant: { allowedToolNames: new Set(['sheets_update']), allowConsequential: false }
      }
    );

    assert.equal(res.updatedRange, 'Inbox!F2:F2');
    assert.ok(res.readBack);
    assert.equal(res.readBack.status, 'ABSENT');
  });

  it('marks readBack INCONCLUSIVE if readSheetRange throws during verification', async () => {
    (runtime.googleClient as any).updateSheetRange = async () => ({
      updatedRange: 'Inbox!F2:F2',
      updatedRows: 1,
      updatedColumns: 1,
      updatedCells: 1
    });

    (runtime.googleClient as any).readSheetRange = async () => {
      throw new Error('API network timeout');
    };

    const res: any = await dispatcher.dispatch(
      'sheets_update',
      {
        spreadsheetId: 'prospects',
        range: 'Inbox!F2:F2',
        values: [['Reviewed']]
      },
      {
        runId: 'run_sheets_test_3',
        isInteractive: true,
        toolGrant: { allowedToolNames: new Set(['sheets_update']), allowConsequential: false }
      }
    );

    assert.equal(res.updatedRange, 'Inbox!F2:F2');
    assert.ok(res.readBack);
    assert.equal(res.readBack.status, 'INCONCLUSIVE');
  });

  it('rejects invalid parameters according to schema', async () => {
    await assert.rejects(
      async () => {
        await dispatcher.dispatch(
          'sheets_update',
          {
            spreadsheetId: 'prospects',
            range: 'Inbox!F2:F2'
            // missing values
          },
          {
            runId: 'run_sheets_test_4',
            isInteractive: true,
            toolGrant: { allowedToolNames: new Set(['sheets_update']), allowConsequential: false }
          }
        );
      },
      /ZodError|Required|invalid/i
    );
  });
});
