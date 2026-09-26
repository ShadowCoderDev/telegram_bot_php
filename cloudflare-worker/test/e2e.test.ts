/**
 * End-to-end: runs the real Worker in `wrangler dev` (local D1 + R2) against a fake Telegram API,
 * then plays an admin and a customer through the whole shop flow.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ADMIN = 1001;
const BUYER = 2002;
const SECRET = 'e2e-secret';
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
  return fetch(`http://127.0.0.1:${WORKER_PORT}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify({ update_id: ++updateId, ...update }),
  });
}
const text = (chat: number, t: string) =>
  post({ message: { message_id: ++messageId, from: { id: chat, first_name: `U${chat}` }, chat: { id: chat, type: 'private' }, text: t } });
const photo = (chat: number, fileId = 'RECEIPT_BIG') =>
  post({
    message: {
      message_id: ++messageId, from: { id: chat, first_name: `U${chat}` }, chat: { id: chat, type: 'private' },
      photo: [{ file_id: 'small', file_unique_id: 's', width: 1, height: 1 }, { file_id: fileId, file_unique_id: 'b', width: 9, height: 9 }],
    },
  });
const setPrice = async (productId: number, price: string) => {
  await press(ADMIN, `a:prod:field:${productId}:price`);
  await text(ADMIN, price);
};
const sql = (command: string) =>
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'shop', '--local', '--persist-to', PERSIST, '--command', command], { stdio: 'ignore' });
const checkoutToPayment = async () => {
  await press(BUYER, 'checkout');
  await text(BUYER, 'Ali Mohammadi');
  await text(BUYER, 'Tehran');
  await text(BUYER, '09123456789');
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

  rmSync(PERSIST, { recursive: true, force: true });
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'shop', '--local', '--persist-to', PERSIST], { stdio: 'ignore' });

  worker = spawn('npx', [
    'wrangler', 'dev', '--port', String(WORKER_PORT), '--ip', '127.0.0.1', '--persist-to', PERSIST,
    '--var', `BOT_TOKEN:${TOKEN}`, '--var', `WEBHOOK_SECRET:${SECRET}`,
    '--var', `ADMIN_CHAT_IDS:${ADMIN}`, '--var', `TELEGRAM_API_BASE:http://127.0.0.1:${tgPort}`,
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
    expect(lastText(BUYER)).toContain('IELTS-');
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

    await photo(BUYER);
    const recent = sent(BUYER).slice(-2).map((c) => String(c.params.text));
    expect(recent[0]).toContain('مبلغ سفارش به‌روز شد');
    expect(recent[1]).toContain('200,000 تومان');

    await photo(BUYER);
    expect(lastText(BUYER)).toContain('سفارش شما ثبت شد');
    expect(lastText(BUYER)).toContain('200,000');
  });
});
