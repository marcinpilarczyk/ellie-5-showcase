import { DatabaseSync } from 'node:sqlite';
import { EffectClass } from '../types/tool.js';

export type ComposioAuthMode = 'NONE' | 'OAUTH2' | 'API_KEY' | 'BEARER_TOKEN' | 'BASIC';
export type ComposioConnectionStatus = 'READY' | 'NEEDS_AUTH' | 'PENDING_AUTH' | 'FAILED';

export interface ComposioInstalledTool {
  tool_slug: string;
  toolkit_slug: string;
  display_name: string;
  description: string;
  auth_mode: ComposioAuthMode;
  is_free: number;
  effect_class: EffectClass;
  parameters_schema_json: string;
  connected_account_id: string | null;
  connection_status: ComposioConnectionStatus;
  auth_redirect_url: string | null;
  pending_task: string | null;
  enabled: number;
  installed_by: string;
  installed_at: string;
  updated_at: string;
}

export interface ComposioInstalledToolInput {
  toolSlug: string;
  toolkitSlug: string;
  displayName: string;
  description: string;
  authMode?: ComposioAuthMode;
  isFree?: boolean;
  effectClass?: EffectClass;
  parametersSchema?: Record<string, any>;
  connectedAccountId?: string | null;
  connectionStatus?: ComposioConnectionStatus;
  authRedirectUrl?: string | null;
  pendingTask?: string | null;
  enabled?: boolean;
  installedBy?: string;
}

export function toRegisteredComposioToolName(toolSlug: string): string {
  const clean = toolSlug.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return clean.startsWith('composio_') ? clean : `composio_${clean}`;
}

export class ComposioRepository {
  constructor(private readonly db: DatabaseSync) {}

  public upsertTool(input: ComposioInstalledToolInput): ComposioInstalledTool {
    const slug = input.toolSlug.trim().toUpperCase();
    const toolkit = (input.toolkitSlug || slug.split('_')[0] || 'general').trim().toLowerCase();
    const now = new Date().toISOString();
    const existing = this.getTool(slug);

    const authMode: ComposioAuthMode = input.authMode || existing?.auth_mode || 'NONE';
    const isFree = input.isFree !== undefined ? (input.isFree ? 1 : 0) : (existing?.is_free ?? 1);
    const effectClass: EffectClass = input.effectClass || existing?.effect_class || 'READ';
    const schemaJson = input.parametersSchema
      ? JSON.stringify(input.parametersSchema)
      : (existing?.parameters_schema_json || '{}');
    const connectedAccountId = input.connectedAccountId !== undefined
      ? input.connectedAccountId
      : (existing?.connected_account_id ?? null);
    const connectionStatus: ComposioConnectionStatus = input.connectionStatus
      || existing?.connection_status
      || (authMode === 'NONE' || connectedAccountId ? 'READY' : 'NEEDS_AUTH');
    const authRedirectUrl = input.authRedirectUrl !== undefined
      ? input.authRedirectUrl
      : (existing?.auth_redirect_url ?? null);
    const pendingTask = input.pendingTask !== undefined
      ? input.pendingTask
      : (existing?.pending_task ?? null);
    const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : 1;
    const installedBy = input.installedBy || existing?.installed_by || 'owner';
    const installedAt = existing?.installed_at || now;

    this.db.prepare(`
      INSERT INTO composio_tools (
        tool_slug, toolkit_slug, display_name, description,
        auth_mode, is_free, effect_class, parameters_schema_json,
        connected_account_id, connection_status, auth_redirect_url,
        pending_task, enabled, installed_by, installed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tool_slug) DO UPDATE SET
        toolkit_slug = excluded.toolkit_slug,
        display_name = excluded.display_name,
        description = excluded.description,
        auth_mode = excluded.auth_mode,
        is_free = excluded.is_free,
        effect_class = excluded.effect_class,
        parameters_schema_json = excluded.parameters_schema_json,
        connected_account_id = excluded.connected_account_id,
        connection_status = excluded.connection_status,
        auth_redirect_url = excluded.auth_redirect_url,
        pending_task = excluded.pending_task,
        enabled = excluded.enabled,
        installed_by = excluded.installed_by,
        updated_at = excluded.updated_at
    `).run(
      slug,
      toolkit,
      input.displayName.trim() || slug,
      input.description.trim() || `Composio tool ${slug}`,
      authMode,
      isFree,
      effectClass,
      schemaJson,
      connectedAccountId,
      connectionStatus,
      authRedirectUrl,
      pendingTask,
      enabled,
      installedBy,
      installedAt,
      now
    );

    return this.getTool(slug)!;
  }

