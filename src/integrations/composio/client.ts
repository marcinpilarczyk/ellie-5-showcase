import { EffectClass } from '../../types/tool.js';
import { ComposioAuthMode, ComposioConnectionStatus } from '../../storage/composio-repo.js';

export interface ComposioCatalogTool {
  toolSlug: string;
  toolkitSlug: string;
  displayName: string;
  description: string;
  authMode: ComposioAuthMode;
  isFree: boolean;
  pricingNote?: string;
  effectClass: EffectClass;
  parametersSchema: Record<string, any>;
}

export interface ComposioSetupResult {
  ok: boolean;
  status: ComposioConnectionStatus;
  connectedAccountId?: string;
  redirectUrl?: string;
  message: string;
}

export interface ComposioExecuteResult {
  ok: boolean;
  data?: any;
  error?: string;
}

export interface ComposioClientOptions {
  apiKey?: string;
  baseUrl?: string;
  userId?: string;
  fetchFn?: typeof fetch;
}

const READ_VERB_PATTERN = /(?:^|_)(GET|LIST|SEARCH|FIND|FETCH|READ|CHECK|VERIFY|INSPECT|LOOKUP|QUERY|PARSE|CONVERT|CALCULATE|ANALYZE|RESOLVE|BROWSE|SUMMARIZE|EXTRACT|VALIDATE|PING|WHOIS|DNS)(?:_|$)/i;
const CONSEQUENTIAL_VERB_PATTERN = /(?:^|_)(SEND|DELETE|REMOVE|DROP|CREATE|POST|PUBLISH|UPDATE|PATCH|PUT|EXECUTE|RUN|PAY|TRANSFER|INVITE|CHARGE|DEPLOY|ARCHIVE|CANCEL|REVOKE|MERGE|CLOSE|ASSIGN|COMMENT|REPLY|FORWARD)(?:_|$)/i;

export function inferComposioEffectClass(toolSlug: string, rawItem?: Record<string, any>): EffectClass {
  const tags: string[] = Array.isArray(rawItem?.tags) ? rawItem.tags.map((t: any) => String(t).toLowerCase()) : [];
  if (tags.includes('destructive') || tags.includes('write') || tags.includes('consequential')) {
    return 'CONSEQUENTIAL';
  }
  if (tags.includes('read') || tags.includes('readonly') || tags.includes('read-only')) {
    return 'READ';
  }
  if (CONSEQUENTIAL_VERB_PATTERN.test(toolSlug)) {
    return 'CONSEQUENTIAL';
  }
  if (READ_VERB_PATTERN.test(toolSlug)) {
    return 'READ';
  }
  return 'CONSEQUENTIAL';
}

export function inferComposioAuthMode(rawItem?: Record<string, any>): ComposioAuthMode {
  if (!rawItem) return 'NONE';
  if (rawItem.no_auth === true || rawItem.noAuth === true) return 'NONE';

  const schemesRaw = rawItem.auth_schemes || rawItem.authSchemes || rawItem.toolkit?.auth_schemes || rawItem.app?.auth_schemes;
  const schemes: string[] = Array.isArray(schemesRaw)
    ? schemesRaw.map((s: any) => String(typeof s === 'string' ? s : (s?.mode || s?.auth_mode || s?.type || '')).toUpperCase()).filter(Boolean)
    : (typeof schemesRaw === 'string' ? [schemesRaw.toUpperCase()] : []);

  const singleMode = String(rawItem.auth_mode || rawItem.authMode || '').toUpperCase();
  if (singleMode) schemes.unshift(singleMode);

  if (schemes.length === 0 || schemes.includes('NONE') || schemes.includes('NO_AUTH')) {
    return 'NONE';
  }
  if (schemes.some(s => s.includes('OAUTH'))) return 'OAUTH2';
  if (schemes.some(s => s.includes('BEARER'))) return 'BEARER_TOKEN';
  if (schemes.some(s => s.includes('BASIC'))) return 'BASIC';
  if (schemes.some(s => s.includes('API_KEY') || s.includes('APIKEY') || s.includes('KEY'))) return 'API_KEY';
  return 'NONE';
}

