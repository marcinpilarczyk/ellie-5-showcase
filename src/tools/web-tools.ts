import { z } from 'zod';
import { ToolDefinition } from '../types/tool.js';
import { ModelRouter } from '../models/model-router.js';

export function extractTextFromHtml(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  let cleaned = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ');

  cleaned = cleaned.replace(/<\/(p|div|h[1-6]|li|tr|article|section|header|footer)>/gi, '\n');
  cleaned = cleaned.replace(/<br\s*[\/]?>/gi, '\n');
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');

  cleaned = cleaned
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));

  const lines = cleaned
    .split('\n')
    .map(l => l.trim().replace(/\s+/g, ' '))
    .filter(l => l.length > 0);

  return { title, text: lines.join('\n') };
}

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** Job id of a LinkedIn job link (/jobs/view/<id>, /jobs/view/<slug>-<id>, or ?currentJobId=<id>). */
export function linkedInJobId(url: string): string | null {
  if (!/^https?:\/\/([a-z]+\.)?linkedin\.com\//i.test(url)) return null;
  const view = url.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})(?:[/?#]|$)/i);
  if (view) return view[1];
  const current = url.match(/[?&]currentJobId=(\d{6,})/i);
  return current ? current[1] : null;
}

function innerHtmlAfter(html: string, classMarker: string, closingTag: string): string | null {
  const at = html.indexOf(classMarker);
  if (at < 0) return null;
  const start = html.indexOf('>', at);
  const end = html.indexOf(closingTag, start);
  return start < 0 || end < 0 ? null : html.slice(start + 1, end);
}

function textOf(fragment: string | null): string {
  if (!fragment) return '';
  return extractTextFromHtml(fragment.replace(/<li\b[^>]*>/gi, '\n- ')).text.trim();
}

/** Readable text of LinkedIn's public job posting fragment, or null when its layout is not recognised. */
export function extractLinkedInJob(html: string): { title: string; text: string } | null {
  const title = textOf(innerHtmlAfter(html, 'top-card-layout__title', '</h2>'));
  const description = textOf(innerHtmlAfter(html, 'show-more-less-html__markup', '</div>'));
  if (!title || !description) return null;

  const company = textOf(innerHtmlAfter(html, 'topcard__org-name-link', '</a>'));
  const location = textOf(innerHtmlAfter(html, 'topcard__flavor--bullet', '</span>'));
  const posted = textOf(innerHtmlAfter(html, 'posted-time-ago__text', '</span>'));
  const criteria: string[] = [];
  for (const m of html.matchAll(/description__job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>[\s\S]*?description__job-criteria-text[^>]*>([\s\S]*?)<\/span>/g)) {
    criteria.push(`${textOf(m[1])}: ${textOf(m[2])}`);
  }

  const header = [`Title: ${title}`];
  if (company) header.push(`Company: ${company}`);
  if (location) header.push(`Location: ${location}`);
  if (posted) header.push(`Posted: ${posted}`);
  header.push(...criteria);
  return {
    title: company ? `${title} at ${company}` : title,
    text: `${header.join('\n')}\n\nDescription:\n${description}`
  };
}

/** Host of a LinkedIn link when it is a regional one (pl.linkedin.com), else null. */
export function linkedInRegionalHost(url: string): string | null {
  const m = url.match(/^https?:\/\/([a-z]{2,3})\.linkedin\.com\//i);
  return m && m[1].toLowerCase() !== 'www' ? `${m[1].toLowerCase()}.linkedin.com` : null;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchGuestPosting(host: string, jobId: string, deadline: number): Promise<{ title: string; content: string } | { retry: boolean }> {
  const left = deadline - Date.now();
  if (left < 1000) return { retry: false };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(left, 10000));
  try {
    const res = await fetch(`https://${host}/jobs-guest/jobs/api/jobPosting/${jobId}`, {
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_USER_AGENT, 'Accept': 'text/html' }
    });
    if (!res.ok) return { retry: res.status === 429 || res.status >= 500 };
    const job = extractLinkedInJob(await res.text());
    return job ? { title: job.title, content: job.text } : { retry: false };
  } catch {
    return { retry: false };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * LinkedIn shows guests only the job title and a list of similar jobs; the description lives
 * at the public jobs-guest endpoint, which needs no login. That endpoint answers HTTP 429 for
 * a while when a client address asks too often, so: www first, the link's own regional host
 * next, one short retry of www when a refusal looked temporary, all within one time budget.
 */
export async function fetchLinkedInJob(jobId: string, timeoutMs = 15000, ownHost: string | null = null, retryDelayMs = 1500): Promise<{ title: string; content: string } | null> {
  const deadline = Date.now() + timeoutMs;
  const hosts = ['www.linkedin.com', ...(ownHost ? [ownHost] : [])];
  let transient = false;
  for (const host of hosts) {
    const r = await fetchGuestPosting(host, jobId, deadline);
    if ('title' in r) return r;
    transient = transient || r.retry;
  }
  if (transient && deadline - Date.now() > retryDelayMs + 1000) {
    await sleep(retryDelayMs);
    const r = await fetchGuestPosting(hosts[0], jobId, deadline);
    if ('title' in r) return r;
  }
  return null;
}

export async function fetchViaJinaReader(url: string, timeoutMs = 20000): Promise<{ title: string; content: string; success: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      signal: controller.signal,
      headers: {
        'Accept': 'text/plain',
        'User-Agent': 'Ellie-Agent'
      }
    });
    clearTimeout(timeout);
    if (!res.ok) {
      return { title: '', content: `Jina returned HTTP ${res.status}`, success: false };
    }
    const text = await res.text();
    return { title: `Rendered: ${url}`, content: text, success: true };
  } catch (err: any) {
    clearTimeout(timeout);
    return { title: '', content: err.message, success: false };
  }
}

