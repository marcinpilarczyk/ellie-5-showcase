/**
 * Applied by the dispatcher to every READ tool result, whatever the integration (Google, Apify,
 * MCP gateway, future ones). Removes what no answer ever needs: API envelope keys, null values,
 * base64 blobs, and HTML markup inside long strings. Tool-specific shapers (google/compact.ts)
 * go further for high-traffic tools; this is the floor for everything else.
 */

const NOISE_KEYS = new Set([
  'kind', 'etag', 'iCalUID', 'iconUri', 'conferenceSolution', 'extendedProperties',
  'sizeEstimate', 'resultSizeEstimate', 'nextSyncToken', 'nextPageToken', '__typename',
  // Google Drive & Workspace envelope links / metadata
  'selfLink', 'exportLinks', 'alternateLink', 'embedLink', 'thumbnailLink', 'webContentLink',
  'permissionIds', 'copyRequiresWriterPermission', 'writersCanShare',
  // Composio & External integrations plumbing
  'response_headers', 'composio_metadata',
  // Slack envelope metadata
  'response_metadata'
]);

const BASE64 = /^[A-Za-z0-9+/_-]{200,}={0,2}$/;
const HTML = /<\/?(p|div|span|br|a|li|ul|ol|strong|em|b|i|table|tr|td|html|body)\b[^>]*>/i;

function slimString(s: string): string {
  if (BASE64.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s)) return `[binary data, ${s.length} chars omitted]`;
  if (s.length > 200 && HTML.test(s)) {
    return s
      .replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, '\n')
      .replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, '$2 ($1)')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n\s*\n+/g, '\n\n')
      .trim();
  }
  return s;
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined;
}

export function slimForModel<T>(value: T, depth = 0): T {
  if (depth > 20) return value;
  if (typeof value === 'string') return slimString(value) as T;
  if (Array.isArray(value)) return value.map(v => slimForModel(v, depth + 1)).filter(v => !isEmpty(v)) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (NOISE_KEYS.has(k)) continue;
      const slim = slimForModel(v, depth + 1);
      if (!isEmpty(slim)) out[k] = slim;
    }
    return out as T;
  }
  return value;
}
