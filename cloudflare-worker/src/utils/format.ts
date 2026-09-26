/** number_format() equivalent: 1250000 → "1,250,000". */
export const money = (n: number): string => Math.trunc(n).toLocaleString('en-US');

/** htmlspecialchars() for Telegram's HTML parse mode. Apply to every user-supplied string. */
export const escapeHtml = (s: string | null | undefined): string =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Unicode-safe truncation (mb_substr). */
export const truncate = (s: string, max: number): string => {
  const chars = [...s];
  return chars.length > max ? chars.slice(0, max).join('') + '…' : s;
};

/** Telegram's limit for one message's text. */
export const MESSAGE_LIMIT = 4096;

const TAG = /<(\/?)([a-z]+)([^>]*)>/g;

/**
 * Splits HTML-formatted text into chunks of at most `limit` characters, cutting only between lines.
 * Tags still open at a cut (e.g. a <blockquote> spanning the boundary) are closed at the end of the
 * chunk and reopened at the start of the next, so every chunk is valid for parse_mode HTML.
 */
export function splitHtml(text: string, limit = MESSAGE_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let open: { name: string; tag: string }[] = [];
  let current = '';

  const closing = () => open.map((t) => `</${t.name}>`).reverse().join('');
  const flush = () => {
    if (current.trim()) chunks.push(current + closing());
    current = open.map((t) => t.tag).join('');
  };

  for (const rawLine of text.split('\n')) {
    // A single line longer than a whole message (only possible with unbounded input) is hard-cut.
    const pieces = rawLine.length > limit / 2 ? rawLine.match(new RegExp(`[^]{1,${Math.floor(limit / 2)}}`, 'g'))! : [rawLine];
    for (const line of pieces) {
      const candidate = current ? `${current}\n${line}` : line;
      if (candidate.length + closing().length > limit && current) {
        flush();
        current += line;
      } else {
        current = candidate;
      }
      for (const m of line.matchAll(TAG)) {
        if (m[1]) open = open.filter((t, i) => !(t.name === m[2] && i === open.map((o) => o.name).lastIndexOf(m[2]!)));
        else open.push({ name: m[2]!, tag: m[0] });
      }
    }
  }
  if (current.trim()) chunks.push(current + closing());
  return chunks;
}
