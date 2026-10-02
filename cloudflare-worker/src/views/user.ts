import type { Category, Faq, Order, OrderLine, Product } from '../db/models';
import { MAX_QTY, cartTotal, type StockProblem } from '../services/CartService';
import { STATUS_FA } from '../services/orderStatus';
import { backRow, button, inline, replyKeyboard } from '../telegram/keyboard';
import type { InlineKeyboardButton, View } from '../telegram/types';
import { escapeHtml as e, money, truncate } from '../utils/format';
import { formatPersianDate } from '../utils/persian';
import { CB } from './callbacks';
import { cartScheduleHint, productScheduleHint, slotLines } from './slots';
import type { OrderSlotInfo, ScheduledCategory } from '../db/schedule';
import type { CheckoutField } from '../services/checkoutFields';
import type { Schedule } from '../services/schedule';
import { HR, contactLines, expandable, fa, heading, hint, itemsWithTotal, progress, quote, sections, toman } from './common';

const homeRow = (label = '🏠 منوی اصلی') => backRow(CB.home, label);

/** Labels of the persistent reply keyboard; handlers match on the same constants. */
export const MENU = {
  shop: '🛍️ خرید محصول',
  cart: '🛒 سبد خرید',
  orders: '✉️ سفارشات من',
  support: '🗣️ پشتیبانی',
  faqs: '❓ سوالات متداول',
  home: '🏠 پنل اصلی',
} as const;

export const persistentKeyboard = (): View => ({
  text: hint('👇 از منوی پایین هم می‌توانید سریع به بخش‌ها دسترسی داشته باشید.'),
  keyboard: replyKeyboard([[MENU.shop], [MENU.cart, MENU.orders], [MENU.support, MENU.faqs], [MENU.home]]),
});

/** The shop's own name and welcome text, set by the seller in the admin settings. */
export interface ShopInfo {
  shop_name: string;
  welcome_text: string;
}

export const mainKeyboard = () =>
  inline(
    [button('🛍️ خرید محصول', CB.shop, 'primary')],
    [button('🛒 سبد خرید', CB.cart), button('✉️ سفارشات من', CB.myOrders)],
    [button('⚡️ راهنمای سریع', CB.help), button('🗣️ پشتیبانی', CB.support)],
    [button('❓ سوالات متداول', CB.faqs)],
  );

export const mainMenu = (firstName: string, shop: ShopInfo): View => ({
  text: sections(
    `👋 سلام <b>${e(firstName)}</b>!\n🛍 <b>${e(shop.shop_name)}</b>`,
    quote(e(shop.welcome_text)),
    '👇 یکی از گزینه‌های زیر را انتخاب کنید:',
  ),
  keyboard: mainKeyboard(),
});

export const categoriesView = (categories: Category[]): View =>
  categories.length
    ? {
        text: sections(heading('🗂', 'دسته‌بندی محصولات'), '👇 دسته‌بندی مورد نظرتان را انتخاب کنید:'),
        keyboard: inline(...categories.map((c) => [button(`${c.icon} ${c.name}`, CB.category(c.id))]), homeRow()),
      }
    : { text: sections(heading('😕', 'فعلاً دسته‌بندی فعالی وجود ندارد'), hint('کمی بعد دوباره سر بزنید.')), keyboard: inline(homeRow()) };

export const categoryProductsView = (category: Category | null, products: Product[]): View => {
  const name = category ? `${category.icon} ${e(category.name)}` : '📂 دسته‌بندی';
  return {
    text: products.length
      ? sections(`<b>${name}</b>`, '👇 محصول مورد نظرتان را انتخاب کنید:', hint('💡 با انتخاب هر محصول، قیمت و جزئیات کامل آن نمایش داده می‌شود.'))
      : sections(`<b>${name}</b>`, '😕 فعلاً محصول فعالی در این دسته‌بندی وجود ندارد.'),
    keyboard: inline(
      ...products.map((p) => [
        button(p.inventory > 0 ? `${truncate(p.title, 30)} · ${money(p.price)} ت` : `⛔ ${truncate(p.title, 30)} · ناموجود`, CB.product(p.id)),
      ]),
      backRow(CB.shop, '🔙 دسته‌بندی‌ها'),
    ),
  };
};

