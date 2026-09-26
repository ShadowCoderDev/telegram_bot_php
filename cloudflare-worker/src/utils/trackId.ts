const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** "IELTS-7K2QD". Uniqueness is enforced by the UNIQUE index; callers retry on collision. */
export function generateTrackId(length = 5, prefix = 'IELTS-'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return prefix + Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}
