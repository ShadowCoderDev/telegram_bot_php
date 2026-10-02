/** Cron: sends each booked customer a reminder shortly before their slot (see db/reminders.ts). */
import { decryptToken } from './crypto';
import { ReminderRepository } from './db/reminders';
import type { Env } from './env';
import { OWNER_SHOP_ID } from './tenancy';
import { TelegramClient } from './telegram/TelegramClient';
import { appointmentReminder } from './views/slots';

/** Free plan: 50 outgoing requests per invocation; this leaves room for the hourly jobs. */
export const REMINDERS_PER_RUN = 30;
/** The on-the-hour run also sends the sellers' reminders, purges and alarms. */
export const REMINDERS_HOURLY = 12;

/** Returns how many reminders were sent. */
export async function sendAppointmentReminders(env: Env, now: number, limit = REMINDERS_PER_RUN): Promise<number> {
  const repo = new ReminderRepository(env.DB);
  const clients = new Map<number, TelegramClient | null>();
  const clientFor = async (r: { shop_id: number; bot_token_enc: string }) => {
    if (!clients.has(r.shop_id)) {
      const token = r.shop_id === OWNER_SHOP_ID ? env.BOT_TOKEN : env.MASTER_KEY && r.bot_token_enc ? await decryptToken(r.bot_token_enc, env.MASTER_KEY).catch(() => null) : null;
      clients.set(r.shop_id, token ? new TelegramClient(token, env.TELEGRAM_API_BASE) : null);
    }
    return clients.get(r.shop_id) ?? null;
  };

  let sent = 0;
  for (const r of await repo.due(now, limit)) {
    const tg = await clientFor(r);
    // Claimed first: if sending fails the customer misses one reminder, never gets two.
    if (!tg || !(await repo.claim(r.order_id, r.category_id, now))) continue;
    const view = appointmentReminder({ ...r, shop_name: r.shop_name || (r.bot_username ? `@${r.bot_username}` : '') }, now);
    await tg.sendMessage(r.chat_id, view.text, view.keyboard).catch((err) => console.error('appointment reminder', r.shop_id, err));
    sent++;
  }
  return sent;
}
