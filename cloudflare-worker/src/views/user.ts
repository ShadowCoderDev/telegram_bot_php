import type { Category, Faq, Order, OrderLine, Product } from '../db/models';
import { cartTotal, type StockProblem } from '../services/CartService';
import { STATUS_FA } from '../services/orderStatus';
import { backRow, button, inline, replyKeyboard } from '../telegram/keyboard';
import type { View } from '../telegram/types';
import { escapeHtml as e, money, truncate } from '../utils/format';
import { formatPersianDate } from '../utils/persian';
import { CB } from './callbacks';

const HR = '─────────────────';
const homeRow = (label = 'بازگشت 🏠') => backRow(CB.home, label);

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
  text: 'از منوی پایین برای دسترسی سریع استفاده کنید 👇',
  keyboard: replyKeyboard([[MENU.shop], [MENU.cart, MENU.orders], [MENU.support, MENU.faqs], [MENU.home]]),
});

export const mainMenu = (firstName: string): View => ({
  text:
    `سلام <b>${e(firstName)}</b>\n` +
    'به فروشگاه آنلاین مدرس انگلیسی خوش آمدید ❤️\n\n' +
    '⭐️ دوره های آنلاین و کتاب های تخصصی آیلتس\n',
  keyboard: inline(
    [button('خریــــد محصول 🛍️', CB.shop)],
    [button('سبد خرید 🛒', CB.cart), button('سفارشات من ✉️', CB.myOrders)],
    [button('راهنمای سریع ⚡️', CB.help), button('پشتیبانی 🗣️', CB.support)],
    [button('سوالات متداول ❓', CB.faqs)],
  ),
});

export const categoriesView = (categories: Category[]): View =>
  categories.length
    ? {
        text: '⭐️ <b>لطفا دسته‌بندی مد نظر خود را انتخاب کنید</b>\n\n',
        keyboard: inline(...categories.map((c) => [button(`${c.icon} ${c.name}`, CB.category(c.id))]), homeRow()),
      }
    : { text: '❌ در حال حاضر دسته‌بندی فعالی وجود ندارد.', keyboard: inline(homeRow()) };

export const categoryProductsView = (category: Category | null, products: Product[]): View => {
  const name = category ? `${category.icon} ${e(category.name)}` : 'انتخاب شده';
  const text = products.length
    ? '📅 ابتدا محصول مورد نظر خود را انتخاب کنید.\n\n' +
      `▫️ دسته بندی: ${name}\n\n` +
      '💡 پس از انتخاب محصول، اطلاعات کامل شامل قیمت و ویژگی‌های آن برای شما نمایش داده می‌شود.\n'
    : `❌ متاسفانه محصول فعالی در دسته‌بندی «${name}» وجود ندارد.`;
  return {
    text,
    keyboard: inline(...products.map((p) => [button(p.title, CB.product(p.id))]), backRow(CB.shop)),
  };
};

export const productNotFound = (): View => ({
  text: '❌ محصول مورد نظر یافت نشد یا حذف شده است.',
  keyboard: inline(backRow(CB.shop)),
});

export const productCard = (p: Product, qty: number): View => {
  // A zero-width link makes Telegram show the image as a preview above the text.
  const image = p.image_url ? `<a href="${e(p.image_url)}">&#8203;</a>` : '';
  return {
    text:
      image +
      `<b>▫️ محصول:</b> ✨ ${e(p.title)} ✨\n\n` +
      `<b>💸 مبلغ واحد:</b> ${money(p.price)} تومان\n` +
      `<b>🔢 تعداد انتخابی:</b> ${qty}\n` +
      `<b>💰 مبلغ این آیتم:</b> ${money(p.price * qty)} تومان\n\n` +
      `<b>▫️ توضیحات:</b>\n${e(p.description)}\n` +
      (p.author ? `\n<b>✍️ نویسنده/مدرس:</b> ${e(p.author)}\n` : '') +
      (p.inventory <= 0 ? '\n⛔ <b>ناموجود</b>\n' : ''),
    keyboard: inline(
      [button('➖', CB.qty(p.id, qty - 1)), button(String(qty), CB.noop), button('➕', CB.qty(p.id, qty + 1))],
      [button('افزودن به سبد خرید ✅', CB.add(p.id, qty))],
      backRow(CB.category(p.category_id ?? 0), 'بازگشت به لیست 🔙'),
    ),
  };
};

