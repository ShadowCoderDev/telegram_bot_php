/**
 * End-to-end for the SaaS platform: the real Worker in `wrangler dev` (local D1) with a fake Telegram
 * API that serves several bots. A seller creates a shop in the platform bot, runs it, lets the
 * subscription lapse and renews it; the platform owner approves the payment.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { derivedSecret } from '../src/crypto';

const PORT = 8798;
const PERSIST = '.wrangler/platform-e2e';
const MASTER_KEY = 'm'.repeat(40);
const PLATFORM_TOKEN = '100000:PLATFORMPLATFORMPLATFORMPLATFORM00';
const OWNER = 1001; // platform admin
const SELLER = 2002;
const OTHER_SELLER = 3003;
const CUSTOMER = 4004;
const SHOP_TOKEN = '555555:SELLERBOTSELLERBOTSELLERBOTSELLER00';

interface Call { token: string; method: string; params: Record<string, any> }
const calls: Call[] = [];
let telegram: Server;
let worker: ChildProcess;
let updateId = 0;
let messageId = 100;
let platformSecret = '';

const byBot = (token: string, chat: number) => calls.filter((c) => c.token === token && c.params.chat_id === chat && c.method !== 'answerCallbackQuery');
const last = (token: string, chat: number) => {
  const c = byBot(token, chat).at(-1);
  return String(c?.params.text ?? c?.params.caption ?? '');
};
const buttons = (c: Call | undefined): { text: string; callback_data?: string; url?: string }[] => (c?.params.reply_markup?.inline_keyboard ?? []).flat();
const shopSecret = () => calls.filter((c) => c.token === SHOP_TOKEN && c.method === 'setWebhook').at(-1)!.params.secret_token as string;

async function post(path: string, secret: string, update: object) {
  return fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify({ update_id: ++updateId, ...update }),
  });
}
const msg = (chat: number, text: string) => ({ message: { message_id: ++messageId, from: { id: chat, first_name: `U${chat}` }, chat: { id: chat, type: 'private' }, text } });
const cbq = (chat: number, data: string) => ({
  callback_query: { id: `cb${updateId}`, from: { id: chat, first_name: `U${chat}` }, data, message: { message_id: 50, chat: { id: chat, type: 'private' } } },
});
const photoMsg = (chat: number, fileId: string) => ({
  message: { message_id: ++messageId, from: { id: chat, first_name: `U${chat}` }, chat: { id: chat, type: 'private' }, photo: [{ file_id: fileId, file_unique_id: `u-${fileId}`, width: 9, height: 9 }] },
});

const platform = {
  text: (chat: number, t: string) => post('/platform', platformSecret, msg(chat, t)),
  press: (chat: number, data: string) => post('/platform', platformSecret, cbq(chat, data)),
  photo: (chat: number, id: string) => post('/platform', platformSecret, photoMsg(chat, id)),
};
const shop = {
  text: (chat: number, t: string) => post('/webhook/2', shopSecret(), msg(chat, t)),
  press: (chat: number, data: string) => post('/webhook/2', shopSecret(), cbq(chat, data)),
};
const sql = (command: string) =>
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'shop', '--local', '--persist-to', PERSIST, '--command', command], { stdio: 'ignore' });
const now = () => Math.floor(Date.now() / 1000);

beforeAll(async () => {
  platformSecret = await derivedSecret(MASTER_KEY, 'platform-webhook');
  telegram = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const [, botPart, method] = req.url!.split('/');
      const token = botPart!.slice(3);
      const params = body ? JSON.parse(body) : {};
      calls.push({ token, method: method!, params });
      let result: unknown = { message_id: ++messageId };
      if (method === 'getMe') {
        if (token.startsWith('999999')) return res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }));
        const id = Number(token.split(':')[0]);
        result = { id, is_bot: true, username: id === 100000 ? 'builder_bot' : `shop${id}_bot` };
      }
      if (method === 'setWebhook' || method === 'deleteWebhook' || method === 'deleteMessage') result = true;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise<void>((r) => telegram.listen(0, '127.0.0.1', r));
  const tgPort = (telegram.address() as AddressInfo).port;

  rmSync(PERSIST, { recursive: true, force: true });
  worker = spawn('npx', [
    'wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--inspector-port', '9330', '--persist-to', PERSIST, '--test-scheduled',
    '--var', `PLATFORM_BOT_TOKEN:${PLATFORM_TOKEN}`, '--var', `MASTER_KEY:${MASTER_KEY}`, '--var', `PLATFORM_ADMIN_IDS:${OWNER}`,
    '--var', `TELEGRAM_API_BASE:http://127.0.0.1:${tgPort}`, '--var', 'FLOOD_LIMIT:1000',
  ], { stdio: 'ignore', detached: true });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start');
});

afterAll(() => {
  if (worker?.pid) process.kill(-worker.pid, 'SIGTERM');
  telegram?.close();
});

describe('SaaS platform', () => {
  it('connects the platform bot from the status page and rejects forged webhooks', async () => {
    const hook = calls.find((c) => c.token === PLATFORM_TOKEN && c.method === 'setWebhook')!;
    expect(hook.params).toMatchObject({ url: `http://127.0.0.1:${PORT}/platform`, secret_token: platformSecret });
    expect((await post('/platform', 'wrong', msg(SELLER, '/start'))).status).toBe(403);
    expect((await post('/webhook/2', 'anything', msg(SELLER, '/start'))).status).toBe(403); // no such shop yet
    expect((await post('/webhook', 'anything', msg(SELLER, '/start'))).status).toBe(403); // no owner shop configured
  });

  it('lets a seller create a shop from a BotFather token', async () => {
    await platform.text(SELLER, '/start');
    expect(last(PLATFORM_TOKEN, SELLER)).toContain('49,000');

    await platform.press(SELLER, 'p:new');
    await platform.text(SELLER, 'not-a-token');
    expect(last(PLATFORM_TOKEN, SELLER)).toContain('شبیه توکن ربات نیست');
    await platform.text(SELLER, '999999:INVALIDINVALIDINVALIDINVALIDINVA00');
    expect(last(PLATFORM_TOKEN, SELLER)).toContain('قبول نکرد');

    const tokenMessage = messageId + 1;
    await platform.text(SELLER, SHOP_TOKEN);
    expect(last(PLATFORM_TOKEN, SELLER)).toContain('فروشگاه شما ساخته شد');
    // The message carrying the token was deleted from the chat.
    expect(calls.some((c) => c.token === PLATFORM_TOKEN && c.method === 'deleteMessage' && c.params.message_id === tokenMessage)).toBe(true);
    const hook = calls.find((c) => c.token === SHOP_TOKEN && c.method === 'setWebhook')!;
    expect(hook.params.url).toBe(`http://127.0.0.1:${PORT}/webhook/2`);
    expect(hook.params.secret_token).toMatch(/^[0-9a-f]{48}$/);

    // The same bot can't be registered twice.
    await platform.press(OTHER_SELLER, 'p:new');
    await platform.text(OTHER_SELLER, SHOP_TOKEN);
    expect(last(PLATFORM_TOKEN, OTHER_SELLER)).toContain('قبلاً در پلتفرم ثبت شده');
  });

  it('runs the seller\'s shop in their own bot, with the seller as admin on a trial', async () => {
    await shop.text(SELLER, '/start');
    const root = byBot(SHOP_TOKEN, SELLER).find((c) => String(c.params.text).includes('پنل مدیریت'))!;
    expect(root.params.text).toContain('دوره‌ی آزمایشی');
    expect(buttons(root).find((b) => b.url)?.url).toBe('https://t.me/builder_bot?start=renew_2');

    await shop.press(SELLER, 'a:cat:add');
    await shop.text(SELLER, 'Seller category');
    await shop.text(SELLER, '🧸');
    await shop.press(CUSTOMER, 'shop');
    expect(last(SHOP_TOKEN, CUSTOMER)).not.toContain('فعلاً دسته‌بندی فعالی وجود ندارد');
    expect(buttons(byBot(SHOP_TOKEN, CUSTOMER).at(-1)).map((b) => b.text)).toContain('🧸 Seller category');
  });

  it('keeps shops apart even with forged buttons', async () => {
    // The seller's admin panel can't open another shop's order or product by id.
    await shop.press(SELLER, 'a:order:1');
    expect(last(SHOP_TOKEN, SELLER)).toContain('یافت نشد');
    // Another seller can't manage or delete this shop from the platform bot.
    await platform.press(OTHER_SELLER, 'p:shop:2');
    expect(last(PLATFORM_TOKEN, OTHER_SELLER)).toContain('هنوز فروشگاهی نساخته‌اید');
    await platform.press(OTHER_SELLER, 'p:delok:2');
    await shop.text(CUSTOMER, '/start');
    expect(last(SHOP_TOKEN, CUSTOMER)).not.toContain('در دسترس نیست');
  });

  it('closes the shop to customers after expiry and grace, but not to its admin', async () => {
    sql(`UPDATE shops SET paid_until = ${now() - 4 * 86400} WHERE id = 2`);
    await shop.text(CUSTOMER, '/start');
    expect(last(SHOP_TOKEN, CUSTOMER)).toContain('موقتاً در دسترس نیست');
    await shop.text(SELLER, '/start');
    expect(byBot(SHOP_TOKEN, SELLER).at(-2)!.params.text).toContain('فروشگاه برای مشتری‌ها بسته است');
  });

  it('renews by receipt; the platform owner approves once, and the shop reopens', async () => {
    await platform.text(SELLER, '/start renew_2'); // deep link from the shop's admin panel
    expect(last(PLATFORM_TOKEN, SELLER)).toContain('مدت تمدید');
    await platform.press(SELLER, 'p:pay:2:3');
    expect(last(PLATFORM_TOKEN, SELLER)).toContain('147,000');
    await platform.photo(SELLER, 'RENEW_RECEIPT');
    expect(last(PLATFORM_TOKEN, SELLER)).toContain('رسید دریافت شد');

    // Only one payment per shop can wait for review.
    await platform.press(SELLER, 'p:pay:2:1');
    expect(last(PLATFORM_TOKEN, SELLER)).toContain('در حال بررسی');

    const alert = calls.filter((c) => c.token === PLATFORM_TOKEN && c.params.chat_id === OWNER && c.method === 'sendPhoto').at(-1)!;
    expect(alert.params.photo).toBe('RENEW_RECEIPT');
    const approve = buttons(alert).find((b) => b.callback_data?.startsWith('pa:pay:ok:'))!.callback_data!;
    await Promise.all([platform.press(OWNER, approve), platform.press(OWNER, approve)]);
    expect(byBot(PLATFORM_TOKEN, SELLER).filter((c) => String(c.params.text).includes('اشتراک تمدید شد'))).toHaveLength(1);

    await shop.text(CUSTOMER, '/start');
    expect(last(SHOP_TOKEN, CUSTOMER)).not.toContain('در دسترس نیست');
    await shop.text(SELLER, '/start');
    expect(byBot(SHOP_TOKEN, SELLER).at(-2)!.params.text).toMatch(/اشتراک: <b>[۰-۹]+<\/b> روز مانده/);

    // The same receipt can't pay again.
    await platform.press(SELLER, 'p:pay:2:1');
    await platform.photo(SELLER, 'RENEW_RECEIPT');
    expect(last(PLATFORM_TOKEN, SELLER)).toContain('قبلاً استفاده شده');
  });

  it('sends each expiry reminder once from the hourly cron', async () => {
    sql(`UPDATE shops SET paid_until = ${now() + 2 * 86400}, reminder_stage = 0 WHERE id = 2`);
    await fetch(`http://127.0.0.1:${PORT}/__scheduled?cron=0+*+*+*+*`);
    await fetch(`http://127.0.0.1:${PORT}/__scheduled?cron=0+*+*+*+*`);
    const reminders = byBot(PLATFORM_TOKEN, SELLER).filter((c) => String(c.params.text).includes('اشتراک رو به پایان است'));
    expect(reminders).toHaveLength(1);
    expect(buttons(reminders[0])[0]!.callback_data).toBe('p:renew:2');
  });

  it('enforces plan limits and lets the seller add a second admin with the claim code', async () => {
    sql(`INSERT INTO categories (shop_id, name) SELECT 2, 'c' || value FROM json_each('[${Array.from({ length: 30 }, (_, i) => i).join(',')}]')`);
    await shop.press(SELLER, 'a:cat:add');
    expect(last(SHOP_TOKEN, SELLER)).toContain('به سقف رسیدید');

    await platform.press(SELLER, 'p:shop:2');
    const code = /\/claim ([0-9a-f]+)/.exec(last(PLATFORM_TOKEN, SELLER))![1]!;
    await shop.text(OTHER_SELLER, `/claim ${code}`);
    expect(last(SHOP_TOKEN, OTHER_SELLER)).toContain('ادمین این ربات شدید');
    await shop.text(OTHER_SELLER, '/start');
    expect(byBot(SHOP_TOKEN, OTHER_SELLER).some((c) => String(c.params.text).includes('پنل مدیریت'))).toBe(true);
  });

  it('shows the platform owner shops and revenue', async () => {
    await platform.text(OWNER, '/start');
    expect(last(PLATFORM_TOKEN, OWNER)).toContain('پنل مدیریت پلتفرم');
    await platform.press(OWNER, 'pa:stats');
    expect(last(PLATFORM_TOKEN, OWNER)).toContain('147,000');
    await platform.press(OWNER, 'pa:shop:susp:2');
    await shop.text(CUSTOMER, '/start');
    expect(last(SHOP_TOKEN, CUSTOMER)).toContain('در دسترس نیست');
    await platform.press(OWNER, 'pa:shop:susp:2');
  });
});
