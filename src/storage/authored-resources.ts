import { DatabaseSync } from 'node:sqlite';

/**
 * Resources (Docs, files) Ellie created with text she wrote. Reading one back is reading her own
 * words, so it never grounds a claim in owner text (the dispatcher checks this for any tool that
 * declares readsResource).
 */
export class AuthoredResources {
  constructor(private readonly db: DatabaseSync) {}

  public record(resourceId: string, toolName: string, runId?: string): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO authored_resources (resource_id, tool_name, run_id, created_at) VALUES (?, ?, ?, ?)'
    ).run(resourceId, toolName, runId ?? null, new Date().toISOString());
  }

  public has(resourceId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM authored_resources WHERE resource_id = ?').get(resourceId));
  }
}
