import { decryptToken, derivedSecret, sameSecret } from './crypto';
import { ShopRepository, type ShopRow } from './db/platform';
import type { Env } from './env';

/** Everything a request needs to know about the shop whose bot received it. */
export interface ShopContext extends ShopRow {
  token: string;
  /** The code a person sends as `/claim <code>` in this shop's bot to become an extra admin. */
  claimCode: string;
}

export const OWNER_SHOP_ID = 1;

/**
 * Finds the shop for an incoming webhook and checks Telegram's secret header.
 *   /webhook      → shop 1, the platform owner's own shop (BOT_TOKEN + WEBHOOK_SECRET)
 *   /webhook/<id> → a seller's shop (its token decrypted with MASTER_KEY)
 * Returns null when the request must be refused.
 */
export async function resolveShop(env: Env, shopId: number, secretHeader: string | null): Promise<ShopContext | null> {
  if (!secretHeader) return null;
  const shop = await new ShopRepository(env.DB).find(shopId);
  if (!shop || shop.status === 'deleted') return null;

  if (shopId === OWNER_SHOP_ID) {
    if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET || !(await sameSecret(secretHeader, env.WEBHOOK_SECRET))) return null;
    return { ...shop, token: env.BOT_TOKEN, claimCode: env.WEBHOOK_SECRET };
  }
  if (!env.MASTER_KEY || !shop.bot_token_enc || !(await sameSecret(secretHeader, shop.webhook_secret))) return null;
  return {
    ...shop,
    token: await decryptToken(shop.bot_token_enc, env.MASTER_KEY),
    claimCode: await shopClaimCode(env.MASTER_KEY, shop.id),
  };
}

/** Owner's shop context for non-webhook uses (status page). */
export async function ownerShop(env: Env): Promise<ShopContext | null> {
  const shop = await new ShopRepository(env.DB).find(OWNER_SHOP_ID);
  if (!shop || !env.BOT_TOKEN) return null;
  return { ...shop, token: env.BOT_TOKEN, claimCode: env.WEBHOOK_SECRET ?? '' };
}

export const shopClaimCode = (masterKey: string, shopId: number) => derivedSecret(masterKey, `claim:${shopId}`);
export const platformWebhookSecret = (masterKey: string) => derivedSecret(masterKey, 'platform-webhook');