export const productNotFound = (): View => ({
  text: sections(heading('❌', 'این محصول پیدا نشد'), hint('ممکن است حذف یا غیرفعال شده باشد.')),
  keyboard: inline(backRow(CB.shop, '🔙 دسته‌بندی‌ها')),
});

const CAPTION_LIMIT = 1024;

const stockLine = (inventory: number): string =>
  inventory <= 0
    ? `⛔ <b>ناموجود</b>\n${hint('به‌زودی دوباره موجود می‌شود؛ بعداً سر بزنید.')}`
    : inventory <= 5
      ? `🔥 فقط <b>${fa(inventory)}</b> عدد باقی مانده`
      : '✅ موجود در انبار';

/** `schedule`: the product's category asks for a day and time when ordering. */
export const productCard = (p: Product, qty: number, schedule: Pick<Schedule, 'label'> | null = null): View => {
  const head = sections(
    `📘 <b>${e(p.title)}</b>` + (p.author ? `\n✍️ ${hint(e(p.author))}` : ''),
    p.inventory > 0
      ? quote(`💰 قیمت واحد: <b>${toman(p.price)}</b>\n🔢 تعداد: <b>${fa(qty)}</b>\n💵 جمع: <b>${toman(p.price * qty)}</b>`)
      : quote(`💰 قیمت: <b>${toman(p.price)}</b>`),
    stockLine(p.inventory),
    productScheduleHint(schedule),
  );
  const descTitle = '\n\n📝 <b>توضیحات</b>\n';
  let desc = e(p.description);
  if (p.image_file_id && head.length + descTitle.length + desc.length + 40 > CAPTION_LIMIT) {
    // Photo captions are capped at 1024 characters; shorten the description rather than drop the photo.
    desc = e(truncate(p.description, CAPTION_LIMIT - head.length - descTitle.length - 80));
  }
  const body = head + (p.description ? descTitle + expandable(desc) : '');
  const back = backRow(CB.category(p.category_id ?? 0), '🔙 بازگشت به لیست');
  const max = Math.min(MAX_QTY, p.inventory);
  // Out of stock: nothing to choose or add – only the way back.
  const keyboard =
    p.inventory <= 0
      ? inline(back)
      : inline(
          [
            button('➖', qty > 1 ? CB.qty(p.id, qty - 1) : CB.noop),
            button(fa(qty), CB.noop),
            button('➕', qty < max ? CB.qty(p.id, qty + 1) : CB.noop),
          ],
          [button('🛒 افزودن به سبد خرید', CB.add(p.id, qty), 'success')],
          back,
        );
  if (p.image_file_id) return { photo: p.image_file_id, text: body, keyboard };
  // A zero-width link makes Telegram show a linked image as a preview above the text.
  const preview = p.image_url ? `<a href="${e(p.image_url)}">&#8203;</a>` : '';
  return { text: preview + body, keyboard };
};

export const addedToCart = (title: string, qty: number): View => ({
  text: sections(heading('✅', 'به سبد خرید اضافه شد'), quote(`📦 ${e(title)}\n🔢 تعداد: <b>${fa(qty)}</b>`)),
  keyboard: inline([button('🛒 مشاهده سبد و تکمیل خرید', CB.cart, 'success')], [button('🔎 ادامه خرید', CB.shop)]),
});