  public getTool(toolSlug: string): ComposioInstalledTool | null {
    const slug = toolSlug.trim().toUpperCase();
    const row = this.db.prepare('SELECT * FROM composio_tools WHERE tool_slug = ?').get(slug);
    return row ? (row as unknown as ComposioInstalledTool) : null;
  }

  public listInstalled(onlyEnabled = true): ComposioInstalledTool[] {
    if (onlyEnabled) {
      return this.db.prepare('SELECT * FROM composio_tools WHERE enabled = 1 ORDER BY tool_slug ASC').all() as unknown as ComposioInstalledTool[];
    }
    return this.db.prepare('SELECT * FROM composio_tools ORDER BY tool_slug ASC').all() as unknown as ComposioInstalledTool[];
  }

  public listByToolkit(toolkitSlug: string): ComposioInstalledTool[] {
    return this.db.prepare('SELECT * FROM composio_tools WHERE toolkit_slug = ? ORDER BY tool_slug ASC')
      .all(toolkitSlug.trim().toLowerCase()) as unknown as ComposioInstalledTool[];
  }

  public updateConnectionStatus(
    toolSlug: string,
    status: ComposioConnectionStatus,
    opts?: {
      connectedAccountId?: string | null;
      authRedirectUrl?: string | null;
      pendingTask?: string | null;
    }
  ): ComposioInstalledTool | null {
    const existing = this.getTool(toolSlug);
    if (!existing) return null;

    const now = new Date().toISOString();
    const connectedAccountId = opts?.connectedAccountId !== undefined ? opts.connectedAccountId : existing.connected_account_id;
    const authRedirectUrl = opts?.authRedirectUrl !== undefined ? opts.authRedirectUrl : existing.auth_redirect_url;
    const pendingTask = opts?.pendingTask !== undefined ? opts.pendingTask : existing.pending_task;

    this.db.prepare(`
      UPDATE composio_tools
      SET connection_status = ?, connected_account_id = ?, auth_redirect_url = ?, pending_task = ?, updated_at = ?
      WHERE tool_slug = ?
    `).run(status, connectedAccountId, authRedirectUrl, pendingTask, now, existing.tool_slug);

    return this.getTool(existing.tool_slug);
  }

  public updateToolkitConnection(
    toolkitSlug: string,
    status: ComposioConnectionStatus,
    connectedAccountId?: string | null,
    authRedirectUrl?: string | null
  ): number {
    const now = new Date().toISOString();
    const res = this.db.prepare(`
      UPDATE composio_tools
      SET connection_status = ?,
          connected_account_id = COALESCE(?, connected_account_id),
          auth_redirect_url = ?,
          updated_at = ?
      WHERE toolkit_slug = ?
    `).run(status, connectedAccountId ?? null, authRedirectUrl ?? null, now, toolkitSlug.trim().toLowerCase());
    return Number(res.changes ?? 0);
  }

  public clearPendingTask(toolSlug: string): void {
    const slug = toolSlug.trim().toUpperCase();
    this.db.prepare('UPDATE composio_tools SET pending_task = NULL, updated_at = ? WHERE tool_slug = ?')
      .run(new Date().toISOString(), slug);
  }

  public disableTool(toolSlug: string): boolean {
    const slug = toolSlug.trim().toUpperCase();
    const res = this.db.prepare('UPDATE composio_tools SET enabled = 0, updated_at = ? WHERE tool_slug = ?')
      .run(new Date().toISOString(), slug);
    return Number(res.changes ?? 0) > 0;
  }
}
