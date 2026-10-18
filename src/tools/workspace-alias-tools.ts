import { z } from 'zod';
import { ToolDefinition } from '../types/tool.js';
import { WorkspaceAliasRepository } from '../storage/workspace-alias-repo.js';

export function createWorkspaceAliasTools(aliasRepo: WorkspaceAliasRepository): ToolDefinition[] {
  const workspaceAliasManage: ToolDefinition = {
    name: 'workspace_alias_manage',
    description: 'Dynamic registry of Google Doc/Sheet IDs, URLs, and tracker aliases (job_tracker, advisory_tracker, claims_bank_doc, config_doc, professional_record_doc). Granted strictly to INTERACTIVE_SLACK runs.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: z.object({
      action: z.enum(['list', 'set', 'get', 'delete']).describe('Action on workspace alias registry'),
      alias_key: z.string().optional().describe('Alias key (e.g. "job_tracker", "advisory_tracker", "claims_bank_doc", "config_doc", "professional_record_doc")'),
      resource_id_or_url: z.string().optional().describe('Google Docs / Sheets URL or raw resource ID (automatically parses URL)'),
      name: z.string().optional().describe('Human friendly name (e.g. "Job Tracker")'),
      resource_type: z.enum(['sheet', 'doc', 'drive_folder']).optional().describe('Resource type override')
    }),
    execute: async (args) => {
      switch (args.action) {
        case 'list': {
          const aliases = aliasRepo.listAliases();
          return {
            count: aliases.length,
            aliases
          };
        }

        case 'get': {
          if (!args.alias_key) throw new Error('alias_key is required for get.');
          const alias = aliasRepo.getAlias(args.alias_key);
          if (!alias) throw new Error(`Alias '${args.alias_key}' not found.`);
          return { alias };
        }

        case 'set': {
          if (!args.alias_key || !args.resource_id_or_url) {
            throw new Error('alias_key and resource_id_or_url are required to set an alias.');
          }
          const record = aliasRepo.setAlias(
            args.alias_key,
            args.resource_id_or_url,
            args.name,
            args.resource_type
          );
          return {
            status: 'set',
            alias: record,
            message: `Updated alias '${args.alias_key}' -> ID ${record.resource_id} (${record.name}).`
          };
        }

        case 'delete': {
          if (!args.alias_key) throw new Error('alias_key is required for delete.');
          const ok = aliasRepo.deleteAlias(args.alias_key);
          if (!ok) throw new Error(`Alias '${args.alias_key}' not found.`);
          return { status: 'deleted', alias_key: args.alias_key };
        }
      }
    },
    verify: async (params) => {
      if (params.action === 'set') {
        const a = aliasRepo.getAlias(params.alias_key!);
        return {
          outcome: a !== null ? 'VERIFIED_SUCCESS' : 'FAILED_SAFE',
          details: `Alias '${params.alias_key}' mapped to ${a?.resource_id}.`
        };
      }
      return { outcome: 'VERIFIED_SUCCESS' };
    }
  };

  return [workspaceAliasManage];
}
