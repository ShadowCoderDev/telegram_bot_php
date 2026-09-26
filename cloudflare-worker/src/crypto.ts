/*
 * Secrets for the multi-tenant platform, all derived from one MASTER_KEY secret:
 *  - sellers' bot tokens are stored AES-GCM encrypted, so a leaked database export doesn't leak bots;
 *  - webhook secrets and /claim codes are HMACs, so they need no storage and can't be guessed.
 */

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(masterKey: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`token-encryption:${masterKey}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** "v1:<iv>:<ciphertext>" (base64). */
export async function encryptToken(token: string, masterKey: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(masterKey), enc.encode(token)));
  return `v1:${b64(iv)}:${b64(data)}`;
}

export async function decryptToken(sealed: string, masterKey: string): Promise<string> {
  const [version, iv, data] = sealed.split(':');
  if (version !== 'v1' || !iv || !data) throw new Error('Unknown token format');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(masterKey), unb64(data));
  return new TextDecoder().decode(plain);
}

/** Deterministic secret for a purpose, e.g. derivedSecret(key, 'platform-webhook'). Hex, 40 chars. */
export async function derivedSecret(masterKey: string, purpose: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(masterKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(purpose)));
  return Array.from(mac.slice(0, 20), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const randomSecret = (bytes = 24) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');

/** Constant-time comparison via SHA-256 digests, so a secret can't be guessed byte by byte. */
export async function sameSecret(a: string, b: string): Promise<boolean> {
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  return x.reduce((diff, byte, i) => diff | (byte ^ y[i]!), 0) === 0;
}
