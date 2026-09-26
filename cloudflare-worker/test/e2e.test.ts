/**
 * End-to-end: runs the real Worker in `wrangler dev` (local D1 + R2) against a fake Telegram API,
 * then plays an admin and a customer through the whole shop flow.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { send } from './harness';

const ADMIN = 1001;
const BUYER = 2002;
const BUYER2 = 3003;
const FLOODER = 4004;
const GROUP = -5005;
const CLAIMER = 6006;
const SECRET = 'e2e-secret-0123456789';
const TOKEN = 'TEST:TOKEN';
const PERSIST = '.wrangler/e2e';
const WORKER_PORT = 8799;

interface Call { method: string; params: Record<string, any> }
const calls: Call[] = [];
let telegram: Server;
let worker: ChildProcess;
let updateId = 0;
let messageId = 100;

const sent = (chatId: number) => calls.filter((c) => c.params.chat_id === chatId);
const lastText = (chatId: number) => {
  const c = sent(chatId).filter((c) => c.method !== 'answerCallbackQuery').at(-1);
  return String(c?.params.text ?? c?.params.caption ?? '');
};

async function post(update: object, secret = SECRET) {
  return send(`http://127.0.0.1:${WORKER_PORT}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify({ update_id: ++updateId, ...update }),
  });
}
const buttons = (call: Call | undefined): { text: string; callback_data: string }[] =>
  (call?.params.reply_markup?.inline_keyboard ?? []).flat();
const lastWithButtons = (chatId: number) => sent(chatId).filter((c) => c.params.reply_markup?.inline_keyboard).at(-1);
const text = (chat: number, t: string) =>
  post({ message: { message_id: ++messageId, from: { id: chat, first_name: `U${chat}` }, chat: { id: chat, type: 'private' }, text: t } });
const photo = (chat: number, fileId = 'RECEIPT_BIG') =>
  post({
    message: {
      message_id: ++messageId, from: { id: chat, first_name: `U${chat}` }, chat: { id: chat, type: 'private' },
      photo: [
        { file_id: 'small', file_unique_id: `s-${fileId}`, width: 1, height: 1 },
        { file_id: fileId, file_unique_id: `u-${fileId}`, width: 9, height: 9 },
      ],
    },
  });
const setPrice = async (productId: number, price: string) => {
  await press(ADMIN, `a:prod:field:${productId}:price`);
  await text(ADMIN, price);
};
const sql = (command: string) =>
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'shop', '--local', '--persist-to', PERSIST, '--command', command], { stdio: 'ignore' });
const checkoutToPayment = async (chat = BUYER, phone = '09123456789') => {
  await press(chat, 'checkout');
  await text(chat, 'Ali Mohammadi');
  await text(chat, 'Tehran, Azadi St 12');
  await text(chat, phone);
};
/** Buys `qty` of product 1 as `chat`, paying with a receipt photo `receipt`. */
const placeOrder = async (chat: number, qty: number, receipt: string) => {
  await press(chat, `add:1:${qty}`);
  await checkoutToPayment(chat, '09350000000');
  await photo(chat, receipt);
};
const press = (chat: number, data: string) =>
  post({
    callback_query: {
      id: `cb${updateId}`, from: { id: chat, first_name: `U${chat}` }, data,
      message: { message_id: 50, chat: { id: chat, type: 'private' } },
    },
  });

