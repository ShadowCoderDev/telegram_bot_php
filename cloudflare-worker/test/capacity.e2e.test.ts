/**
 * Capacity measurement: what each user action really costs in D1 (rows written / read, exactly as
 * Cloudflare counts them), measured on the real Worker. Prints a report and enforces budgets so a
 * future change can't silently make every message more expensive.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_WRITES_PER_UPDATE } from '../src/capacity';
import { derivedSecret } from '../src/crypto';
import { msg, photo, press, startWorker, type Cost, type Harness } from './harness';

const OWNER_SHOP_TOKEN = '1000:OWNERSHOPOWNERSHOPOWNERSHOPOWNER00';
const PLATFORM_TOKEN = '2000:PLATFORMPLATFORMPLATFORMPLATFORM00';
const SELLER_TOKEN = '30000:SELLERBOTSELLERBOTSELLERBOTSELLER0';
const WEBHOOK_SECRET = 'owner-shop-secret-0123456789';
const MASTER_KEY = 'k'.repeat(40);
const ADMIN = 11;
const CUSTOMER = 22;
const SELLER = 33;
const CUSTOMER2 = 44;

interface Row { group: string; label: string; cost: Cost }
const rows: Row[] = [];
let h: Harness;
let platformSecret = '';

async function measure(group: string, label: string, path: string, secret: string, update: object) {
  const cost = await h.post(path, secret, update);
  expect(cost.status, label).toBe(200);
  rows.push({ group, label, cost });
  return cost;
}
const shop = (group: string, label: string, update: object) => measure(group, label, '/webhook', WEBHOOK_SECRET, update);
const platform = (group: string, label: string, update: object) => measure(group, label, '/platform', platformSecret, update);
const total = (group: string) => rows.filter((r) => r.group === group).reduce((s, r) => ({ w: s.w + r.cost.written, r: s.r + r.cost.read, n: s.n + 1 }), { w: 0, r: 0, n: 0 });

beforeAll(async () => {
  platformSecret = await derivedSecret(MASTER_KEY, 'platform-webhook');
  h = await startWorker({
    port: 8797,
    inspectorPort: 9332,
    persist: '.wrangler/capacity-e2e',
    vars: {
      BOT_TOKEN: OWNER_SHOP_TOKEN, WEBHOOK_SECRET, ADMIN_CHAT_IDS: String(ADMIN),
      PLATFORM_BOT_TOKEN: PLATFORM_TOKEN, MASTER_KEY, PLATFORM_ADMIN_IDS: String(ADMIN), FLOOD_LIMIT: '1000',
    },
  });
});
afterAll(() => h?.stop());

describe('capacity', () => {
  it('measures every step of the main flows', async () => {
    // Admin sets up the catalogue.
    await shop('admin-setup', 'admin /start', msg(ADMIN, '/start'));
    await shop('admin-setup', 'add category (3 updates)', press(ADMIN, 'a:cat:add'));
    await shop('admin-setup', '', msg(ADMIN, 'Books'));
    await shop('admin-setup', '', msg(ADMIN, '📚'));
    await shop('admin-setup', 'add product (9 updates)', press(ADMIN, 'a:prod:add'));
    for (const t of ['IELTS Book', 'Great book', '120000', 'Author', '20']) await shop('admin-setup', '', msg(ADMIN, t));
    await shop('admin-setup', '', photo(ADMIN, 'PRODUCT_PHOTO'));
    await shop('admin-setup', '', press(ADMIN, 'a:prod:newcat:1'));

    // A customer browses.
    await shop('browse', 'first /start (new customer)', msg(CUSTOMER, '/start'));
    await shop('browse', '/start again', msg(CUSTOMER, '/start'));
    await shop('browse', 'categories', press(CUSTOMER, 'shop'));
    await shop('browse', 'category', press(CUSTOMER, 'cat:1'));
    await shop('browse', 'product card', press(CUSTOMER, 'prod:1'));
    await shop('browse', 'quantity +', press(CUSTOMER, 'qty:1:2'));
    await shop('browse', 'FAQs', press(CUSTOMER, 'faqs'));
    await shop('browse', 'my orders (none)', press(CUSTOMER, 'orders'));

    // ... and buys.
    await shop('purchase', 'add to cart (new cart)', press(CUSTOMER, 'add:1:2'));
    await shop('purchase', 'view cart', press(CUSTOMER, 'cart'));
    await shop('purchase', 'checkout', press(CUSTOMER, 'checkout'));
    await shop('purchase', 'name', msg(CUSTOMER, 'Ali Mohammadi'));
    await shop('purchase', 'address', msg(CUSTOMER, 'Tehran, Azadi Street 12'));
    await shop('purchase', 'phone (locks prices)', msg(CUSTOMER, '09123456789'));
    await shop('purchase', 'receipt photo', photo(CUSTOMER, 'RECEIPT'));

    // Admin handles the order.
    await shop('admin-order', 'panel', msg(ADMIN, '/start'));
    await shop('admin-order', 'order card', press(ADMIN, 'a:order:1'));
    await shop('admin-order', 'approve', press(ADMIN, 'a:order:approve:1'));
    await shop('admin-order', 'mark sent', press(ADMIN, 'a:order:send:1'));
    await shop('admin-order', 'customers list', press(ADMIN, 'a:users'));

    // A seller joins the platform and pays.
    await platform('platform', 'seller /start', msg(SELLER, '/start'));
    await platform('platform', 'new shop', press(SELLER, 'p:new'));
    await platform('platform', 'send token (creates shop)', msg(SELLER, SELLER_TOKEN));
    await platform('platform', 'renew → 1 month', press(SELLER, 'p:pay:2:1'));
    await platform('platform', 'receipt', photo(SELLER, 'SUB_RECEIPT'));
    const approve = h.calls.filter((c) => c.token === PLATFORM_TOKEN && c.method === 'sendPhoto').at(-1)!;
    const data = approve.params.reply_markup.inline_keyboard.flat().find((b: { callback_data?: string }) => b.callback_data?.startsWith('pa:pay:ok:')).callback_data;
    await platform('platform', 'owner approves', press(ADMIN, data));

    report();

    // Budgets: a change that makes these flows cost more rows fails here (numbers in CAPACITY.md).
    const BUDGET: Record<string, number> = { browse: 2, purchase: 5, 'admin-order': 2.5, 'admin-setup': 3, platform: 4.5 };
    for (const [group, perUpdate] of Object.entries(BUDGET)) {
      const t = total(group);
      expect(t.w / t.n, `${group}: rows written per update`).toBeLessThanOrEqual(perUpdate);
    }
    for (const r of rows) expect(r.cost.written, `${r.group} / ${r.label || 'step'}`).toBeLessThanOrEqual(12);
    expect(typicalMix(), 'typical mix').toBeLessThanOrEqual(DEFAULT_WRITES_PER_UPDATE);
  });

  it('keeps each step as cheap when the shop and the platform hold a lot of data', async () => {
    // This shop: 5,000 more customers with 20,000 orders. Another shop: 10,000 customers, 30,000 orders.
    await h.offline(() => {
      for (const [shopId, customers, perCustomer] of [[1, 5_000, 4], [99, 10_000, 3]] as const) {
        h.sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${customers})
               INSERT INTO users (shop_id, chat_id, name, username, created_at) SELECT ${shopId}, ${shopId * 10_000_000} + i, 'Customer ' || i, 'c' || i, 1700000000 + i FROM n`);
        h.sql(`WITH RECURSIVE k(j) AS (SELECT 1 UNION ALL SELECT j + 1 FROM k WHERE j < ${perCustomer})
               INSERT INTO orders (shop_id, user_id, user_chat_id, track_id, status, time)
               SELECT ${shopId}, u.id, u.chat_id, 'BULK-' || u.id || '-' || k.j,
                      CASE k.j % 4 WHEN 0 THEN 'sending' WHEN 1 THEN 'approved' WHEN 2 THEN 'cancel' ELSE 'approved' END, 1700000000 + u.id * 10 + k.j
                 FROM users u, k WHERE u.shop_id = ${shopId} AND u.chat_id > ${shopId * 10_000_000}`);
        h.sql(`INSERT INTO order_items (shop_id, order_id, product_id, quantity, price)
               SELECT ${shopId}, id, 1, 1, 120000 FROM orders WHERE shop_id = ${shopId} AND track_id LIKE 'BULK-%'`);
        h.sql(`INSERT INTO order_details (shop_id, order_id, first_name, last_name, address, phone_number)
               SELECT ${shopId}, id, 'Customer', '', 'Somewhere 1', '0912' || substr('0000000' || id, -7) FROM orders
                WHERE shop_id = ${shopId} AND track_id LIKE 'BULK-%' AND status != 'cancel'`);
      }
    });

    await shop('scale', 'first /start (new customer)', msg(CUSTOMER2, '/start'));
    await shop('scale', 'categories', press(CUSTOMER2, 'shop'));
    await shop('scale', 'category', press(CUSTOMER2, 'cat:1'));
    await shop('scale', 'product card', press(CUSTOMER2, 'prod:1'));
    await shop('scale', 'add to cart (new cart)', press(CUSTOMER2, 'add:1:1'));
    await shop('scale', 'view cart', press(CUSTOMER2, 'cart'));
    await shop('scale', 'checkout', press(CUSTOMER2, 'checkout'));
    await shop('scale', 'name', msg(CUSTOMER2, 'Sara Ahmadi'));
    await shop('scale', 'address', msg(CUSTOMER2, 'Shiraz, Zand Street 7'));
    await shop('scale', 'phone (locks prices)', msg(CUSTOMER2, '09120000000'));
    await shop('scale', 'receipt photo', photo(CUSTOMER2, 'RECEIPT2'));
    await shop('scale', 'my orders', press(CUSTOMER2, 'orders'));
    const { id } = h.query<{ id: number }>(`SELECT id FROM orders WHERE user_chat_id = ${CUSTOMER2} AND status = 'payed'`)[0]!;
    await shop('scale', 'panel', msg(ADMIN, '/start'));
    await shop('scale', 'order card', press(ADMIN, `a:order:${id}`));
    await shop('scale', 'approve', press(ADMIN, `a:order:approve:${id}`));
    await shop('scale', 'mark sent', press(ADMIN, `a:order:send:${id}`));
    await shop('scale', 'orders list', press(ADMIN, 'a:orders'));
    await shop('scale', 'customers list', press(ADMIN, 'a:users'));
    await shop('scale', 'stats', press(ADMIN, 'a:stats'));
    await shop('scale', 'stats again (reused for 10 min)', press(ADMIN, 'a:stats'));
    const code = h.query<{ track_id: string }>("SELECT track_id FROM orders WHERE shop_id = 1 AND track_id LIKE 'BULK-%' LIMIT 1 OFFSET 777")[0]!.track_id;
    const searches: [string, string][] = [['search by name', 'Customer 4321'], ['search by phone', '0935'], ['search by tracking code', code.toLowerCase()]];
    for (const [label, query] of searches) {
      await shop('scale', 'search (open)', press(ADMIN, 'a:users:find'));
      await shop('scale', label, msg(ADMIN, query));
    }

    const lines = ['| step | rows read (small shop) | rows read (5,000 customers, 20,000 orders) |', '|---|---:|---:|'];
    for (const r of rows.filter((r) => r.group === 'scale')) {
      const small = rows.find((s) => s.group !== 'scale' && s.label === r.label)?.cost.read;
      lines.push(`| ${r.label} | ${small ?? '–'} | ${r.cost.read} |`);
      // Customer steps and the order screens must not read more as the data grows.
      if (small !== undefined && r.label !== 'customers list') expect(r.cost.read, r.label).toBeLessThanOrEqual(small + 30);
    }
    const scaleText = lines.join('\n');
    writeFileSync('.wrangler/capacity-scale.md', scaleText + '\n');
    console.log(scaleText);
    // Admin pages stay bounded too: they read about one page of rows, not the whole shop.
    const scaleRead = (label: string) => rows.find((r) => r.group === 'scale' && r.label === label)!.cost.read;
    for (const label of ['orders list', 'customers list', 'stats again (reused for 10 min)', 'search by tracking code']) expect(scaleRead(label), label).toBeLessThan(500);
    // What still reads a whole shop (stats every 10 minutes, a name search): one table, not every order.
    for (const label of ['stats', 'search by name', 'search by phone']) expect(scaleRead(label), label).toBeLessThan(30_000);
  });
});

const perUpdate = (group: string) => total(group).w / total(group).n;
/** A typical shop day: mostly browsing, some buying, a little admin work. */
const typicalMix = () => 0.85 * perUpdate('browse') + 0.1 * perUpdate('purchase') + 0.05 * perUpdate('admin-order');

function report() {
  const groups = ['browse', 'purchase', 'admin-order', 'admin-setup', 'platform'];
  const lines = ['| group | step | rows written | rows read | queries |', '|---|---|---:|---:|---:|'];
  for (const r of rows) lines.push(`| ${r.group} | ${r.label || '↳'} | ${r.cost.written} | ${r.cost.read} | ${r.cost.queries} |`);
  lines.push('', '| flow | updates | rows written | per update | rows read |', '|---|---:|---:|---:|---:|');
  for (const g of groups) {
    const t = total(g);
    lines.push(`| ${g} | ${t.n} | ${t.w} | ${(t.w / t.n).toFixed(1)} | ${t.r} |`);
  }
  const mix = typicalMix();
  lines.push(
    '',
    `Typical mix (85% browsing, 10% buying, 5% admin): **${mix.toFixed(2)} rows written per update**, ` +
      `so about **${Math.floor(70_000 / mix).toLocaleString('en-US')} updates a day** fit in 70% of the free plan's 100,000 writes.`,
  );
  const text = lines.join('\n');
  mkdirSync('.wrangler', { recursive: true });
  writeFileSync('.wrangler/capacity-report.md', text + '\n');
  console.log(text);
}
