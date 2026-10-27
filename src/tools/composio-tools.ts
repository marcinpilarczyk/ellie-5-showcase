import { z } from 'zod';
import { ToolDefinition, RunContext } from '../types/tool.js';
import { ComposioClient, inferComposioEffectClass } from '../integrations/composio/client.js';
import {
  ComposioAuthMode,
  ComposioInstalledTool,
  ComposioRepository,
  toRegisteredComposioToolName
} from '../storage/composio-repo.js';
import type { ToolDispatcher } from '../governance/dispatcher.js';

export function compactParametersSchema(schema: Record<string, unknown> | undefined | null): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }
  const result: Record<string, unknown> = {
    type: 'object'
  };
  if (Array.isArray((schema as any).required)) {
    result['required'] = (schema as any).required;
  }
  const compactProps: Record<string, unknown> = {};
  const props = (schema as any).properties;
  if (props && typeof props === 'object') {
    for (const [key, val] of Object.entries(props as Record<string, any>)) {
      if (val && typeof val === 'object') {
        const propObj: Record<string, unknown> = {
          type: val.type ?? 'string'
        };
        if (typeof val.description === 'string') {
          propObj['description'] = val.description.length > 120
            ? val.description.slice(0, 120)
            : val.description;
        }
        if (Array.isArray(val.enum)) {
          propObj['enum'] = val.enum;
        }
        compactProps[key] = propObj;
      }
    }
  }
  result['properties'] = compactProps;
  return result;
}

export function jsonSchemaPropertyToZod(prop: any): z.ZodTypeAny {
  if (!prop || typeof prop !== 'object') {
    return z.any();
  }
  const desc = typeof prop.description === 'string' ? prop.description : undefined;
  let schema: z.ZodTypeAny;

  if (Array.isArray(prop.enum) && prop.enum.length > 0 && prop.enum.every((v: any) => typeof v === 'string')) {
    schema = z.enum(prop.enum as [string, ...string[]]);
  } else {
    switch (prop.type) {
      case 'string':
        schema = z.string();
        break;
      case 'number':
      case 'integer':
        schema = z.number();
        break;
      case 'boolean':
        schema = z.boolean();
        break;
      case 'array':
        schema = z.array(jsonSchemaPropertyToZod(prop.items || { type: 'string' }));
        break;
      case 'object':
        schema = jsonSchemaToZodObject(prop);
        break;
      default:
        schema = z.string();
        break;
    }
  }

  return desc ? schema.describe(desc) : schema;
}

export function jsonSchemaToZodObject(schemaObj: any): z.ZodObject<any> {
  if (!schemaObj || typeof schemaObj !== 'object') {
    return z.object({}).passthrough();
  }
  const props = schemaObj.properties && typeof schemaObj.properties === 'object'
    ? schemaObj.properties
    : {};
  const requiredSet = new Set<string>(Array.isArray(schemaObj.required) ? schemaObj.required : []);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, propDef] of Object.entries<any>(props)) {
    const fieldZod = jsonSchemaPropertyToZod(propDef);
    shape[key] = requiredSet.has(key) ? fieldZod : fieldZod.optional();
  }

  return z.object(shape).passthrough();
}

export function buildDynamicComposioToolDefinition(
  installed: ComposioInstalledTool,
  client: ComposioClient,
  repo: ComposioRepository
): ToolDefinition {
  const registeredName = toRegisteredComposioToolName(installed.tool_slug);
  let parsedSchema: Record<string, any> = {};
  try {
    parsedSchema = JSON.parse(installed.parameters_schema_json || '{}');
  } catch {
    parsedSchema = {};
  }

  const zodSchema = jsonSchemaToZodObject(parsedSchema);

  return {
    name: registeredName,
    description: `[Composio: ${installed.toolkit_slug}] ${installed.description} (Slug: ${installed.tool_slug})`,
    effectClass: installed.effect_class,
    isAvailable: () => client.isConfigured() && Boolean(repo.getTool(installed.tool_slug)?.enabled),
    schema: zodSchema,
    execute: async (params: Record<string, any>) => {
      const current = repo.getTool(installed.tool_slug);
      if (!current || !current.enabled) {
        throw new Error(`[Security Refusal] Composio tool '${installed.tool_slug}' is no longer enabled.`);
      }

      let connectedAccountId = current.connected_account_id;

      // If the tool requires authentication and isn't marked READY yet, check/refresh toolkit connection first
      if (current.auth_mode !== 'NONE' && current.connection_status !== 'READY') {
        const setup = await client.setupToolkitConnection({
          toolkitSlug: current.toolkit_slug,
          authMode: current.auth_mode
        });
        repo.updateConnectionStatus(current.tool_slug, setup.status, {
          connectedAccountId: setup.connectedAccountId ?? current.connected_account_id,
          authRedirectUrl: setup.redirectUrl ?? null
        });
        if (setup.status !== 'READY') {
          return {
            status: 'SETUP_REQUIRED',
            toolSlug: current.tool_slug,
            toolkitSlug: current.toolkit_slug,
            connectionStatus: setup.status,
            redirectUrl: setup.redirectUrl,
            message: setup.message
          };
        }
        connectedAccountId = setup.connectedAccountId ?? connectedAccountId;
      }

      const execRes = await client.executeTool(current.tool_slug, params || {}, {
        connectedAccountId
      });

      if (!execRes.ok) {
        return {
          status: 'EXECUTION_FAILED',
          toolSlug: current.tool_slug,
          error: execRes.error || 'Composio tool execution failed.'
        };
      }

      if (current.pending_task) {
        repo.clearPendingTask(current.tool_slug);
      }

      return {
        status: 'SUCCESS',
        toolSlug: current.tool_slug,
        toolkitSlug: current.toolkit_slug,
        data: execRes.data
      };
    }
  };
}