export const addedToCart = (qty: number): View => ({
  text: `✅ محصول با تعداد <b>${qty}</b> به سبد خرید اضافه شد.`,
  keyboard: inline([button('مشاهده سبد 🛒', CB.cart)], [button('ادامه خرید 🔎', CB.shop)]),
});

export const notEnoughStock = (p: Product, inCart: number, qty: number): View => ({
  text: inCart
    ? `❌ شما قبلاً ${inCart} عدد از این محصول را در سبد دارید.\nموجودی انبار (${p.inventory} عدد) برای اضافه کردن ${qty} عدد دیگر کافی نیست.`
    : `❌ متاسفانه موجودی این محصول کافی نیست.\nحداکثر موجودی قابل سفارش: ${p.inventory} عدد`,
  keyboard: inline(backRow(CB.product(p.id))),
});

export const emptyCart = (): View => ({ text: '📪 سبد خرید شما خالی هست', keyboard: inline(homeRow()) });

export const cartView = (lines: OrderLine[]): View => {
  const body = lines
    .map(
      (l) =>
        `📦 <b>${e(l.title)}</b>\n🔢 تعداد: ${l.quantity}\n💵 قیمت: ${money(l.price * l.quantity)} تومان\n` +
        `🗑️ حذف: /delete_item_${l.item_id}\n${HR}\n`,
    )
    .join('');
  return {
    text: `<b>🛒 سبد خرید شما:</b>\n\n${body}\n✅ <b>جمع کل:</b> ${money(cartTotal(lines))} تومان\n`,
    keyboard: inline(
      [button('تکمیل خرید 💳', CB.checkout)],
      [button('حذف سبد خرید ❌', CB.clearCart), button('بازگشت 🔙', CB.home)],
    ),
  };
};

export const stockProblemsView = (problems: StockProblem[]): View => ({
  text:
    '❌ متاسفانه برخی از محصولات سبد شما با کمبود موجودی مواجه شده‌اند:\n\n' +
    problems.map((p) => `محصول '<b>${e(p.title)}</b>' (موجودی: ${p.inventory} عدد)`).join('\n') +
    '\n\nلطفاً سبد خرید خود را ویرایش کرده و دوباره تلاش کنید.',
  keyboard: inline([button('مشاهده سبد خرید 🛒', CB.cart)]),
});

export const myOrdersView = (orders: Order[], lines: Map<number, OrderLine[]>): View => {
  if (!orders.length) return { text: '📑 <b>سفارشات شما</b>\n\nهنوز سفارش تکمیل‌شده‌ای ندارید.', keyboard: inline(homeRow()) };
  const blocks = orders.map((o) => {
    const items = lines.get(o.id) ?? [];
    return (
      `🆔 <b>کد رهگیری: ${o.track_id}</b>\n` +
      `🗓 ${formatPersianDate(o.time)}\n` +
      '<b>محصولات خریداری شده:</b>\n' +
      items.map((i) => `   • <i>${e(i.title)}</i> (تعداد: ${i.quantity} - قیمت فی: ${money(i.price)} تومان)\n`).join('') +
      `💵 <b>جمع کل:</b> ${money(cartTotal(items))} تومان\n` +
      `📌 <b>وضعیت:</b> ${STATUS_FA[o.status]}\n────\n`
    );
  });
  return { text: `📑 <b>${orders.length} سفارش آخر شما:</b>\n\n${blocks.join('\n')}`, keyboard: inline(homeRow()) };
};

export const faqsView = (faqs: Faq[]): View =>
  faqs.length
    ? {
        text: '❓ <b>سوالات متداول</b>\n\nلطفاً سوال خود را از لیست زیر انتخاب کنید تا پاسخ آن نمایش داده شود:\n',
        keyboard: inline(...faqs.map((f) => [button(`▫️ ${truncate(f.question, 50)}`, CB.faq(f.id))]), homeRow()),
      }
    : { text: '❓ بخشی برای سوالات متداول تعریف نشده است.', keyboard: inline(homeRow()) };

