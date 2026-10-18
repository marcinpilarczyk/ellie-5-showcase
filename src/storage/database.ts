import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface DatabaseManagerOptions {
  dataDir?: string;
  appDbPath?: string;
  ledgerDbPath?: string;
}

/** ELLIE_DATA_DIR, defaulting to ~/.local/share/ellie. Keep it outside any cloud-synced folder. */
export function dataDir(): string {
  return process.env.ELLIE_DATA_DIR?.trim() || path.join(os.homedir(), '.local', 'share', 'ellie');
}

/**
 * Two SQLite files in one data directory: app.sqlite and ledger.sqlite. There are deliberately
 * no per-file path overrides: in v4 those pointed the new system at v2's databases.
 */
export class DatabaseManager {
  private appDbInstance: DatabaseSync | null = null;
  private ledgerDbInstance: DatabaseSync | null = null;
  public readonly appDbPath: string;
  public readonly ledgerDbPath: string;

  constructor(options?: DatabaseManagerOptions) {
    const dir = options?.dataDir || dataDir();
    this.appDbPath = options?.appDbPath || path.join(dir, 'app.sqlite');
    this.ledgerDbPath = options?.ledgerDbPath || path.join(dir, 'ledger.sqlite');

    for (const p of [this.appDbPath, this.ledgerDbPath]) {
      if (p !== ':memory:') fs.mkdirSync(path.dirname(p), { recursive: true });
    }
  }

  public getAppDb(): DatabaseSync {
    if (!this.appDbInstance) {
      this.appDbInstance = new DatabaseSync(this.appDbPath);
      this.configureDb(this.appDbInstance);
    }
    return this.appDbInstance;
  }

  public getLedgerDb(): DatabaseSync {
    if (!this.ledgerDbInstance) {
      this.ledgerDbInstance = new DatabaseSync(this.ledgerDbPath);
      this.configureDb(this.ledgerDbInstance);
    }
    return this.ledgerDbInstance;
  }

  private configureDb(db: DatabaseSync): void {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
  }

  public close(): void {
    if (this.appDbInstance) {
      this.appDbInstance.close();
      this.appDbInstance = null;
    }
    if (this.ledgerDbInstance) {
      this.ledgerDbInstance.close();
      this.ledgerDbInstance = null;
    }
  }
}
