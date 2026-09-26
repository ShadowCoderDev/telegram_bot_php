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