export const faqAnswerView = (f: Faq): View => ({
  text: `❓ <b>سوال:</b>\n${e(f.question)}\n\n✅ <b>پاسخ:</b>\n${e(f.answer)}`,
  keyboard: inline(backRow(CB.faqs, 'بازگشت به لیست سوالات 🔙')),
});

export const helpView = (help: string): View => ({
  text: `❓ <b>راهنمای ربات</b>\n\n${e(help)}`,
  keyboard: inline(homeRow()),
});

export const supportView = (support: string): View => ({
  text:
    '🗣️ <b>تماس با پشتیبانی</b>\n\n' +
    'شما می‌توانید سوالات، مشکلات و پیشنهادات خود را از طریق آیدی تلگرام زیر با ما در میان بگذارید:\n\n' +
    `<b>${e(support)}</b>`,
  keyboard: inline(homeRow()),
});

/* ---------- checkout ---------- */

export const checkoutPrompts = {
  name: (): View => ({ text: 'مرحله 1️⃣\n\nلطفاً نام و نام خانوادگی خود را وارد کنید:\n(به صورت: نام نام‌خانوادگی)\n\nمثال: علی محمدی\n\n(برای لغو /cancel)' }),
  badName: (): View => ({ text: '❌ لطفاً نام و نام خانوادگی را به صورت صحیح وارد کنید:\nمثال: علی محمدی' }),
  address: (): View => ({ text: 'مرحله 2️⃣\n\nلطفاً آدرس خود را وارد کنید:\n(آدرس کامل شهر، خیابان، پلاک و...)' }),
  phone: (): View => ({ text: 'مرحله 3️⃣\n\nلطفاً شماره تلفن خود را وارد کنید:\n(فقط اعداد - مثال: 09123456789)' }),
  badPhone: (): View => ({ text: '❌ شماره تلفن وارد شده صحیح نیست.\nلطفاً شماره تلفن خود را به صورت صحیح وارد کنید:\nمثال: 09123456789' }),
  payment: (bankInfo: string, total: number): View => ({
    text:
      'مرحله 4️⃣\n\n' +
      `💳 <b>اطلاعات واریز:</b>\n<code>${e(bankInfo)}</code>\n\n` +
      `💰 <b>مبلغ کل:</b> ${money(total)} تومان\n\n` +
      '📸 <b>فقط تصویر ارسال کنید</b> (Photo یا Document با نوع تصویر). فایل‌های غیرتصویری یا متن پذیرفته نمی‌شود.\n\n' +
      'لطفاً پس از واریز، عکس فیش واریزی خود را ارسال کنید:',
  }),
  needImage: (): View => ({
    text:
      '❗️ لطفاً برای تکمیل سفارش، یک <b>تصویرِ رسید</b> ارسال کنید.\n\n' +
      'راهنما:\n• می‌توانید عکس را به صورت Photo بفرستید.\n' +
      '• یا اگر فایل‌تان Document است، فقط مطمئن باشید نوع آن تصویر باشد (jpg/png/webp).',
  }),
};

export interface CheckoutData {
  orderId: number;
  firstName?: string;
  lastName?: string;
  address?: string;
  phone?: string;
  total?: number;
}

export const receiptAccepted = (trackId: string, d: CheckoutData): View => ({
  text:
    '✅ <b>رسید شما دریافت شد و سفارش برای ادمین ارسال گردید.</b>\n\n' +
    'از خرید شما متشکریم 🙏\n\n' +
    `🆔 <b>کد رهگیری:</b> ${trackId}\n` +
    `👤 نام: ${e(`${d.firstName} ${d.lastName}`)}\n` +
    `📍 آدرس: ${e(d.address)}\n` +
    `📱 تلفن: ${e(d.phone)}\n` +
    `💵 مبلغ کل: ${money(d.total ?? 0)} تومان\n` +
    '⏰ وضعیت: ⏳ در انتظار تایید\n\n' +
    'می‌توانید در بخش «سفارشات من» وضعیت را ببینید.',
  keyboard: inline(homeRow('بازگشت به منوی اصلی 🏠')),
});

export const unknownCommand = (): View => ({ text: 'متوجه نشدم 🤔 از منوی زیر استفاده کنید.', keyboard: mainMenu('').keyboard });