export const notEnoughStock = (p: Product, inCart: number, qty: number): View => ({
  text: sections(
    heading('⚠️', 'موجودی کافی نیست'),
    quote(
      `📦 ${e(p.title)}\n` +
        `🏷 موجودی انبار: <b>${fa(p.inventory)}</b> عدد` +
        (inCart ? `\n🛒 در سبد شما: <b>${fa(inCart)}</b> عدد\n➕ درخواست جدید: <b>${fa(qty)}</b> عدد` : ''),
    ),
    hint('لطفاً تعداد کمتری انتخاب کنید.'),
  ),
  keyboard: inline(backRow(CB.product(p.id), '🔙 بازگشت به محصول')),
});

export const emptyCart = (): View => ({
  text: sections(heading('🛒', 'سبد خرید شما خالی است'), hint('از بخش «خرید محصول» محصولات را به سبد اضافه کنید.')),
  keyboard: inline([button('🛍️ خرید محصول', CB.shop, 'primary')], homeRow()),
});

export const cartView = (lines: OrderLine[], scheduled: ScheduledCategory[] = []): View => ({
  text: sections(heading('🛒', 'سبد خرید شما'), itemsWithTotal(lines, 'مبلغ قابل پرداخت'), cartScheduleHint(scheduled), hint('💡 قیمت‌ها هنگام تکمیل خرید نهایی می‌شوند.')),
  keyboard: inline(
    [button('💳 تکمیل خرید', CB.checkout, 'success')],
    ...lines.map((l) => [button(`🗑 حذف «${truncate(l.title, 25)}»`, CB.removeItem(l.item_id))]),
    [button('❌ خالی کردن سبد', CB.clearCart, 'danger'), button('🔙 بازگشت', CB.home)],
  ),
});

export const stockProblemsView = (problems: StockProblem[]): View => ({
  text: sections(
    heading('⚠️', 'کمبود موجودی'),
    'این محصولات به تعداد درون سبد شما موجود نیستند:',
    quote(problems.map((p) => (p.available ? `📦 ${e(p.title)} — موجودی: <b>${fa(p.inventory)}</b>` : `📦 ${e(p.title)} — <b>دیگر فروخته نمی‌شود</b>`)).join('\n')),
    hint('لطفاً سبد خرید را ویرایش کنید و دوباره تلاش کنید.'),
  ),
  keyboard: inline([button('🛒 ویرایش سبد خرید', CB.cart, 'primary')]),
});

export const myOrdersView = (orders: Order[], lines: Map<number, OrderLine[]>, slots: Map<number, OrderSlotInfo[]> = new Map()): View => {
  if (!orders.length) {
    return {
      text: sections(heading('📑', 'سفارشات شما'), 'هنوز سفارش ثبت‌شده‌ای ندارید.'),
      keyboard: inline([button('🛍️ خرید محصول', CB.shop, 'primary')], homeRow()),
    };
  }
  const blocks = orders.map((o) =>
    sections(
      `🧾 سفارش <code>${o.track_id}</code>\n🗓 ${formatPersianDate(o.time)}\n📌 وضعیت: <b>${STATUS_FA[o.status]}</b>`,
      slotLines(slots.get(o.id) ?? []),
      itemsWithTotal(lines.get(o.id) ?? []),
    ),
  );
  return {
    text: sections(heading('📑', `${fa(orders.length)} سفارش آخر شما`), blocks.join(`\n\n${HR}\n\n`)),
    keyboard: inline(homeRow()),
  };
};

export const faqsView = (faqs: Faq[]): View =>
  faqs.length
    ? {
        text: sections(heading('❓', 'سوالات متداول'), '👇 سوال خود را انتخاب کنید تا پاسخ آن نمایش داده شود:'),
        keyboard: inline(...faqs.map((f) => [button(`▫️ ${truncate(f.question, 50)}`, CB.faq(f.id))]), homeRow()),
      }
    : { text: sections(heading('❓', 'سوالات متداول'), hint('هنوز سوالی ثبت نشده است.')), keyboard: inline(homeRow()) };

