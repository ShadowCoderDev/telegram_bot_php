/**
 * Order scheduling end to end: the seller switches it on for a category, a customer picks a day and
 * time while checking out, the time is held and then booked, a full time disappears for others, and
 * the seller sees the agenda.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { msg, photo, press, startWorker, type Call, type Harness } from './harness';

const TOKEN = '1000:OWNERSHOPOWNERSHOPOWNERSHOPOWNER00';
const SECRET = 'owner-shop-secret-0123456789';
const ADMIN = 11;
const ALI = 22;
const SARA = 33;
const REZA = 44;
let h: Harness;

const post = (update: object) => h.post('/webhook', SECRET, update);
const text = (chat: number, t: string) => post(msg(chat, t));
const tap = (chat: number, data: string) => post(press(chat, data));
const sent = (chat: number): Call[] => h.calls.filter((c) => c.params.chat_id === chat && c.method !== 'answerCallbackQuery');
const last = (chat: number) => String(sent(chat).at(-1)?.params.text ?? sent(chat).at(-1)?.params.caption ?? '');
const buttons = (chat: number): { text: string; callback_data?: string }[] =>
  (sent(chat).filter((c) => c.params.reply_markup?.inline_keyboard).at(-1)?.params.reply_markup?.inline_keyboard ?? []).flat();
const data = (chat: number, prefix: string) => buttons(chat).map((b) => b.callback_data ?? '').filter((x) => x.startsWith(prefix));
const count = (sql: string): number => Number(Object.values(h.query<Record<string, unknown>>(sql)[0]!)[0]);

/** Walks a customer to the time picker of category 1 and returns the offered day and times. */
async function startCheckout(chat: number, product = 1) {
  await tap(chat, `add:${product}:1`);
  await tap(chat, 'checkout');
}

beforeAll(async () => {
  h = await startWorker({
    port: 8795,
    inspectorPort: 9334,
    persist: '.wrangler/schedule-e2e',
    vars: { BOT_TOKEN: TOKEN, WEBHOOK_SECRET: SECRET, ADMIN_CHAT_IDS: String(ADMIN), FLOOD_LIMIT: '1000' },
  });
  h.sql("INSERT INTO categories (id, shop_id, name, icon) VALUES (1, 1, 'Visits', '🩺'), (2, 1, 'Books', '📚')");
  h.sql("INSERT INTO products (id, shop_id, category_id, title, description, price, author, inventory) VALUES (1, 1, 1, 'General visit', 'x', 100000, 'Dr', 50), (2, 1, 2, 'A book', 'x', 50000, 'Au', 50)");
});
afterAll(() => h?.stop());