beforeAll(async () => {
  telegram = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url?.startsWith('/file/')) return res.end(Buffer.from([0xff, 0xd8, 0xff]));
      const method = req.url!.split('/').pop()!;
      calls.push({ method, params: body ? JSON.parse(body) : {} });
      const result = method === 'getFile' ? { file_path: 'photos/receipt.jpg' } : { message_id: ++messageId };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise<void>((r) => telegram.listen(0, '127.0.0.1', r));
  const tgPort = (telegram.address() as AddressInfo).port;

  // No migrations are applied here: the Worker creates its own tables on the first request.
  rmSync(PERSIST, { recursive: true, force: true });

  worker = spawn('npx', [
    'wrangler', 'dev', '--port', String(WORKER_PORT), '--ip', '127.0.0.1', '--inspector-port', '9331', '--persist-to', PERSIST,
    '--var', `BOT_TOKEN:${TOKEN}`, '--var', `WEBHOOK_SECRET:${SECRET}`,
    '--var', `ADMIN_CHAT_IDS:${ADMIN}`, '--var', `TELEGRAM_API_BASE:http://127.0.0.1:${tgPort}`,
    '--var', 'FLOOD_LIMIT:100',
  ], { stdio: 'ignore', detached: true });

  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${WORKER_PORT}/`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start');
});

afterAll(() => {
  if (worker?.pid) process.kill(-worker.pid, 'SIGTERM');
  telegram?.close();
});

describe('shop bot end-to-end', () => {
  it('rejects webhooks without the secret', async () => {
    expect((await post({}, 'wrong')).status).toBe(403);
  });

  it('admin creates a category and a product', async () => {
    await text(ADMIN, '/start');
    expect(sent(ADMIN)[0]!.params.text).toContain('پنل مدیریت');

    await press(ADMIN, 'a:cat:add');
    await text(ADMIN, 'Books');
    await text(ADMIN, '📚');
    expect(lastText(ADMIN)).toContain('اضافه شد');

    await press(ADMIN, 'a:prod:add');
    for (const t of ['IELTS <Book>', 'Great book', '۱۲۰,۰۰۰', 'Author', '2']) await text(ADMIN, t);
    await text(ADMIN, 'not an image');
    expect(lastText(ADMIN)).toContain('تصویر دریافت نشد');
    // No R2 needed: the uploaded photo is kept as a Telegram file_id.
    await photo(ADMIN, 'PRODUCT_PHOTO');
    expect(lastText(ADMIN)).toContain('این محصول را انتخاب کنید');
    await press(ADMIN, 'a:prod:newcat:1');
    expect(lastText(ADMIN)).toContain('IELTS &lt;Book&gt;');
  });

  it('customer browses, fills the cart and checks out', async () => {
    await text(BUYER, '/start');
    expect(sent(BUYER)[0]!.params.text).toContain('فروشگاه');

    await press(BUYER, 'cat:1');
    expect(lastText(BUYER)).toContain('Books');
    await press(BUYER, 'qty:1:2');
    expect(lastText(BUYER)).toContain('240,000');
    const card = sent(BUYER).filter((c) => c.method === 'sendPhoto').at(-1)!;
    expect(card.params.photo).toBe('PRODUCT_PHOTO');

    await press(BUYER, 'add:1:3');
    expect(lastText(BUYER)).toContain('موجودی کافی نیست');
    await press(BUYER, 'add:1:2');
    expect(lastText(BUYER)).toContain('به سبد خرید اضافه شد');

    await press(BUYER, 'cart');
    expect(lastText(BUYER)).toContain('قیمت واحد: 120,000 تومان');
    expect(lastText(BUYER)).toContain('مبلغ قابل پرداخت: 240,000 تومان');

    await press(BUYER, 'checkout');
    await text(BUYER, 'Ali');
    expect(lastText(BUYER)).toContain('کامل بفرستید');
    await text(BUYER, 'Ali Mohammadi');
    await text(BUYER, 'Tehran, Street 1');
    await text(BUYER, '۰۹۱۲۳۴۵۶۷۸');
    expect(lastText(BUYER)).toContain('معتبر نیست');
    await text(BUYER, '۰۹۱۲۳۴۵۶۷۸۹');
    expect(lastText(BUYER)).toContain('240,000');
    await text(BUYER, 'not a photo');
    expect(lastText(BUYER)).toContain('منتظر عکس رسید');

    // The admin raises the price after the customer was shown the amount: the shown amount holds.
    await setPrice(1, '150000');
    await photo(BUYER);
    expect(lastText(BUYER)).toContain('ORD-'); // default prefix until the seller sets one
    expect(lastText(BUYER)).toContain('240,000');

    const alert = calls.filter((c) => c.params.chat_id === ADMIN && c.method === 'sendPhoto').at(-1)!;
    expect(alert.params.photo).toBe('RECEIPT_BIG');
    expect(alert.params.caption).toContain('سفارش جدید');
    expect(JSON.stringify(alert.params.reply_markup)).toContain('a:order:approve:1');
  });

  it('approval takes stock, rejection returns it, and the buyer is told', async () => {
    await press(ADMIN, 'a:order:approve:1');
    expect(lastText(BUYER)).toContain('تایید شد');
    await press(ADMIN, 'a:prod:1');
    expect(lastText(ADMIN)).toContain('<b>موجودی:</b> 0');

    await press(ADMIN, 'a:order:approve:1');
    expect(lastText(ADMIN)).toContain('مجاز نیست');

    await press(ADMIN, 'a:order:reject:1');
    await press(ADMIN, 'a:prod:1');
    expect(lastText(ADMIN)).toContain('<b>موجودی:</b> 2');

    await press(BUYER, 'orders');
    expect(lastText(BUYER)).toContain('رد شده');
  });

  it('relays an admin ↔ buyer conversation', async () => {
    await press(ADMIN, 'a:dialog:1');
    await text(ADMIN, 'Hello <buyer>');
    expect(lastText(BUYER)).toContain('Hello &lt;buyer&gt;');
    await text(BUYER, 'Thanks!');
    expect(lastText(ADMIN)).toContain('Thanks!');
    await press(ADMIN, `a:dialog:close:${BUYER}`);
    await text(BUYER, 'anyone?');
    expect(lastText(BUYER)).toContain('متوجه نشدم');
  });

  it('admin statistics count the order', async () => {
    await press(ADMIN, 'a:order:approve:1');
    await press(ADMIN, 'a:stats');
    expect(lastText(ADMIN)).toContain('سفارشات موفق: <b>۱</b>');
    expect(lastText(ADMIN)).toContain('240,000');
  });

  it('keeps paid orders at their snapshot price after the price changes', async () => {
    await press(BUYER, 'orders');
    expect(lastText(BUYER)).toContain('قیمت واحد: 120,000 تومان');
    expect(lastText(BUYER)).not.toContain('150,000');
  });

  it('cancels checkout when the cart changes after the amount was shown', async () => {
    await press(ADMIN, 'a:prod:field:1:inventory');
    await text(ADMIN, '10');
    await press(BUYER, 'add:1:1');
    await checkoutToPayment();
    expect(lastText(BUYER)).toContain('150,000 تومان');

    await press(BUYER, 'add:1:1'); // sneak another item in after seeing the amount
    expect(lastText(BUYER)).toContain('سبد خرید تغییر کرد');
    await photo(BUYER);
    expect(lastText(BUYER)).toContain('متوجه نشدم'); // no receipt accepted without a fresh checkout

    await press(BUYER, 'cart');
    expect(lastText(BUYER)).toContain('مبلغ قابل پرداخت: 300,000 تومان');
  });

  it('re-prices an expired lock instead of accepting the old amount', async () => {
    await checkoutToPayment();
    expect(lastText(BUYER)).toContain('300,000 تومان');
    await setPrice(1, '100000');
    sql(`UPDATE sessions SET data = json_set(data, '$.lockedAt', 0) WHERE chat_id = ${BUYER}`);

    await photo(BUYER, 'RECEIPT_2');
    const recent = sent(BUYER).slice(-2).map((c) => String(c.params.text));
    expect(recent[0]).toContain('مبلغ سفارش به‌روز شد');
    expect(recent[1]).toContain('200,000 تومان');

    await photo(BUYER, 'RECEIPT_2');
    expect(lastText(BUYER)).toContain('سفارش شما ثبت شد');
    expect(lastText(BUYER)).toContain('200,000');
  });

  it('shows out-of-stock products without quantity or add-to-cart buttons', async () => {
    await press(ADMIN, 'a:prod:field:1:inventory');
    await text(ADMIN, '0');
    await press(BUYER, 'prod:1');
    const card = sent(BUYER).filter((c) => c.method === 'sendPhoto').at(-1)!;
    expect(card.params.caption).toContain('ناموجود');
    expect(buttons(card).map((b) => b.callback_data)).toEqual(['cat:1']);
    await press(BUYER, 'cat:1');
    expect(buttons(lastWithButtons(BUYER)).some((b) => b.text.includes('⛔'))).toBe(true);
    await press(BUYER, 'add:1:1'); // an old button or a forged callback
    expect(lastText(BUYER)).toContain('موجودی کافی نیست');

    await press(ADMIN, 'a:prod:field:1:inventory');
    await text(ADMIN, '10');
    await press(BUYER, 'qty:1:50');
    expect(lastText(BUYER)).toContain('تعداد: <b>۱۰</b>'); // quantity is capped at the stock
  });

  it('hides products of a disabled category, even from old buttons', async () => {
    await press(ADMIN, 'a:cat:toggle:1');
    await press(BUYER, 'cat:1');
    expect(lastText(BUYER)).toContain('دسته‌بندی فعالی وجود ندارد');
    await press(BUYER, 'prod:1');
    expect(lastText(BUYER)).toContain('پیدا نشد');
    await press(BUYER, 'add:1:1');
    expect(lastText(BUYER)).toContain('پیدا نشد');
    await press(ADMIN, 'a:cat:toggle:1');
  });

  it('handles a redelivered update once and ignores group chats', async () => {
    const update = {
      update_id: ++updateId,
      callback_query: {
        id: 'dup', from: { id: BUYER, first_name: 'U2002' }, data: 'add:1:1',
        message: { message_id: 50, chat: { id: BUYER, type: 'private' } },
      },
    };
    const deliver = () =>
      send(`http://127.0.0.1:${WORKER_PORT}/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
        body: JSON.stringify(update),
      });
    await deliver();
    await deliver(); // Telegram retry of the same update
    await Promise.all([deliver(), deliver()]); // ... even two at the same moment
    await press(BUYER, 'cart');
    expect(lastText(BUYER)).toContain('تعداد: ۱');
    await press(BUYER, 'cart:clear');

    await post({ message: { message_id: ++messageId, from: { id: BUYER, first_name: 'U2002' }, chat: { id: GROUP, type: 'group' }, text: '/start' } });
    expect(sent(GROUP)).toHaveLength(0);
  });

  // A truly simultaneous race is covered deterministically in repositories.test.ts.
  it('takes stock once when approve is pressed twice', async () => {
    await text(BUYER2, '/start');
    await press(BUYER2, 'add:1:2');
    await press(BUYER2, 'checkout');
    await text(BUYER2, 'Sara Ahmadi');
    await text(BUYER2, 'آ'.repeat(400));
    expect(lastText(BUYER2)).toContain('طولانی'); // address length is limited
    await text(BUYER2, 'Shiraz, Zand St 5');
    await text(BUYER2, '09350000000');
    await photo(BUYER2, 'RECEIPT_B2');
    expect(lastText(BUYER2)).toContain('سفارش شما ثبت شد');

    const alert = sent(ADMIN).filter((c) => c.method === 'sendPhoto').at(-1)!;
    const approve = buttons(alert).find((b) => b.callback_data.startsWith('a:order:approve:'))!.callback_data;
    await Promise.all([press(ADMIN, approve), press(ADMIN, approve)]);
    await press(ADMIN, 'a:prod:1');
    expect(lastText(ADMIN)).toContain('<b>موجودی:</b> 8'); // 10 - 2, not 10 - 4
  });

  it('rejects a receipt photo that was already used for another order', async () => {
    await press(BUYER2, 'add:1:1');
    await checkoutToPayment(BUYER2, '09350000000');
    await photo(BUYER2, 'RECEIPT_B2');
    expect(lastText(BUYER2)).toContain('قبلاً استفاده شده');
    await photo(BUYER2, 'RECEIPT_B3');
    expect(lastText(BUYER2)).toContain('سفارش شما ثبت شد');
  });

  it('limits how many paid orders can wait for review at once', async () => {
    await placeOrder(BUYER2, 1, 'RECEIPT_B4');
    await placeOrder(BUYER2, 1, 'RECEIPT_B5');
    await press(BUYER2, 'add:1:1');
    await press(BUYER2, 'checkout');
    expect(lastText(BUYER2)).toContain('در حال بررسی است');
  });

  it('shows the admin every customer with their orders, and finds them by phone', async () => {
    await press(ADMIN, 'a:users');
    const list = buttons(lastWithButtons(ADMIN));
    expect(list.some((b) => b.text.includes('U2002'))).toBe(true);
    const sara = list.find((b) => b.text.includes('U3003'))!;
    expect(sara.text).toContain('🟡'); // has orders waiting for review

    await press(ADMIN, sara.callback_data);
    const page = lastWithButtons(ADMIN)!;
    expect(page.params.text).toContain('منتظر تایید: <b>۳</b>');
    expect(page.params.text).toContain('09350000000');
    expect(buttons(page).filter((b) => b.callback_data.startsWith('a:order:'))).toHaveLength(4);

    await press(ADMIN, 'a:users:find');
    await text(ADMIN, '0935000');
    const found = buttons(lastWithButtons(ADMIN)).filter((b) => b.callback_data.startsWith('a:user:'));
    expect(found.map((b) => b.callback_data)).toEqual([sara.callback_data]);
  });

  it('lets the admin block and unblock a customer', async () => {
    await press(ADMIN, 'a:users');
    const sara = buttons(lastWithButtons(ADMIN)).find((b) => b.text.includes('U3003'))!;
    const userId = sara.callback_data.split(':')[2];
    await press(ADMIN, `a:user:block:${userId}`);
    await text(BUYER2, '/start');
    expect(lastText(BUYER2)).toContain('محدود شده');
    await press(BUYER2, 'shop');
    expect(calls.at(-1)!.params).toMatchObject({ show_alert: true });

    await press(ADMIN, `a:user:block:${userId}`);
    await text(BUYER2, '/start');
    expect(lastText(BUYER2)).not.toContain('محدود شده');
  });

  it('stops answering a chat that floods the bot', async () => {
    for (let batch = 0; batch < 13; batch++) {
      await Promise.all(Array.from({ length: 10 }, () => text(FLOODER, 'hi')));
    }
    const answered = sent(FLOODER).length;
    expect(answered).toBeGreaterThanOrEqual(100);
    expect(answered).toBeLessThan(130);
  });

  it('apologises instead of going silent when the database fails', async () => {
    sql('ALTER TABLE faqs RENAME TO faqs_moved');
    try {
      await press(BUYER2, 'faqs');
      expect(lastText(BUYER2)).toContain('مشکلی موقتی پیش آمد');
      await press(BUYER2, 'faqs'); // at most once a minute per chat
      expect(sent(BUYER2).filter((c) => String(c.params.text).includes('مشکلی موقتی'))).toHaveLength(1);
    } finally {
      sql('ALTER TABLE faqs_moved RENAME TO faqs');
    }
    await press(BUYER2, 'faqs');
    expect(lastText(BUYER2)).not.toContain('مشکلی موقتی');
  });

  it('serves a status page that registers the webhook', async () => {
    const res = await fetch(`http://127.0.0.1:${WORKER_PORT}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('✅ فروشگاه اصلی');
    const hook = calls.filter((c) => c.method === 'setWebhook').at(-1)!;
    expect(hook.params).toMatchObject({ url: `http://127.0.0.1:${WORKER_PORT}/webhook`, secret_token: SECRET });
  });

  it('lets a seller become admin with /claim and the admin remove them', async () => {
    await text(CLAIMER, '/claim wrong-secret-123456');
    expect(lastText(CLAIMER)).toContain('اشتباه');
    await text(CLAIMER, `/claim ${SECRET}`);
    expect(lastText(CLAIMER)).toContain('ادمین این ربات شدید');
    await text(CLAIMER, '/start');
    expect(sent(CLAIMER).some((c) => String(c.params.text).includes('پنل مدیریت'))).toBe(true);

    await press(ADMIN, 'a:admins');
    expect(buttons(lastWithButtons(ADMIN)).map((b) => b.callback_data)).toContain(`a:admins:rm:${CLAIMER}`);
    await press(ADMIN, `a:admins:rm:${CLAIMER}`);
    await text(CLAIMER, '/start');
    expect(lastText(CLAIMER)).not.toContain('پنل مدیریت');
  });

  it('uses the shop name and tracking prefix the seller sets', async () => {
    await press(ADMIN, 'a:set:shop_name');
    await text(ADMIN, 'کتاب‌فروشی تست');
    await press(ADMIN, 'a:set:track_prefix');
    await text(ADMIN, 'ielts!');
    expect(lastText(ADMIN)).toContain('فقط حروف انگلیسی');
    await text(ADMIN, 'ielts');
    expect(lastText(ADMIN)).toContain('IELTS-XXXXX');

    await text(BUYER, '/start');
    expect(sent(BUYER).at(-2)!.params.text).toContain('کتاب‌فروشی تست');
    await press(BUYER, 'add:1:1');
    await checkoutToPayment();
    await photo(BUYER, 'RECEIPT_PREFIX');
    expect(lastText(BUYER)).toMatch(/<code>IELTS-[0-9A-Z]{5}<\/code>/);
  });

  it('shows orders awaiting review on the admin panel', async () => {
    await text(ADMIN, '/start');
    const root = sent(ADMIN).at(-2)!;
    expect(root.params.text).toContain('سفارش منتظر تایید شماست');
    expect(buttons(root)[0]!.text).toContain('🟡');
  });

  it('manages categories from one page: rename, icon, delete only when empty', async () => {
    await press(ADMIN, 'a:cats');
    expect(buttons(lastWithButtons(ADMIN)).some((b) => b.text.includes('Books') && b.text.includes('۱ محصول'))).toBe(true);
    await press(ADMIN, 'a:cat:1');
    expect(buttons(lastWithButtons(ADMIN)).map((b) => b.callback_data)).not.toContain('a:cat:del:1'); // has a product
    await press(ADMIN, 'a:cat:delok:1'); // even a forged confirm can't delete it
    expect(sent(ADMIN).some((c) => String(c.params.text).includes('محصول دارد و حذف نشد'))).toBe(true);

    await press(ADMIN, 'a:cat:edit:1:name');
    await text(ADMIN, 'کتاب‌ها');
    await press(ADMIN, 'a:cat:edit:1:icon');
    await text(ADMIN, '📕');
    expect(lastText(ADMIN)).toContain('📕 <b>کتاب‌ها</b>');

    await press(ADMIN, 'a:cat:add');
    await text(ADMIN, 'Empty');
    await text(ADMIN, '🗑');
    await press(ADMIN, 'a:cats');
    const empty = buttons(lastWithButtons(ADMIN)).find((b) => b.text.includes('Empty'))!;
    const id = empty.callback_data.split(':')[2];
    await press(ADMIN, `a:cat:del:${id}`);
    await press(ADMIN, `a:cat:delok:${id}`);
    await press(ADMIN, 'a:cats');
    expect(buttons(lastWithButtons(ADMIN)).some((b) => b.text.includes('Empty'))).toBe(false);
  });

  it('edits and deletes FAQs', async () => {
    await press(ADMIN, 'a:faq:add');
    await text(ADMIN, 'زمان ارسال؟');
    await text(ADMIN, '۲ روز');
    await press(ADMIN, 'a:faqs');
    const faq = buttons(lastWithButtons(ADMIN)).find((b) => b.text.includes('زمان ارسال'))!;
    const id = faq.callback_data.split(':')[2];
    await press(ADMIN, `a:faq:edit:${id}:answer`);
    await text(ADMIN, '۳ روز کاری');
    expect(lastText(ADMIN)).toContain('۳ روز کاری');
    await press(BUYER, `faq:${id}`);
    expect(lastText(BUYER)).toContain('۳ روز کاری');
    await press(ADMIN, `a:faq:del:${id}`);
    await press(ADMIN, `a:faq:delok:${id}`);
    await press(ADMIN, 'a:faqs');
    expect(buttons(lastWithButtons(ADMIN)).some((b) => b.text.includes('زمان ارسال'))).toBe(false);
  });
});