export const faqAnswerView = (f: Faq): View => ({
  text: sections(`❓ <b>${e(f.question)}</b>`, quote(`✅ ${e(f.answer)}`)),
  keyboard: inline(backRow(CB.faqs, '🔙 بازگشت به سوالات')),
});

export const helpView = (help: string): View => ({
  text: sections(heading('⚡️', 'راهنمای سریع'), quote(e(help))),
  keyboard: inline(homeRow()),
});

export const supportView = (support: string): View => ({
  text: sections(
    heading('🗣️', 'پشتیبانی'),
    'سوال، مشکل یا پیشنهادی دارید؟ از این راه با ما در تماس باشید:',
    quote(`<b>${e(support)}</b>`),
    hint('معمولاً در کمتر از چند ساعت پاسخ می‌دهیم 🙏'),
  ),
  keyboard: inline(homeRow()),
});

/** A short message that never leaves the customer stuck: always a way back. */
export const notice = (text: string, ...extra: InlineKeyboardButton[][]): View => ({ text, keyboard: inline(...extra, homeRow()) });

/* ---------- checkout ---------- */

/** Step `n` of `total` (the enabled checkout fields, then payment). */
export const stepView = (n: number, total: number, body: string, example?: string): View => ({
  text: sections(`${heading('🧾', 'تکمیل خرید')}\n${progress(n, total)}`, body, example && hint(`مثال: ${example}`)),
  keyboard: inline(cancelCheckoutRow()),
});
const cancelCheckoutRow = () => [button('❌ انصراف از خرید', CB.cancelCheckout)];

export const checkoutPrompts = {
  name: (n: number, total: number, telegramName: string): View => ({
    ...stepView(n, total, '👤 لطفاً <b>نام</b> خود را بفرستید:', 'علی محمدی'),
    ...(telegramName.trim() && { keyboard: inline([button(`✅ همان «${truncate(telegramName, 24)}»`, CB.useTelegramName, 'primary')], cancelCheckoutRow()) }),
  }),
  badName: (): View => ({ text: sections('⚠️ لطفاً <b>نام</b> خود را بفرستید.', hint('مثال: علی')), keyboard: inline(cancelCheckoutRow()) }),
  address: (n: number, total: number) => stepView(n, total, '📍 لطفاً <b>آدرس</b> خود را بفرستید:', 'تهران، خیابان آزادی، پلاک ۱۲'),
  phone: (n: number, total: number) => stepView(n, total, '📱 لطفاً <b>شماره موبایل</b> خود را بفرستید:', '09123456789'),
  badPhone: (): View => ({ text: sections('⚠️ شماره موبایل معتبر نیست.', hint('شماره باید ۱۱ رقم باشد و با ۰۹ شروع شود. مثال: 09123456789')), keyboard: inline(cancelCheckoutRow()) }),
  payment: (n: number, total: number, bankInfo: string, amount: number, validMinutes: number): View =>
    stepView(
      n,
      total,
      sections(
        `💰 <b>مبلغ قابل پرداخت</b>\n${quote(`<b>${toman(amount)}</b>`)}`,
        `💳 <b>اطلاعات واریز</b> ${hint('(برای کپی لمس کنید)')}\n<code>${e(bankInfo)}</code>`,
        '📸 بعد از واریز، <b>عکس رسید</b> را همین‌جا بفرستید.',
        hint(`⏳ این مبلغ تا ${fa(validMinutes)} دقیقه معتبر است.`),
      ),
    ),
  needImage: (): View => ({
    text: sections(
      heading('📸', 'منتظر عکس رسید هستیم'),
      quote('• عکس را به صورت <b>Photo</b> بفرستید\n• یا فایل تصویری (jpg / png / webp)'),
      hint('متن یا فایل‌های دیگر پذیرفته نمی‌شوند.'),
    ),
    keyboard: inline(cancelCheckoutRow()),
  }),
  pricesChanged: (): View => ({
    text: sections(
      heading('🔄', 'مبلغ سفارش به‌روز شد'),
      'زمان اعتبار مبلغ قبلی تمام شده یا سبد خرید تغییر کرده است. مبلغ جدید را ببینید و رسید <b>همین مبلغ</b> را بفرستید.',
    ),
  }),
  slotsChanged: (): View => ({
    text: sections(heading('📅', 'زمان رزرو شما به‌روز شد'), 'مهلت نگه‌داشتن زمان انتخابی تمام شده یا تغییر کرده است. زمان را دوباره بررسی می‌کنیم؛ سپس رسید را بفرستید.'),
  }),
  tooLong: (max: number): View => ({ text: `⚠️ متن طولانی است؛ حداکثر ${fa(max)} کاراکتر بفرستید.`, keyboard: inline(homeRow()) }),
  tooManyAwaiting: (max: number): View => ({
    text: sections(
      heading('⏳', 'سفارش‌های قبلی شما در حال بررسی است'),
      `شما ${fa(max)} سفارش پرداخت‌شده دارید که هنوز تایید نشده‌اند.`,
      hint('بعد از بررسی آن‌ها می‌توانید سفارش جدید ثبت کنید.'),
    ),
    keyboard: inline([button('✉️ سفارشات من', CB.myOrders)], homeRow()),
  }),
  receiptReused: (): View => ({
    text: sections(
      heading('⚠️', 'این رسید قبلاً استفاده شده'),
      'این عکس قبلاً برای سفارش دیگری ارسال شده است.',
      hint('لطفاً عکس رسید پرداخت همین سفارش را بفرستید.'),
    ),
    keyboard: inline(cancelCheckoutRow()),
  }),
  alreadyReceived: (): View => ({ text: sections('✅ رسید شما قبلاً دریافت شده است.', hint('نیازی به ارسال دوباره نیست.')), keyboard: inline([button('✉️ سفارشات من', CB.myOrders)], homeRow()) }),
  cancelledByCartChange: (): View => ({
    text: sections(heading('ℹ️', 'سبد خرید تغییر کرد'), hint('فرایند تکمیل خرید لغو شد؛ برای ادامه دوباره «تکمیل خرید» را بزنید.')),
  }),
};