export function registerInstalledComposioTools(
  dispatcher: ToolDispatcher,
  client: ComposioClient,
  repo: ComposioRepository
): ToolDefinition[] {
  const installed = repo.listInstalled(true);
  const defs: ToolDefinition[] = [];
  for (const item of installed) {
    const def = buildDynamicComposioToolDefinition(item, client, repo);
    dispatcher.upsertTool(def);
    defs.push(def);
  }
  return defs;
}

export interface ComposioToolsDeps {
  client: ComposioClient;
  repo: ComposioRepository;
  dispatcher: ToolDispatcher;
}

export function createComposioTools(deps: ComposioToolsDeps): ToolDefinition[] {
  const { client, repo, dispatcher } = deps;

  // Register any previously installed tools from SQLite
  registerInstalledComposioTools(dispatcher, client, repo);

  const tools: ToolDefinition[] = [];

  // 1. composio_search_tools (READ)
  tools.push({
    name: 'composio_search_tools',
    description:
      'Searches composio.dev for available free tools/integrations when Ellie cannot complete a task with her currently available tools. Returns tool slugs, auth requirements, parameter schemas, and installation status.',
    effectClass: 'READ',
    isAvailable: () => client.isConfigured(),
    schema: z.object({
      query: z.string().min(1).describe('Capability, service, or action to search for on Composio (e.g. "weather", "hackernews", "currency exchange", "github issues")'),
      toolkit: z.string().optional().describe('Optional toolkit/app slug filter (e.g. "github", "hackernews", "weather")'),
      freeOnly: z.boolean().optional().default(true).describe('Only return free tools (default: true)'),
      limit: z.number().int().min(1).max(15).optional().default(6).describe('Maximum number of matching tools to return')
    }),
    execute: async ({ query, toolkit, freeOnly, limit }) => {
      if (!client.isConfigured()) {
        return {
          status: 'UNCONFIGURED',
          message: 'COMPOSIO_API_KEY is not configured on this server.'
        };
      }

      try {
        const matches = await client.searchTools({
          query,
          toolkit,
          freeOnly: freeOnly ?? true,
          limit: limit ?? 6
        });

        const enriched = matches.map(m => {
          const existing = repo.getTool(m.toolSlug);
          return {
            toolSlug: m.toolSlug,
            registeredToolName: toRegisteredComposioToolName(m.toolSlug),
            toolkitSlug: m.toolkitSlug,
            displayName: m.displayName,
            description: m.description,
            authMode: m.authMode,
            isFree: m.isFree,
            pricingNote: m.pricingNote,
            effectClass: m.effectClass,
            parametersSchema: compactParametersSchema(m.parametersSchema),
            alreadyInstalled: Boolean(existing?.enabled),
            connectionStatus: existing?.connection_status ?? null
          };
        });

        return {
          status: 'SUCCESS',
          query,
          count: enriched.length,
          tools: enriched,
          nextStep: enriched.length > 0
            ? 'To install a free tool and finish the task, call composio_install_tool with the chosen toolSlug, reason, and pendingTask. It will be staged for owner approval and automatically installed, set up, and executed once approved.'
            : 'No matching free tools found on Composio for this query.'
        };
      } catch (err: any) {
        return {
          status: 'ERROR',
          query,
          error: err.message || String(err)
        };
      }
    }
  });

  // 2. composio_install_tool (CONSEQUENTIAL — stages approval card; when approved, installs, sets up, and triggers task completion)
  tools.push({
    name: 'composio_install_tool',
    description:
      'Proposes installing and setting up a free tool from composio.dev. Stages an approval card for the owner; once approved, installs the tool, configures its connection, registers it in Ellie, and resumes the pendingTask.',
    effectClass: 'CONSEQUENTIAL',
    isAvailable: () => client.isConfigured(),
    schema: z.object({
      toolSlug: z.string().min(1).describe('Exact Composio tool slug from composio_search_tools (e.g. "HACKERNEWS_GET_TOP_STORIES")'),
      toolkitSlug: z.string().optional().describe('Toolkit/app slug (e.g. "hackernews")'),
      displayName: z.string().optional().describe('Human-readable name of the tool'),
      description: z.string().optional().describe('What the tool does'),
      authMode: z.enum(['NONE', 'OAUTH2', 'API_KEY', 'BEARER_TOKEN', 'BASIC']).optional().describe('Authentication mode required by the tool'),
      reason: z.string().min(1).describe('Concise explanation of why this tool is needed'),
      pendingTask: z.string().min(1).describe('The exact user task/question Ellie should complete immediately after this tool is approved and installed'),
      authConfig: z.record(z.string(), z.any()).optional().describe('Optional auth configuration parameters if provided by the owner')
    }),
    execute: async (params) => {
      const slug = params.toolSlug.trim().toUpperCase();

      // Fetch authoritative catalog details from Composio when available
      let catalogTool = null;
      try {
        catalogTool = await client.getTool(slug);
      } catch {
        // Fall back to params passed from search step if single-tool endpoint is unavailable
      }

      if (catalogTool && !catalogTool.isFree) {
        throw new Error(`[Composio Refusal] Tool '${slug}' requires a paid plan (${catalogTool.pricingNote || 'not free'}). Only free Composio tools may be installed.`);
      }

      const toolkitSlug = (catalogTool?.toolkitSlug || params.toolkitSlug || slug.split('_')[0] || 'general').toLowerCase();
      const displayName = catalogTool?.displayName || params.displayName || slug;
      const description = catalogTool?.description || params.description || `Composio tool ${slug}`;
      const authMode: ComposioAuthMode = catalogTool?.authMode || params.authMode || 'NONE';
      let effectClass = inferComposioEffectClass(slug);
      if (catalogTool?.effectClass) {
        effectClass = catalogTool.effectClass;
      }
      const parametersSchema = catalogTool?.parametersSchema || { type: 'object', properties: {} };

      // Perform connection check / setup
      const setup = await client.setupToolkitConnection({
        toolkitSlug,
        authMode,
        authConfig: params.authConfig
      });

      const saved = repo.upsertTool({
        toolSlug: slug,
        toolkitSlug,
        displayName,
        description,
        authMode,
        isFree: true,
        effectClass,
        parametersSchema,
        connectedAccountId: setup.connectedAccountId ?? null,
        connectionStatus: setup.status,
        authRedirectUrl: setup.redirectUrl ?? null,
        pendingTask: params.pendingTask,
        enabled: true,
        installedBy: 'owner'
      });

      // Dynamically register the tool in ToolDispatcher so it is immediately usable in the next run
      const dynamicDef = buildDynamicComposioToolDefinition(saved, client, repo);
      dispatcher.upsertTool(dynamicDef);

      return {
        status: setup.status === 'READY' ? 'INSTALLED_AND_READY' : 'INSTALLED_PENDING_SETUP',
        toolSlug: saved.tool_slug,
        registeredToolName: dynamicDef.name,
        toolkitSlug: saved.toolkit_slug,
        displayName: saved.display_name,
        authMode: saved.auth_mode,
        connectionStatus: saved.connection_status,
        connectedAccountId: saved.connected_account_id,
        redirectUrl: saved.auth_redirect_url,
        pendingTask: saved.pending_task,
        message: setup.status === 'READY'
          ? `Installed and set up '${saved.tool_slug}' as '${dynamicDef.name}'. Ready to finish task: ${params.pendingTask}`
          : `Installed '${saved.tool_slug}' as '${dynamicDef.name}'. Setup note: ${setup.message}`
      };
    },
    verify: async (params, result) => {
      const slug = params.toolSlug.trim().toUpperCase();
      const registeredName = toRegisteredComposioToolName(slug);
      const inDb = repo.getTool(slug);
      const inDispatcher = dispatcher.getTool(registeredName);
      if (inDb && inDb.enabled === 1 && inDispatcher) {
        return {
          outcome: 'VERIFIED_SUCCESS',
          details: `Tool '${slug}' persisted in SQLite and registered as '${registeredName}' (${result?.connectionStatus || inDb.connection_status}).`
        };
      }
      return {
        outcome: 'FAILED_SAFE',
        details: `Tool '${slug}' could not be verified in database or dispatcher.`
      };
    }
  });

  // 3. composio_setup_tool (INTERNAL_REVERSIBLE_WRITE — completes or refreshes connection setup for an installed tool)
  tools.push({
    name: 'composio_setup_tool',
    description:
      'Completes, verifies, or updates authentication/connection setup for an already-installed Composio tool or toolkit.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    readsBackInline: true,
    isAvailable: () => client.isConfigured(),
    schema: z.object({
      toolSlug: z.string().min(1).describe('Installed Composio tool slug (e.g. "GITHUB_GET_REPO")'),
      authConfig: z.record(z.string(), z.any()).optional().describe('Optional authentication credentials or parameters to complete setup')
    }),
    execute: async ({ toolSlug, authConfig }) => {
      const slug = toolSlug.trim().toUpperCase();
      const installed = repo.getTool(slug);
      if (!installed || !installed.enabled) {
        throw new Error(`[Security Refusal] Tool '${slug}' is not installed. Propose installation with composio_install_tool first.`);
      }

      const setup = await client.setupToolkitConnection({
        toolkitSlug: installed.toolkit_slug,
        authMode: installed.auth_mode,
        authConfig
      });

      const updated = repo.updateConnectionStatus(slug, setup.status, {
        connectedAccountId: setup.connectedAccountId ?? installed.connected_account_id,
        authRedirectUrl: setup.redirectUrl ?? null
      });

      if (setup.status === 'READY') {
        repo.updateToolkitConnection(installed.toolkit_slug, 'READY', setup.connectedAccountId, null);
      }

      return {
        ok: setup.ok,
        toolSlug: slug,
        registeredToolName: toRegisteredComposioToolName(slug),
        toolkitSlug: installed.toolkit_slug,
        connectionStatus: updated?.connection_status ?? setup.status,
        connectedAccountId: updated?.connected_account_id ?? setup.connectedAccountId,
        redirectUrl: updated?.auth_redirect_url ?? setup.redirectUrl,
        pendingTask: updated?.pending_task,
        message: setup.message
      };
    }
  });

  // 4. composio_execute_tool (READ — executes an installed & approved Composio tool by slug)
  tools.push({
    name: 'composio_execute_tool',
    description:
      'Executes an installed Composio tool by its toolSlug and arguments. Only tools that have been approved and installed via composio_install_tool can be executed.',
    effectClass: 'READ',
    isAvailable: () => client.isConfigured(),
    schema: z.object({
      toolSlug: z.string().min(1).describe('Installed Composio tool slug (e.g. "HACKERNEWS_GET_TOP_STORIES")'),
      arguments: z.record(z.string(), z.any()).optional().default({}).describe('Input parameters for the Composio tool')
    }),
    execute: async ({ toolSlug, arguments: args }, context) => {
      const slug = toolSlug.trim().toUpperCase();
      const installed = repo.getTool(slug);
      if (!installed || !installed.enabled) {
        throw new Error(
          `[Security Refusal] Composio tool '${slug}' is not installed. Search with composio_search_tools and propose installation with composio_install_tool first.`
        );
      }

      const registeredName = toRegisteredComposioToolName(slug);
      let dynamicTool = dispatcher.getTool(registeredName);
      if (!dynamicTool) {
        dynamicTool = buildDynamicComposioToolDefinition(installed, client, repo);
        dispatcher.upsertTool(dynamicTool);
      }

      // If the installed tool itself is consequential, dispatch through ToolDispatcher so staging/approval applies
      if (installed.effect_class === 'CONSEQUENTIAL') {
        const scopedContext: RunContext = {
          ...context,
          toolGrant: {
            ...context.toolGrant,
            allowedToolNames: new Set([...context.toolGrant.allowedToolNames, registeredName]),
          },
        };
        return dispatcher.dispatch(registeredName, args || {}, scopedContext);
      }

      return dynamicTool.execute(args || {}, context);
    }
  });

  // 5. composio_list_installed (READ)
  tools.push({
    name: 'composio_list_installed',
    description: 'Lists all Composio tools currently installed and enabled on Ellie, along with their connection status.',
    effectClass: 'READ',
    isAvailable: () => client.isConfigured() || repo.listInstalled(true).length > 0,
    schema: z.object({}),
    execute: async () => {
      const list = repo.listInstalled(true).map(t => ({
        toolSlug: t.tool_slug,
        registeredToolName: toRegisteredComposioToolName(t.tool_slug),
        toolkitSlug: t.toolkit_slug,
        displayName: t.display_name,
        description: t.description,
        authMode: t.auth_mode,
        effectClass: t.effect_class,
        connectionStatus: t.connection_status,
        redirectUrl: t.auth_redirect_url,
        pendingTask: t.pending_task,
        installedAt: t.installed_at
      }));
      return {
        status: 'SUCCESS',
        count: list.length,
        tools: list
      };
    }
  });

  return tools;
}