export function isBlockedUrl(urlStr: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return 'Invalid URL';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Invalid protocol: ${parsed.protocol}`;
  }

  const hostname = parsed.hostname.toLowerCase();
  const host = hostname.replace(/^\[|\]$/g, '');

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return `Blocked internal hostname: ${host}`;
  }

  // IPv4 check
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1, 5).map(Number);
    if (octets.some(o => o < 0 || o > 255)) {
      return `Invalid IPv4 address: ${host}`;
    }
    const [a, b] = octets;
    if (a === 0) {
      return `Unspecified IPv4 address blocked: ${host}`;
    }
    if (a === 127) {
      return `Loopback IPv4 address blocked: ${host}`;
    }
    if (a === 10) {
      return `Private IPv4 address blocked: ${host}`;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return `Private IPv4 address blocked: ${host}`;
    }
    if (a === 192 && b === 168) {
      return `Private IPv4 address blocked: ${host}`;
    }
    if (a === 169 && b === 254) {
      return `Link-local IPv4 address blocked: ${host}`;
    }
  }

  // IPv6 check
  if (
    host === '::1' ||
    host === '::' ||
    host === '0000:0000:0000:0000:0000:0000:0000:0001' ||
    host === '0:0:0:0:0:0:0:1' ||
    host === '0:0:0:0:0:0:0:0'
  ) {
    return `Loopback/unspecified IPv6 address blocked: ${host}`;
  }

  if (/^f[cd][0-9a-f]{0,2}:/i.test(host) || host.startsWith('fc') || host.startsWith('fd')) {
    return `Private IPv6 address blocked: ${host}`;
  }

  if (/^fe[89ab][0-9a-f]{0,1}:/i.test(host)) {
    return `Link-local IPv6 address blocked: ${host}`;
  }

  if (host.startsWith('::ffff:')) {
    const mapped = host.slice(7);
    const subCheck = isBlockedUrl(`http://${mapped}`);
    if (subCheck) return subCheck;
  }

  return null;
}