export interface CheckoutData {
  orderId: number;
  /**
   * What this checkout asks for, in order, fixed when it starts: "slot:<categoryId>" for each
   * scheduled category, then the customer fields (name, address, phone).
   * Older sessions have `fields` only, and before that all three.
   */
  steps?: string[];
  fields?: CheckoutField[];
  firstName?: string;
  lastName?: string;
  address?: string;
  phone?: string;
  /** Amount shown to the customer at the payment step; prices are locked in order_items at that moment. */
  total?: number;
  /** Unix time the prices were locked. */
  lockedAt?: number;
}

export const receiptAccepted = (trackId: string, d: CheckoutData, lines: OrderLine[], slots: OrderSlotInfo[] = []): View => ({
  text: sections(
    heading('🎉', 'سفارش شما ثبت شد!'),
    `🧾 کد رهگیری: <code>${trackId}</code>`,
    slots.length > 0 && slotLines(slots),
    quote(
      [
        contactLines({ name: [d.firstName, d.lastName].filter(Boolean).join(' '), address: d.address, phone: d.phone }),
        `💵 مبلغ: <b>${toman(cartTotal(lines))}</b>`,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    '⏳ وضعیت: <b>در انتظار تایید ادمین</b>',
    `از خرید شما سپاسگزاریم 🙏\n${hint('وضعیت سفارش را از بخش «سفارشات من» دنبال کنید.')}`,
  ),
  keyboard: inline([button('✉️ سفارشات من', CB.myOrders)], homeRow()),
});

export const unknownCommand = (): View => ({
  text: sections('🤔 متوجه نشدم!', hint('از دکمه‌های زیر استفاده کنید.')),
  keyboard: mainKeyboard(),
});
