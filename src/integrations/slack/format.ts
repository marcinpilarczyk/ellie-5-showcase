/**
 * Slack does not render Markdown: `**bold**` shows the asterisks and `[text](url)` shows raw.
 * Models write Markdown anyway, so every outgoing text is converted to Slack mrkdwn here.
 * Single `*x*` is left alone: it is already Slack bold, and Ellie's own messages use it.
 */
export function toSlackMrkdwn(text: string): string {
  if (!text) return text;
  const code: string[] = [];
  const stash = (m: string) => `\u0000${code.push(m) - 1}\u0000`;

  let out = text
    .replace(/```[\s\S]*?```/g, stash)
    .replace(/`[^`\n]+`/g, stash);

  out = out
    .replace(/!?\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => (label === url ? `<${url}>` : `<${url}|${label}>`))
    .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, (_, h) => `*${h.replace(/\*\*/g, '')}*`)
    .replace(/\*\*\*(?!\s)([^*\n]+?)\*\*\*/g, '*_$1_*')
    .replace(/\*\*(?!\s)([^\n]+?)\*\*/g, '*$1*')
    .replace(/__(?!\s)([^_\n]+?)__/g, '*$1*')
    .replace(/~~([^~\n]+)~~/g, '~$1~')
    .replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, '')
    .replace(/^(\s*)[*-]\s+/gm, '$1• ');

  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => code[+i]);
}
