import type { Category, Faq, Order, OrderLine, Product } from '../db/models';
import { cartTotal, type StockProblem } from '../services/CartService';
import { STATUS_FA } from '../services/orderStatus';
import { backRow, button, inline, replyKeyboard } from '../telegram/keyboard';
import type { View } from '../telegram/types';
import { escapeHtml as e, money, truncate } from '../utils/format';
import { formatPersianDate } from '../utils/persian';
import { CB } from './callbacks';
import { CANCEL_HINT, HR, expandable, fa, heading, hint, itemsWithTotal, progress, quote, sections, toman } from './common';

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

export const mainMenu = (firstName: string): View => ({
  text: sections(
    `👋 سلام <b>${e(firstName)}</b>!\nبه فروشگاه آنلاین مدرس انگلیسی خوش آمدید ❤️`,
    quote('🎓 دوره‌های آنلاین\n📚 کتاب‌های تخصصی آیلتس'),
    '👇 یکی از گزینه‌های زیر را انتخاب کنید:',
  ),
  keyboard: inline(
    [button('🛍️ خرید محصول', CB.shop, 'primary')],
    [button('🛒 سبد خرید', CB.cart), button('✉️ سفارشات من', CB.myOrders)],
    [button('⚡️ راهنمای سریع', CB.help), button('🗣️ پشتیبانی', CB.support)],
    [button('❓ سوالات متداول', CB.faqs)],
  ),
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
      ...products.map((p) => [button(`${truncate(p.title, 30)} · ${money(p.price)} ت`, CB.product(p.id))]),
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
  inventory <= 0 ? '⛔ <b>ناموجود</b>' : inventory <= 5 ? `🔥 فقط <b>${fa(inventory)}</b> عدد باقی مانده` : '✅ موجود در انبار';

export const productCard = (p: Product, qty: number): View => {
  const head = sections(
    `📘 <b>${e(p.title)}</b>` + (p.author ? `\n✍️ ${hint(e(p.author))}` : ''),
    quote(`💰 قیمت واحد: <b>${toman(p.price)}</b>\n🔢 تعداد: <b>${fa(qty)}</b>\n💵 جمع: <b>${toman(p.price * qty)}</b>`),
    stockLine(p.inventory),
  );
  const descTitle = '\n\n📝 <b>توضیحات</b>\n';
  let desc = e(p.description);
  if (p.image_file_id && head.length + descTitle.length + desc.length + 40 > CAPTION_LIMIT) {
    // Photo captions are capped at 1024 characters; shorten the description rather than drop the photo.
    desc = e(truncate(p.description, CAPTION_LIMIT - head.length - descTitle.length - 80));
  }
  const body = head + (p.description ? descTitle + expandable(desc) : '');
  const keyboard = inline(
    [button('➖', CB.qty(p.id, qty - 1)), button(fa(qty), CB.noop), button('➕', CB.qty(p.id, qty + 1))],
    [button('🛒 افزودن به سبد خرید', CB.add(p.id, qty), 'success')],
    backRow(CB.category(p.category_id ?? 0), '🔙 بازگشت به لیست'),
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

export const cartView = (lines: OrderLine[]): View => ({
  text: sections(heading('🛒', 'سبد خرید شما'), itemsWithTotal(lines, 'مبلغ قابل پرداخت'), hint('💡 قیمت‌ها هنگام تکمیل خرید نهایی می‌شوند.')),
  keyboard: inline(
    [button('💳 تکمیل خرید', CB.checkout, 'success')],
    ...lines.map((l) => [button(`🗑 حذف «${truncate(l.title, 25)}»`, CB.removeItem(l.item_id))]),
    [button('❌ خالی کردن سبد', CB.clearCart, 'danger'), button('🔙 بازگشت', CB.home)],
  ),
});

export const stockProblemsView = (problems: StockProblem[]): View => ({
  text: sections(
    heading('⚠️', 'کمبود موجودی'),
    'موجودی این محصولات از تعداد درون سبد شما کمتر است:',
    quote(problems.map((p) => `📦 ${e(p.title)} — موجودی: <b>${fa(p.inventory)}</b>`).join('\n')),
    hint('لطفاً سبد خرید را ویرایش کنید و دوباره تلاش کنید.'),
  ),
  keyboard: inline([button('🛒 ویرایش سبد خرید', CB.cart, 'primary')]),
});

export const myOrdersView = (orders: Order[], lines: Map<number, OrderLine[]>): View => {
  if (!orders.length) {
    return {
      text: sections(heading('📑', 'سفارشات شما'), 'هنوز سفارش ثبت‌شده‌ای ندارید.'),
      keyboard: inline([button('🛍️ خرید محصول', CB.shop, 'primary')], homeRow()),
    };
  }
  const blocks = orders.map((o) =>
    sections(
      `🧾 سفارش <code>${o.track_id}</code>\n🗓 ${formatPersianDate(o.time)}\n📌 وضعیت: <b>${STATUS_FA[o.status]}</b>`,
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

/* ---------- checkout ---------- */

const STEPS = 4;
const stepView = (n: number, body: string, example?: string): View => ({
  text: sections(`${heading('🧾', 'تکمیل خرید')}\n${progress(n, STEPS)}`, body, example && hint(`مثال: ${example}`), CANCEL_HINT),
});

export const checkoutPrompts = {
  name: () => stepView(1, '👤 لطفاً <b>نام و نام خانوادگی</b> خود را بفرستید:', 'علی محمدی'),
  badName: (): View => ({ text: sections('⚠️ لطفاً <b>نام و نام خانوادگی</b> را کامل بفرستید.', hint('مثال: علی محمدی')) }),
  address: () => stepView(2, '📍 لطفاً <b>آدرس کامل</b> خود را بفرستید:', 'تهران، خیابان آزادی، پلاک ۱۲، واحد ۳'),
  phone: () => stepView(3, '📱 لطفاً <b>شماره موبایل</b> خود را بفرستید:', '09123456789'),
  badPhone: (): View => ({ text: sections('⚠️ شماره موبایل معتبر نیست.', hint('شماره باید ۱۱ رقم باشد و با ۰۹ شروع شود. مثال: 09123456789')) }),
  payment: (bankInfo: string, total: number, validMinutes: number): View =>
    stepView(
      4,
      sections(
        `💰 <b>مبلغ قابل پرداخت</b>\n${quote(`<b>${toman(total)}</b>`)}`,
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
  }),
  pricesChanged: (): View => ({
    text: sections(
      heading('🔄', 'مبلغ سفارش به‌روز شد'),
      'زمان اعتبار مبلغ قبلی تمام شده یا سبد خرید تغییر کرده است. مبلغ جدید را ببینید و رسید <b>همین مبلغ</b> را بفرستید.',
    ),
  }),
  cancelledByCartChange: (): View => ({
    text: sections(heading('ℹ️', 'سبد خرید تغییر کرد'), hint('فرایند تکمیل خرید لغو شد؛ برای ادامه دوباره «تکمیل خرید» را بزنید.')),
  }),
};

export interface CheckoutData {
  orderId: number;
  firstName?: string;
  lastName?: string;
  address?: string;
  phone?: string;
  /** Amount shown to the customer at the payment step; prices are locked in order_items at that moment. */
  total?: number;
  /** Unix time the prices were locked. */
  lockedAt?: number;
}

export const receiptAccepted = (trackId: string, d: CheckoutData, lines: OrderLine[]): View => ({
  text: sections(
    heading('🎉', 'سفارش شما ثبت شد!'),
    `🧾 کد رهگیری: <code>${trackId}</code>`,
    quote(
      `👤 ${e(`${d.firstName} ${d.lastName}`)}\n📍 ${e(d.address)}\n📱 ${e(d.phone)}\n💵 مبلغ: <b>${toman(cartTotal(lines))}</b>`,
    ),
    '⏳ وضعیت: <b>در انتظار تایید ادمین</b>',
    `از خرید شما سپاسگزاریم 🙏\n${hint('وضعیت سفارش را از بخش «سفارشات من» دنبال کنید.')}`,
  ),
  keyboard: inline([button('✉️ سفارشات من', CB.myOrders)], homeRow()),
});

export const unknownCommand = (): View => ({
  text: sections('🤔 متوجه نشدم!', hint('از دکمه‌های زیر استفاده کنید.')),
  keyboard: mainMenu('').keyboard,
});
