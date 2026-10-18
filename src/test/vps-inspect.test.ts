import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVpsInspectTool, redactSecrets } from '../tools/vps-inspect.js';
import { ToolExecutionContext } from '../types/tool.js';

const ctx: ToolExecutionContext = {
  runId: 'run_test',
  isInteractive: false,
  toolGrant: { allowedToolNames: new Set(['vps_inspect']), allowConsequential: false }
};

type Call = { file: string; args: string[] };

function fakeTool(stdout: string, calls: Call[] = []) {
  return createVpsInspectTool({
    platform: 'linux',
    runner: async (file, args) => {
      calls.push({ file, args });
      return { stdout, stderr: '', code: 0 };
    }
  });
}

describe('vps_inspect', () => {
  it('is a READ, non-evidence tool', () => {
    const tool = createVpsInspectTool();
    assert.equal(tool.effectClass, 'READ');
    assert.equal(tool.notEvidence, true);
  });

  it('refuses units outside the allowlist at the schema and in execute', async () => {
    const tool = fakeTool('');
    assert.equal(tool.schema.safeParse({ operation: 'logs', unit: 'ssh.service' }).success, false);
    await assert.rejects(() => tool.execute({ operation: 'logs', unit: 'ssh.service' }, ctx), /Security Refusal/);
  });

  it('rejects an operation that is not in the list (no free-form commands)', () => {
    const tool = fakeTool('');
    assert.equal(tool.schema.safeParse({ operation: 'exec', command: 'rm -rf /' }).success, false);
  });

  it('logs: builds a fixed journalctl argv and redacts secrets', async () => {
    const calls: Call[] = [];
    const tool = fakeTool(
      '2026-10-16T10:00:00 ellie boom SLACK_BOT_TOKEN=xoxb-1234567890-abcdefghij\n2026-10-16T10:00:01 ellie fine',
      calls
    );
    const res: any = await tool.execute(tool.schema.parse({ operation: 'logs', priority: 'err', since: '2 hours ago' }), ctx);
    assert.equal(calls[0].file, 'journalctl');
    assert.deepEqual(calls[0].args.slice(0, 4), ['--user', '-u', 'ellie.service', '-n']);
    assert.ok(calls[0].args.includes('-p') && calls[0].args.includes('err'));
    assert.ok(!res.log.includes('xoxb-1234567890'));
    assert.ok(res.log.includes('[REDACTED'));
  });

  it('logs: rejects a malformed since value', async () => {
    const tool = fakeTool('');
    await assert.rejects(
      () => tool.execute(tool.schema.parse({ operation: 'logs', since: '1 hour ago --output=json; id' }), ctx),
      /Invalid "since"/
    );
  });

  it('logs: filters by grep', async () => {
    const tool = fakeTool('a timeout here\nall good\nanother TIMEOUT');
    const res: any = await tool.execute(tool.schema.parse({ operation: 'logs', grep: 'timeout' }), ctx);
    assert.equal(res.lineCount, 2);
  });

  it('processes: surfaces zombie and blocked processes and redacts command lines', async () => {
    const out = [
      '  PID  PPID USER         STAT     ELAPSED %CPU %MEM   RSS COMMAND',
      '  101     1 ellie        Rl      01:00:00 90.0  5.0 90000 node dist/index.js --api-key sk-abcdefghijklmnopqrstuvwx',
      '  202   101 ellie        Z       00:10:00  0.0  0.0     0 [chrome] <defunct>',
      '  303     1 ellie        D       00:20:00  0.0  0.1  1000 sqlite-worker'
    ].join('\n');
    const calls: Call[] = [];
    const tool = fakeTool(out, calls);
    const res: any = await tool.execute(tool.schema.parse({ operation: 'processes' }), ctx);
    assert.equal(calls[0].file, 'ps');
    assert.equal(res.totalProcesses, 3);
    assert.equal(res.zombieOrBlockedProcesses.length, 2);
    assert.ok(!JSON.stringify(res).includes('sk-abcdefghijklmnop'));
  });

  it('is unavailable off Linux instead of running anything', async () => {
    let ran = false;
    const tool = createVpsInspectTool({ platform: 'win32', runner: async () => { ran = true; return { stdout: '', stderr: '', code: 0 }; } });
    const res: any = await tool.execute(tool.schema.parse({ operation: 'resources' }), ctx);
    assert.equal(res.available, false);
    assert.equal(ran, false);
  });

  describe('redactSecrets', () => {
    it('masks common token shapes', () => {
      const text = 'Authorization: Bearer abcdefghijklmnop1234 and password=hunter2 and https://u:pw@host/x and AIzaSyA1234567890123456789012';
      const out = redactSecrets(text);
      assert.ok(!out.includes('abcdefghijklmnop1234'));
      assert.ok(!out.includes('hunter2'));
      assert.ok(!out.includes(':pw@'));
      assert.ok(!out.includes('AIzaSyA1234567890'));
    });
  });
});
