import { z } from 'zod';
import { ToolDefinition } from '../types/tool.js';
import { SpaceRepository, SpaceCategory } from '../storage/space-repo.js';

export function createSpaceTools(spaceRepo: SpaceRepository): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // 1. Publish or update a space
  tools.push({
    name: 'space_publish',
    description: 'Publishes or updates an interactive web space (visual report, research radar, analytics dashboard, or tracking table) hosted directly on Ellie\'s VPS. Use this when complex research, multi-dimensional comparisons, accounting/ad analytics, or project radars are better visualized as an interactive web page than a plain Slack message. Returns the live URL path /spaces/<slug>.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: z.object({
      slug: z.string().describe('URL slug for the space (e.g. "q4-prospecting-radar", "ad-performance-w42", "accounting-radar"). Lowercase letters, numbers, hyphens only.'),
      title: z.string().describe('Human-readable title of the space (e.g. "Q4 Advisory Prospecting Radar", "Ad Performance Breakdown — W42")'),
      description: z.string().optional().describe('Short summary of what this space covers and key findings'),
      category: z.enum(['report', 'dashboard', 'radar', 'tracker', 'memo']).optional().default('report').describe('Type of space (report, dashboard, radar, tracker, memo)'),
      htmlContent: z.string().describe('Complete, self-contained HTML document including inline styles and optional client scripts. Ensure clean typography, dark-friendly or modern styling, and mobile-friendly layout.')
    }),
    execute: async (params, context) => {
      const cleanSlug = params.slug.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
      if (!cleanSlug) throw new Error('Invalid or empty slug');

      const space = spaceRepo.upsert({
        slug: cleanSlug,
        title: params.title.trim(),
        description: params.description?.trim() || null,
        category: params.category as SpaceCategory,
        created_by: 'ellie',
        trigger_type: context.isInteractive ? 'slack' : 'routine',
        run_id: context.runId,
        status: 'active',
        htmlContent: params.htmlContent
      });

      const urlPath = `/spaces/${space.slug}`;
      return {
        ok: true,
        slug: space.slug,
        title: space.title,
        url: urlPath,
        category: space.category,
        message: `Published space "${space.title}" at ${urlPath}`
      };
    },
    verify: async (params) => {
      const cleanSlug = params.slug.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
      const space = spaceRepo.get(cleanSlug);
      const content = spaceRepo.getContent(cleanSlug);
      if (space && content && content.length > 0) {
        return {
          outcome: 'VERIFIED_SUCCESS',
          details: `Space ${cleanSlug} confirmed with ${content.length} bytes on disk.`
        };
      }
      return {
        outcome: 'FAILED_SAFE',
        details: `Space ${cleanSlug} missing or content empty.`
      };
    }
  });

  // 2. List spaces
  tools.push({
    name: 'space_list',
    description: 'Lists published web spaces hosted on Ellie\'s VPS. Useful for finding existing reports, radars, and dashboards before updating or referencing them.',
    effectClass: 'READ',
    schema: z.object({
      category: z.string().optional().describe('Optional filter by category (report, dashboard, radar, tracker, memo)'),
      search: z.string().optional().describe('Optional search query matching title, slug or description'),
      limit: z.number().optional().default(20).describe('Maximum number of spaces to return')
    }),
    execute: async (params) => {
      const spaces = spaceRepo.list({
        status: 'active',
        category: params.category,
        search: params.search,
        limit: params.limit
      });
      return {
        count: spaces.length,
        spaces: spaces.map(s => ({
          slug: s.slug,
          title: s.title,
          description: s.description,
          category: s.category,
          url: `/spaces/${s.slug}`,
          updated_at: s.updated_at
        }))
      };
    }
  });

  return tools;
}