export function inferComposioIsFree(rawItem?: Record<string, any>, authMode?: ComposioAuthMode): { isFree: boolean; pricingNote: string } {
  if (!rawItem) return { isFree: true, pricingNote: 'Free tool' };

  const paidFlags = [
    rawItem.is_paid,
    rawItem.isPaid,
    rawItem.requires_paid_plan,
    rawItem.toolkit?.is_paid,
    rawItem.pricing?.is_paid
  ];
  if (paidFlags.some(f => f === true)) {
    return { isFree: false, pricingNote: 'Paid plan or paid API required' };
  }

  const tier = String(rawItem.pricing_tier || rawItem.tier || rawItem.toolkit?.pricing_tier || rawItem.pricing || '').toLowerCase();
  if (tier === 'paid' || tier === 'enterprise' || tier === 'premium') {
    return { isFree: false, pricingNote: `Requires ${tier} plan` };
  }

  const resolvedAuth = authMode ?? inferComposioAuthMode(rawItem);
  if (resolvedAuth === 'NONE') {
    return { isFree: true, pricingNote: 'Free (no authentication required)' };
  }
  if (resolvedAuth === 'OAUTH2') {
    return { isFree: true, pricingNote: 'Free via Composio OAuth connection' };
  }
  return { isFree: true, pricingNote: 'Free via Composio integration' };
}

export function normalizeComposioTool(raw: Record<string, any>): ComposioCatalogTool {
  const toolSlug = String(raw.slug || raw.name || raw.enum || raw.toolSlug || raw.action_name || '').trim().toUpperCase();
  const toolkitSlug = String(
    raw.toolkit?.slug || raw.toolkit_slug || raw.toolkitSlug || raw.appName || raw.appKey || raw.app_name || toolSlug.split('_')[0] || 'general'
  ).trim().toLowerCase();
  const displayName = String(raw.display_name || raw.displayName || raw.title || raw.name || toolSlug).trim();
  const description = String(raw.description || raw.summary || `Composio ${toolkitSlug} tool (${toolSlug})`).trim();
  const authMode = inferComposioAuthMode(raw);
  const { isFree, pricingNote } = inferComposioIsFree(raw, authMode);
  const effectClass = (raw.effectClass as EffectClass) || inferComposioEffectClass(toolSlug, raw);

  const rawParams = raw.input_parameters || raw.parameters || raw.parametersSchema || raw.schema || {};
  const parametersSchema = (rawParams && typeof rawParams === 'object')
    ? rawParams
    : { type: 'object', properties: {} };

  return {
    toolSlug,
    toolkitSlug,
    displayName,
    description,
    authMode,
    isFree,
    pricingNote,
    effectClass,
    parametersSchema
  };
}

export class ComposioClient {
  private readonly customFetch?: typeof fetch;
  private readonly explicitApiKey?: string;
  private readonly explicitBaseUrl?: string;
  private readonly explicitUserId?: string;

  constructor(options?: ComposioClientOptions) {
    this.explicitApiKey = options?.apiKey;
    this.explicitBaseUrl = options?.baseUrl;
    this.explicitUserId = options?.userId;
    this.customFetch = options?.fetchFn;
  }

  public get apiKey(): string {
    return (this.explicitApiKey ?? process.env.COMPOSIO_API_KEY ?? '').trim();
  }

  public get baseUrl(): string {
    return (this.explicitBaseUrl ?? process.env.COMPOSIO_BASE_URL ?? 'https://backend.composio.dev/api/v3.1').trim().replace(/\/+$/, '');
  }