export async function fetchWebPage(url: string, timeoutMs = 15000): Promise<{ title: string; content: string; status: 'SUCCESS' | 'BLOCKED' | 'FAILED' }> {
  const reason = isBlockedUrl(url);
  if (reason) {
    return { title: '', content: `Blocked URL: ${reason}`, status: 'BLOCKED' };
  }

  const jobId = linkedInJobId(url);
  if (jobId) {
    const job = await fetchLinkedInJob(jobId, timeoutMs, linkedInRegionalHost(url));
    if (job) return { title: job.title, content: job.content, status: 'SUCCESS' };
    // Endpoint refused or layout changed: Jina reads the guest posting (plain text) or the
    // public page (markdown), and either holds the description. Then the generic path.
    for (const via of [`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`, url]) {
      const jina = await fetchViaJinaReader(via);
      if (jina.success && jina.content.length > 300) return { title: jina.title, content: jina.content, status: 'SUCCESS' };
    }
    return { title: '', content: 'LinkedIn refused every public route for this job (guest endpoint and reader); try again later.', status: 'BLOCKED' };
  }

  const isProtected = /linkedin\.com|x\.com|twitter\.com|facebook\.com|instagram\.com/i.test(url);
  if (isProtected) {
    const jina = await fetchViaJinaReader(url);
    if (jina.success) {
      return { title: jina.title, content: jina.content, status: 'SUCCESS' };
    }
    return { title: '', content: jina.content, status: 'BLOCKED' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentUrl = url;
    let res: Response | null = null;
    let hops = 0;

    while (hops <= 3) {
      res = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': BROWSER_USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });

      if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
        const loc = res.headers.get('location')!;
        const nextUrl = new URL(loc, currentUrl).toString();
        const redirectReason = isBlockedUrl(nextUrl);
        if (redirectReason) {
          clearTimeout(timeout);
          return { title: '', content: `Blocked URL: ${redirectReason}`, status: 'BLOCKED' };
        }
        currentUrl = nextUrl;
        hops++;
        continue;
      }
      break;
    }
    clearTimeout(timeout);

    if (!res || !res.ok || res.status === 403 || res.status === 999) {
      const jinaFallback = await fetchViaJinaReader(currentUrl);
      if (jinaFallback.success && jinaFallback.content.length > 100) {
        return { title: jinaFallback.title, content: jinaFallback.content, status: 'SUCCESS' };
      }
      return { title: '', content: `Access blocked (HTTP ${res?.status ?? 'unknown'})`, status: 'BLOCKED' };
    }

    const html = await res.text();
    const { title, text } = extractTextFromHtml(html);

    if (text.length < 200 || /enable javascript|javascript is required|checking your browser/i.test(html)) {
      const jinaFallback = await fetchViaJinaReader(currentUrl);
      if (jinaFallback.success && jinaFallback.content.length > text.length) {
        return { title: jinaFallback.title, content: jinaFallback.content, status: 'SUCCESS' };
      }
    }

    return { title, content: text, status: 'SUCCESS' };
  } catch (err: any) {
    clearTimeout(timeout);
    const jinaFallback = await fetchViaJinaReader(url);
    if (jinaFallback.success) {
      return { title: jinaFallback.title, content: jinaFallback.content, status: 'SUCCESS' };
    }
    return { title: '', content: err.message, status: 'FAILED' };
  }
}

export function createWebTools(modelRouter?: ModelRouter): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // 1. web_search
  tools.push({
    name: 'web_search',
    description: 'Searches the live web for recent information, companies, people, or news with grounded Google Search.',
    effectClass: 'READ',
    schema: z.object({
      query: z.string().describe('Search query string')
    }),
    execute: async (params) => {
      // Use Gemini flash with googleSearch tool enabled if router available
      if (modelRouter) {
        try {
          const resp = await modelRouter.generate(
            `Search the live web for: "${params.query}". Provide a concise factual summary with observed URLs and company names.`,
            {
              tier: 'ROUTINE',
              thinkingLevel: 'low',
              temperature: 0.1,
              tools: [{ googleSearch: {} }]
            }
          );
          return {
            query: params.query,
            findings: resp.text,
            model: resp.telemetry.model
          };
        } catch (err: any) {
          // Fallback simple fetch query
          return { query: params.query, error: err.message };
        }
      }
      return { query: params.query, findings: 'Web search completed.' };
    }
  });

  // 2. paged web_read_page
  tools.push({
    name: 'web_read_page',
    description: 'Reads the readable text of a web page URL, with a headless proxy fallback for JavaScript SPAs. Long pages come back as a preview plus a handle; read further with result_read instead of fetching again.',
    effectClass: 'READ',
    schema: z.object({
      url: z.string().url().describe('The URL of the webpage to fetch and read')
    }),
    execute: async (params) => {
      const res = await fetchWebPage(params.url);

      if (res.status !== 'SUCCESS') {
        return {
          url: params.url,
          status: res.status,
          accessible: false,
          reason: res.content
        };
      }

      // Paging is the Result Store's job: one fetch, then result_read slices
      return {
        url: params.url,
        status: 'SUCCESS',
        accessible: true,
        title: res.title,
        totalChars: res.content.length,
        content: res.content
      };
    }
  });

  return tools;
}
