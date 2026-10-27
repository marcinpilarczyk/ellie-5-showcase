import { z } from 'zod';
import { ToolDefinition } from '../types/tool.js';
import { REVIEWED_BASELINE } from '../governance/reviewed-baseline.js';
import type { CostRepository } from '../storage/cost-repo.js';

export function createApifyTools(costRepo?: CostRepository): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const token = process.env.APIFY_API_TOKEN?.trim();
  const profileActor = process.env.APIFY_LINKEDIN_PROFILE_ACTOR?.trim() || 'curious_coder~linkedin-profile-scraper';
  const postsActor = process.env.APIFY_LINKEDIN_POSTS_ACTOR?.trim() || 'lightmoon~linkedin-profile-posts-scraper';
  const baseUrl = 'https://api.apify.com/v2/acts';
  const maxDailyCalls = parseInt(process.env.ELLIE_APIFY_MAX_DAILY_CALLS || '25', 10);

  const checkSpendCap = (): { allowed: boolean; message?: string } => {
    if (!costRepo) return { allowed: true };
    const callsToday = costRepo.countCallsSince('apify', 1);
    if (callsToday >= maxDailyCalls) {
      return {
        allowed: false,
        message: `Daily Apify budget cap reached (${callsToday}/${maxDailyCalls} calls today). Call refused to protect owner budget.`
      };
    }
    return { allowed: true };
  };

  const recordApifyUsage = (actor: string) => {
    if (!costRepo) return;
    try {
      costRepo.recordUsage({
        model: 'apify-actor',
        source: 'apify',
        source_id: actor,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      });
    } catch {
      // Best-effort
    }
  };

  // 1. apify_linkedin_profile
  tools.push({
    name: 'apify_linkedin_profile',
    isAvailable: () => Boolean(token),
    description: 'Fetches structured LinkedIn profile details via Apify actor with spend cap protection.',
    effectClass: 'READ',
    schema: z.object({
      profileUrl: z.string().url().describe('The full LinkedIn profile URL to fetch')
    }),
    execute: async ({ profileUrl }) => {
      if (!token) {
        return {
          status: 'UNCONFIGURED',
          url: profileUrl,
          message: 'APIFY_API_TOKEN is not configured.'
        };
      }

      const cap = checkSpendCap();
      if (!cap.allowed) {
        return {
          status: 'BUDGET_EXHAUSTED',
          url: profileUrl,
          message: cap.message
        };
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);

      try {
        const endpoint = `${baseUrl}/${encodeURIComponent(profileActor)}/run-sync-get-dataset-items?memory=1024&timeout=30`;
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ urls: [profileUrl], maxItems: 1 }),
          signal: controller.signal
        });
        clearTimeout(timeout);
        recordApifyUsage(profileActor);

        if (!resp.ok) {
          return { status: 'ERROR', url: profileUrl, error: `Apify returned HTTP ${resp.status}` };
        }

        const items = await resp.json() as any[];
        if (!items || items.length === 0) {
          return { status: 'NOT_FOUND', url: profileUrl };
        }

        const p = items[0];
        return {
          status: 'SUCCESS',
          url: profileUrl,
          fullName: p.fullName || `${p.firstName || ''} ${p.lastName || ''}`.trim(),
          headline: p.headline,
          summary: p.summary,
          location: p.location,
          currentCompany: p.companyName || p.currentCompany,
          experience: (p.experience || []).slice(0, 5)
        };
      } catch (err: any) {
        clearTimeout(timeout);
        return { status: 'FAILED', url: profileUrl, error: err.message };
      }
    }
  });

  // 2. apify_linkedin_posts
  tools.push({
    name: 'apify_linkedin_posts',
    isAvailable: () => Boolean(token),
    description: 'Fetches recent public LinkedIn posts by a person or company with spend cap limit (max 5 posts).',
    effectClass: 'READ',
    schema: z.object({
      profileUrl: z.string().url().describe('Profile URL or company page URL'),
      maxPosts: z.number().int().min(1).max(5).optional().default(3).describe('Number of recent posts to fetch (max 5 spend cap)')
    }),
    execute: async ({ profileUrl, maxPosts }) => {
      if (!token) {
        return { status: 'UNCONFIGURED', url: profileUrl, message: 'APIFY_API_TOKEN is not configured.' };
      }

      const cap = checkSpendCap();
      if (!cap.allowed) {
        return {
          status: 'BUDGET_EXHAUSTED',
          url: profileUrl,
          message: cap.message
        };
      }

      const limit = Math.min(5, Math.max(1, maxPosts || 3));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);

      try {
        const endpoint = `${baseUrl}/${encodeURIComponent(postsActor)}/run-sync-get-dataset-items?memory=1024&timeout=30`;
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ targetUrls: [profileUrl], maxPosts: limit }),
          signal: controller.signal
        });
        clearTimeout(timeout);
        recordApifyUsage(postsActor);

        if (!resp.ok) {
          return { status: 'ERROR', url: profileUrl, error: `Apify returned HTTP ${resp.status}` };
        }

        const items = await resp.json() as any[];
        const posts = (items || []).slice(0, limit).map((i: any) => ({
          text: i.text?.slice(0, 1000) || '',
          postedAt: i.postedAt,
          numLikes: i.numLikes || 0,
          postUrl: i.url
        }));

        return { status: 'SUCCESS', profileUrl, count: posts.length, posts };
      } catch (err: any) {
        clearTimeout(timeout);
        return { status: 'FAILED', profileUrl, error: err.message };
      }
    }
  });

  return tools;
}

export function createMcpGatewayTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const gatewayUrl = process.env.ELLIE_MCP_GATEWAY_URL?.trim();
  const gatewayKey = process.env.ELLIE_MCP_GATEWAY_KEY?.trim();

  // Wire each tool from reviewed-baseline
  for (const item of REVIEWED_BASELINE) {
    const rawToolName = item.key.replace(/^mcp_elliegateway_/, '');

    tools.push({
      name: item.key,
      description: `[MCP Gateway: ${rawToolName}] ${item.notes} (Fingerprint: ${item.fingerprint.slice(0, 8)}...)`,
      effectClass: item.effectClass,
      isAvailable: () => Boolean(gatewayUrl),
      schema: z.record(z.string(), z.any()).optional().default({}).describe('Parameters for gateway call'),
      execute: async (params) => {
        if (!gatewayUrl) {
          return {
            status: 'GATEWAY_UNCONFIGURED',
            tool: item.key,
            message: 'ELLIE_MCP_GATEWAY_URL is not set.'
          };
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        try {
          const resp = await fetch(gatewayUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(gatewayKey ? { 'Authorization': `Bearer ${gatewayKey}` } : {})
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: `call_${Date.now()}`,
              method: 'tools/call',
              params: {
                name: rawToolName,
                arguments: params || {}
              }
            }),
            signal: controller.signal
          });
          clearTimeout(timeout);

          if (!resp.ok) {
            return {
              status: 'GATEWAY_ERROR',
              statusCode: resp.status,
              tool: item.key,
              error: `Gateway returned HTTP ${resp.status}`
            };
          }

          const json = await resp.json() as any;
          if (json.error) {
            return { status: 'GATEWAY_RPC_ERROR', tool: item.key, error: json.error };
          }

          return json.result || json;
        } catch (err: any) {
          clearTimeout(timeout);
          return { status: 'GATEWAY_FETCH_FAILED', tool: item.key, error: err.message };
        }
      }
    });
  }

  return tools;
}