describe('order scheduling', () => {
  it('is off until the seller switches it on, and then needs a schedule per category', async () => {
    await tap(ADMIN, 'a:settings');
    expect(data(ADMIN, 'a:sch')).toContain('a:sch');
    await tap(ADMIN, 'a:sch');
    expect(buttons(ADMIN).map((b) => b.text).join(' ')).toContain('روشن کردن زمان‌بندی');

    // Off: customers are not asked for a time, and no hint is shown.
    await tap(ALI, 'prod:1');
    expect(last(ALI)).not.toContain('📅');
    await tap(ALI, 'add:1:1');
    await tap(ALI, 'checkout');
    expect(last(ALI)).toContain('مرحله ۱ از ۴'); // name, address, phone, payment
    await text(ALI, '/start');

    await tap(ADMIN, 'a:sch:toggle');
    expect(last(ADMIN)).toContain('روشن است');
    expect(buttons(ADMIN).map((b) => b.text).join(' ')).toContain('Visits · ➕ تنظیم نشده');
    await tap(ADMIN, 'a:sch:cat:1');
    expect(data(ADMIN, 'a:sch:preset:1:')).toEqual(['a:sch:preset:1:food', 'a:sch:preset:1:visit', 'a:sch:preset:1:pickup', 'a:sch:preset:1:manual']);
  });

  it('sets a schedule from a template and by hand', async () => {
    await tap(ADMIN, 'a:sch:preset:1:visit');
    expect(last(ADMIN)).toContain('شنبه تا چهارشنبه');
    expect(last(ADMIN)).toContain('۱ سفارش');
    expect(last(ADMIN)).toContain('نزدیک‌ترین زمان');

    await tap(ADMIN, 'a:sch:dayset:1:127'); // every day
    expect(last(ADMIN)).toContain('روزهای کاری');
    await tap(ADMIN, 'a:sch:times:1');
    await text(ADMIN, '99:99');
    expect(last(ADMIN)).toContain('معتبری نیست');
    await text(ADMIN, '10:00 11:00');
    expect(last(ADMIN)).toContain('۱۰:۰۰، ۱۱:۰۰');
    await tap(ADMIN, 'a:sch:set:1:lead:0');
    await tap(ADMIN, 'a:sch:set:1:hor:3');
    await tap(ADMIN, 'a:sch:set:1:cap:99999'); // not an offered value: ignored
    expect(last(ADMIN)).toContain('۱ سفارش');
    await tap(ADMIN, 'a:sch:label:1');
    await text(ADMIN, 'زمان ویزیت');
    expect(last(ADMIN)).toContain('زمان‌بندی: زمان ویزیت');
  });

  it('shows the customer a hint, then asks for a day and a time before anything else', async () => {
    await tap(ALI, 'prod:1');
    expect(last(ALI)).toContain('این محصول با انتخاب <b>زمان ویزیت</b>');
    await tap(ALI, 'add:1:1');
    await tap(ALI, 'cart');
    expect(last(ALI)).toContain('این سفارش <b>زمان ویزیت</b> می‌خواهد');

    await tap(ALI, 'checkout');
    expect(last(ALI)).toContain('مرحله ۱ از ۵'); // day/time, name, address, phone, payment
    const days = data(ALI, 'sd:1:');
    expect(days).toHaveLength(3);

    await text(ALI, 'hello?'); // text at a button step
    expect(last(ALI)).toContain('از دکمه‌ها انتخاب کنید');

    await tap(ALI, days[1]!);
    const times = data(ALI, 'sl:1:');
    expect(times).toHaveLength(2);
    await tap(ALI, times[0]!);
    expect(last(ALI)).toContain('زمان ویزیت:');
    expect(last(ALI)).toContain('<b>نام</b>');
    expect(last(ALI)).toContain('مرحله ۲ از ۵');
    expect(count('SELECT count(*) FROM order_slots')).toBe(1);

    await tap(ALI, 'co:tgname');
    await text(ALI, 'Tehran');
    await text(ALI, '09123456789');
    expect(last(ALI)).toContain('مبلغ قابل پرداخت');
    expect(last(ALI)).toContain('مرحله ۵ از ۵');
  });

  it('holds the time: another customer no longer sees it, and a forged button is refused', async () => {
    const aliSlot = h.query<{ slot_at: number }>('SELECT slot_at FROM order_slots')[0]!.slot_at;
    await startCheckout(SARA);
    const day = data(SARA, 'sd:1:').find((d) => d === `sd:1:${Math.floor((aliSlot + 12600) / 86400)}`)!;
    await tap(SARA, day);
    expect(data(SARA, 'sl:1:')).toHaveLength(1);
    expect(data(SARA, 'sl:1:')).not.toContain(`sl:1:${aliSlot}`);

    await tap(SARA, `sl:1:${aliSlot}`); // forged: it's held by someone else
    expect(last(SARA)).toContain('رزرو شد');
    expect(count('SELECT count(*) FROM order_slots')).toBe(1);
    await tap(SARA, 'sl:1:12345'); // not a time of the schedule at all
    expect(count('SELECT count(*) FROM order_slots')).toBe(1);

    // Taking the last one, then giving up, gives the time back.
    await tap(SARA, day); // a refused pick shows the days again
    await tap(SARA, data(SARA, 'sl:1:')[0]!);
    expect(count('SELECT count(*) FROM order_slots')).toBe(2);
    await tap(SARA, 'co:cancel');
    expect(count('SELECT count(*) FROM order_slots')).toBe(1);
    expect(last(SARA)).toContain('سبد خرید');

    // Leaving the checkout some other way does too.
    await text(SARA, '/start');
    await startCheckout(SARA);
    await tap(SARA, day);
    expect(data(SARA, 'sl:1:')).toHaveLength(1); // still taken by Ali, whose hold is alive
    await text(SARA, '/start');
  });

  it('books the time when the receipt arrives; the seller sees it on the order and in the agenda', async () => {
    await post(photo(ALI, 'RECEIPT'));
    expect(last(ALI)).toContain('سفارش شما ثبت شد');
    expect(last(ALI)).toContain('زمان ویزیت:');
    const alert = sent(ADMIN).filter((c) => c.method === 'sendPhoto').at(-1)!;
    expect(String(alert.params.caption)).toContain('زمان ویزیت:');
    expect(String(alert.params.caption)).toContain('👤 U22');

    const day = Math.floor((h.query<{ slot_at: number }>('SELECT slot_at FROM order_slots')[0]!.slot_at + 12600) / 86400);
    await tap(ADMIN, 'a:root');
    expect(data(ADMIN, 'a:agenda')).toEqual(['a:agenda']);
    await tap(ADMIN, `a:agenda:${day}`);
    expect(last(ADMIN)).toContain('U22');
    expect(last(ADMIN)).toContain('09123456789');
    expect(last(ADMIN)).toContain('🟡');
    await tap(ADMIN, `a:agenda:${day + 1}`);
    expect(last(ADMIN)).toContain('ثبت نشده');

    await tap(ALI, 'orders');
    expect(last(ALI)).toContain('زمان ویزیت:');

    await tap(ADMIN, 'a:order:approve:1');
    expect(last(11)).toContain('زمان ویزیت:');
    expect(sent(ALI).at(-1)!.params.text).toContain('تایید شد');
    expect(String(sent(ALI).at(-1)!.params.text)).toContain('زمان ویزیت:');
  });

  it('still hides a booked time from others, and gives it back when the order is rejected', async () => {
    const slot = h.query<{ slot_at: number }>('SELECT slot_at FROM order_slots')[0]!.slot_at;
    const day = Math.floor((slot + 12600) / 86400);
    await startCheckout(REZA);
    await tap(REZA, `sd:1:${day}`);
    expect(data(REZA, 'sl:1:')).not.toContain(`sl:1:${slot}`);
    await text(REZA, '/start');

    await tap(ADMIN, 'a:order:reject:1');
    await startCheckout(REZA);
    await tap(REZA, `sd:1:${day}`);
    expect(data(REZA, 'sl:1:')).toContain(`sl:1:${slot}`);
    await text(REZA, '/start');
  });

  it('does not ask for a time for a category without a schedule', async () => {
    await tap(SARA, 'cart:clear');
    await tap(SARA, 'add:2:1');
    await tap(SARA, 'checkout');
    expect(last(SARA)).toContain('مرحله ۱ از ۴');
    await text(SARA, '/start');
  });

  it('takes closed days out of the choices', async () => {
    await startCheckout(SARA);
    const days = data(SARA, 'sd:1:').map((d) => Number(d.split(':')[2]));
    await text(SARA, '/start');

    await tap(ADMIN, 'a:sch:closed');
    expect(last(ADMIN)).toContain('روزهای تعطیل');
    await tap(ADMIN, `a:sch:closed:${days[1]}`);
    expect(buttons(ADMIN).some((b) => b.callback_data === `a:sch:closed:${days[1]}` && b.text.startsWith('⛔'))).toBe(true);

    await startCheckout(SARA);
    expect(data(SARA, 'sd:1:').map((d) => Number(d.split(':')[2]))).toEqual(days.filter((x) => x !== days[1]));
    await text(SARA, '/start');
    await tap(ADMIN, `a:sch:closed:${days[1]}`);
  });

  it('tells the customer when nothing is free, before asking for any detail', async () => {
    await tap(ADMIN, 'a:sch:set:1:lead:1440');
    await tap(ADMIN, 'a:sch:set:1:hor:1');
    await startCheckout(SARA);
    expect(last(SARA)).toContain('فعلاً زمان خالی نداریم');
    expect(count("SELECT count(*) FROM sessions WHERE chat_id = 33")).toBe(0);
    await tap(ADMIN, 'a:sch:set:1:lead:0');
    await tap(ADMIN, 'a:sch:set:1:hor:3');
  });

  it('asks one time per scheduled category when the cart mixes them, and books both', async () => {
    await tap(ADMIN, 'a:sch:cat:2');
    await tap(ADMIN, 'a:sch:preset:2:pickup');
    await tap(ADMIN, 'a:sch:times:2');
    await text(ADMIN, '10:00');
    await tap(ADMIN, 'a:sch:set:2:lead:0');
    await tap(ADMIN, 'a:sch:set:2:hor:3');
    await tap(ADMIN, 'a:sch:set:2:cap:0');

    await tap(REZA, 'cart:clear');
    await tap(REZA, 'add:1:1');
    await tap(REZA, 'add:2:1');
    await tap(REZA, 'cart');
    expect(last(REZA)).toContain('چند زمان می‌خواهد');
    await tap(REZA, 'checkout');
    expect(last(REZA)).toContain('مرحله ۱ از ۶'); // two times, name, address, phone, payment
    expect(last(REZA)).toContain('Visits');
    await tap(REZA, data(REZA, 'sd:1:')[2]!);
    await tap(REZA, data(REZA, 'sl:1:')[0]!);
    expect(last(REZA)).toContain('مرحله ۲ از ۶');
    expect(last(REZA)).toContain('Books');
    await tap(REZA, data(REZA, 'sd:2:')[0]!);
    await tap(REZA, data(REZA, 'sl:2:')[0]!);
    expect(last(REZA)).toContain('مرحله ۳ از ۶');
    await tap(REZA, 'co:tgname');
    await text(REZA, 'Shiraz');
    await text(REZA, '09120000000');
    await post(photo(REZA, 'RECEIPT_REZA'));
    const orderId = count("SELECT id FROM orders WHERE user_chat_id = 44 AND status = 'payed'");
    expect(count(`SELECT count(*) FROM order_slots WHERE order_id = ${orderId}`)).toBe(2);
    expect((last(REZA).match(/📅/g) ?? []).length).toBe(2);
    await tap(ADMIN, `a:order:${orderId}`);
    expect(last(ADMIN)).toContain('(🩺 Visits)'); // two times on one order: each says which category
    await tap(ADMIN, `a:order:reject:${orderId}`);
    await tap(ADMIN, 'a:sch:del:2');
    await tap(ADMIN, 'a:sch:delok:2');
  });

  it('lets go of a checkout whose schedule was switched off while the customer was choosing', async () => {
    await tap(SARA, 'cart:clear');
    await startCheckout(SARA);
    const day = data(SARA, 'sd:1:')[0]!;
    await tap(ADMIN, 'a:sch:en:1'); // the seller switches this category's schedule off
    await tap(SARA, day);
    expect(last(SARA)).toContain('دیگر معتبر نیست');
    expect(count('SELECT count(*) FROM sessions WHERE chat_id = 33')).toBe(0);
    await tap(ADMIN, 'a:sch:en:1');
  });

  it('keeps a paid booking when the schedule is switched off, and stops asking', async () => {
    await tap(ADMIN, 'a:sch:toggle');
    await tap(SARA, 'cart:clear');
    await startCheckout(SARA);
    expect(last(SARA)).toContain('مرحله ۱ از ۴');
    expect(count('SELECT count(*) FROM order_slots')).toBeGreaterThanOrEqual(1);
    await text(SARA, '/start');
  });
});