  public get userId(): string {
    return (this.explicitUserId ?? process.env.COMPOSIO_USER_ID ?? process.env.COMPOSIO_ENTITY_ID ?? 'default').trim();
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey) || Boolean(this.customFetch);
  }

  private get fetchImpl(): typeof fetch {
    return this.customFetch ?? fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    if (this.apiKey) {
      h['x-api-key'] = this.apiKey;
    }
    return h;
  }

  /**
   * Searches Composio's catalog for available tools matching the query/toolkit.
   * Filters to free tools by default.
   */
  public async searchTools(opts: {
    query: string;
    toolkit?: string;
    freeOnly?: boolean;
    limit?: number;
  }): Promise<ComposioCatalogTool[]> {
    if (!this.isConfigured()) {
      throw new Error('COMPOSIO_API_KEY is not configured.');
    }

    const freeOnly = opts.freeOnly ?? true;
    const limit = Math.min(20, Math.max(1, opts.limit ?? 8));
    const params = new URLSearchParams();
    if (opts.query.trim()) params.set('search', opts.query.trim());
    if (opts.toolkit?.trim()) params.set('toolkit_slug', opts.toolkit.trim().toLowerCase());
    params.set('limit', String(limit * 2));

    const url = `${this.baseUrl}/tools?${params.toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const resp = await this.fetchImpl(url, {
        method: 'GET',
        headers: this.headers(),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`Composio catalog search returned HTTP ${resp.status}${errText ? `: ${errText.slice(0, 200)}` : ''}`);
      }

      const json = (await resp.json()) as any;
      const rawItems: any[] = Array.isArray(json)
        ? json
        : (Array.isArray(json?.items) ? json.items : (Array.isArray(json?.data) ? json.data : (Array.isArray(json?.tools) ? json.tools : [])));

      const normalized = rawItems
        .map(item => normalizeComposioTool(item))
        .filter(t => Boolean(t.toolSlug));

      const filtered = freeOnly ? normalized.filter(t => t.isFree) : normalized;
      return filtered.slice(0, limit);
    } catch (err: any) {
      clearTimeout(timer);
      throw err;
    }
  }

  /**
   * Fetches full metadata and input parameter schema for a single Composio tool slug.
   */
  public async getTool(toolSlug: string): Promise<ComposioCatalogTool | null> {
    if (!this.isConfigured()) {
      throw new Error('COMPOSIO_API_KEY is not configured.');
    }

    const slug = toolSlug.trim().toUpperCase();
    const url = `${this.baseUrl}/tools/${encodeURIComponent(slug)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const resp = await this.fetchImpl(url, {
        method: 'GET',
        headers: this.headers(),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (resp.status === 404) return null;
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`Composio getTool(${slug}) returned HTTP ${resp.status}${errText ? `: ${errText.slice(0, 200)}` : ''}`);
      }

      const json = (await resp.json()) as any;
      const item = json?.data && typeof json.data === 'object' && !Array.isArray(json.data) ? json.data : json;
      if (!item || typeof item !== 'object') return null;
      return normalizeComposioTool({ ...item, slug: item.slug || item.name || slug });
    } catch (err: any) {
      clearTimeout(timer);
      throw err;
    }
  }

  /**
   * Checks if a toolkit is already connected or sets up a connection in Composio.
   * Tools with authMode === 'NONE' require no account and are immediately READY.
   */
  public async setupToolkitConnection(opts: {
    toolkitSlug: string;
    authMode: ComposioAuthMode;
    authConfig?: Record<string, any>;
  }): Promise<ComposioSetupResult> {
    const toolkit = opts.toolkitSlug.trim().toLowerCase();
    if (opts.authMode === 'NONE') {
      return {
        ok: true,
        status: 'READY',
        message: `Toolkit '${toolkit}' requires no authentication and is ready to use immediately.`
      };
    }

    if (!this.isConfigured()) {
      return {
        ok: false,
        status: 'FAILED',
        message: 'COMPOSIO_API_KEY is not configured.'
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      // 1. Check existing active connected accounts for this toolkit
      const listUrl = `${this.baseUrl}/connected_accounts?toolkit_slug=${encodeURIComponent(toolkit)}&user_id=${encodeURIComponent(this.userId)}`;
      const listResp = await this.fetchImpl(listUrl, {
        method: 'GET',
        headers: this.headers(),
        signal: controller.signal
      });

      if (listResp.ok) {
        const listJson = (await listResp.json()) as any;
        const accounts: any[] = Array.isArray(listJson)
          ? listJson
          : (Array.isArray(listJson?.items) ? listJson.items : (Array.isArray(listJson?.data) ? listJson.data : []));
        const active = accounts.find(a => {
          const st = String(a?.status || a?.state || '').toUpperCase();
          return st === 'ACTIVE' || st === 'CONNECTED' || st === 'READY';
        });
        if (active) {
          clearTimeout(timer);
          const id = String(active.id || active.nanoid || active.connectedAccountId || '');
          return {
            ok: true,
            status: 'READY',
            connectedAccountId: id || undefined,
            message: `Existing active Composio connection found for '${toolkit}'${id ? ` (${id})` : ''}.`
          };
        }
      }

      // 2. Initiate connection or link session
      const createUrl = opts.authConfig && Object.keys(opts.authConfig).length > 0
        ? `${this.baseUrl}/connected_accounts`
        : `${this.baseUrl}/connected_accounts/link`;

      const createBody: Record<string, any> = {
        toolkit_slug: toolkit,
        toolkit: toolkit,
        user_id: this.userId,
        ...(opts.authConfig ? { auth_config: opts.authConfig, credentials: opts.authConfig } : {})
      };

      const createResp = await this.fetchImpl(createUrl, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(createBody),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        return {
          ok: false,
          status: 'NEEDS_AUTH',
          message: `Toolkit '${toolkit}' requires authentication setup in Composio (HTTP ${createResp.status}${errText ? `: ${errText.slice(0, 140)}` : ''}).`
        };
      }

      const createJson = (await createResp.json()) as any;
      const data = createJson?.data && typeof createJson.data === 'object' ? createJson.data : createJson;
      const connectedAccountId = String(data?.id || data?.nanoid || data?.connected_account_id || data?.connectedAccountId || '') || undefined;
      const redirectUrl = String(data?.redirect_url || data?.redirectUrl || data?.connect_link || data?.link || '') || undefined;
      const statusStr = String(data?.status || '').toUpperCase();

      if (redirectUrl && statusStr !== 'ACTIVE' && statusStr !== 'CONNECTED') {
        return {
          ok: true,
          status: 'PENDING_AUTH',
          connectedAccountId,
          redirectUrl,
          message: `Connection link created for '${toolkit}'. Authorize at: ${redirectUrl}`
        };
      }

      return {
        ok: true,
        status: 'READY',
        connectedAccountId,
        message: `Toolkit '${toolkit}' connected and ready${connectedAccountId ? ` (${connectedAccountId})` : ''}.`
      };
    } catch (err: any) {
      clearTimeout(timer);
      return {
        ok: false,
        status: 'NEEDS_AUTH',
        message: `Failed to set up '${toolkit}' connection: ${err.message}`
      };
    }
  }

  /**
   * Executes a Composio tool by slug with the provided arguments.
   */
  public async executeTool(
    toolSlug: string,
    args: Record<string, any>,
    opts?: { connectedAccountId?: string | null; userId?: string }
  ): Promise<ComposioExecuteResult> {
    if (!this.isConfigured()) {
      return { ok: false, error: 'COMPOSIO_API_KEY is not configured.' };
    }

    const slug = toolSlug.trim().toUpperCase();
    const url = `${this.baseUrl}/tools/execute/${encodeURIComponent(slug)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    const payload: Record<string, any> = {
      arguments: args || {},
      user_id: opts?.userId || this.userId
    };
    if (opts?.connectedAccountId) {
      payload.connected_account_id = opts.connectedAccountId;
    }

    try {
      const resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timer);

      const json = (await resp.json().catch(() => null)) as any;

      if (!resp.ok) {
        const errMsg = json?.error?.message || json?.error || json?.message || `Composio execute returned HTTP ${resp.status}`;
        return { ok: false, error: typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg) };
      }

      if (json && json.success === false) {
        const errMsg = json.error?.message || json.error || 'Composio tool execution reported failure.';
        return { ok: false, error: typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg) };
      }

      const data = json?.data?.response_data ?? json?.data ?? json?.result ?? json;
      return { ok: true, data };
    } catch (err: any) {
      clearTimeout(timer);
      return { ok: false, error: err.message || String(err) };
    }
  }
}
