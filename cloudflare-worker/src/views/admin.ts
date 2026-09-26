import type { Category, CustomerSummary, Faq, Order, Product } from '../db/models';
import type { SettingKey } from '../db/repositories';
import type { FullOrder } from '../services/OrderService';
import { ALLOWED_ACTIONS, STATUS_FA, type AdminOrderAction } from '../services/orderStatus';
import { backRow, button, inline, replyKeyboard } from '../telegram/keyboard';
import type { ButtonStyle, InlineKeyboardButton, View } from '../telegram/types';
import { escapeHtml as e, money, truncate } from '../utils/format';
import { formatPersianDate } from '../utils/persian';
import { CB } from './callbacks';
import { CANCEL_HINT, expandable, fa, heading, hint, itemsWithTotal, progress, quote, sections, toman } from './common';

const A = CB.admin;
const toAdminRoot = () => backRow(A.root, '🔙 پنل مدیریت');
const statusIcon = (s: string) => (s === 'enable' ? '🟢' : '🔴');

export const ADMIN_HOME = 'پنل ادمین 🏠';

export const adminReplyKeyboard = (): View => ({
  text: hint('👇 از منوی پایین هم می‌توانید سریع به پنل برگردید.'),
  keyboard: replyKeyboard([[ADMIN_HOME]]),
});

export const PAGE_SIZE = 10;
export const pageCount = (total: number) => Math.max(1, Math.ceil(total / PAGE_SIZE));

/** ◀️ قبلی   ۲ / ۵   بعدی ▶️ – omitted when everything fits on one page. */
const pager = (page: number, pages: number, toData: (page: number) => string): InlineKeyboardButton[][] =>
  pages <= 1
    ? []
    : [
        [
          ...(page > 0 ? [button('◀️ قبلی', toData(page - 1))] : []),
          button(`${fa(page + 1)} / ${fa(pages)}`, CB.noop),
          ...(page < pages - 1 ? [button('بعدی ▶️', toData(page + 1))] : []),
        ],
      ];

export const adminRoot = (): View => ({
  text: sections(heading('🔐', 'پنل مدیریت'), '👇 یکی از بخش‌ها را انتخاب کنید:'),
  keyboard: inline(
    [button('🧾 سفارشات', A.orders, 'primary'), button('👥 مشتریان', A.customers, 'primary')],
    [button('📊 آمار', A.stats)],
    [button('➕ محصول جدید', A.addProduct, 'success'), button('➕ دسته‌بندی جدید', A.addCategory, 'success')],
    [button('✏️ محصولات', A.products), button('📂 دسته‌بندی‌ها', A.categories)],
    [button('❓ سوالات متداول', A.faqs), button('⚙️ تنظیمات', A.settings)],
    [button('🗑 حذف دسته‌بندی', A.deleteCategories, 'danger')],
    [button('👀 نمایش منوی کاربر', CB.home)],
  ),
});

export const done = (text: string): View => ({ text, keyboard: inline(toAdminRoot()) });
export const prompt = (text: string): View => ({ text: sections(text, CANCEL_HINT) });
/** A step of a multi-step admin form, with a progress bar. */
export const formStep = (title: string, step: number, total: number, body: string): View =>
  prompt(sections(`${heading('📝', title)}\n${progress(step, total)}`, body));

export const statsView = (s: { users: number; products: number; completed: number; daily: number; monthly: number }): View => ({
  text: sections(
    heading('📊', 'آمار فروشگاه'),
    quote(`👥 کاربران: <b>${fa(s.users)}</b>\n📦 محصولات: <b>${fa(s.products)}</b>\n✅ سفارشات موفق: <b>${fa(s.completed)}</b>`),
    `💰 <b>درآمد</b>\n` + quote(`☀️ امروز: <b>${toman(s.daily)}</b>\n🌙 این ماه: <b>${toman(s.monthly)}</b>`),
    hint('سفارش‌های پرداخت‌شده، تاییدشده و ارسال‌شده حساب می‌شوند.'),
  ),
  keyboard: inline(toAdminRoot()),
});

/* ---------- settings ---------- */

export const SETTING_LABELS: Record<SettingKey, { button: string; prompt: string }> = {
  help_text: { button: '📝 متن راهنما', prompt: 'متن جدید <b>راهنما</b> را بفرستید:' },
  support: { button: '🗣️ آیدی پشتیبانی', prompt: 'آیدی یا متن جدید <b>پشتیبانی</b> را بفرستید:' },
  bank_info: { button: '💳 اطلاعات کارت', prompt: 'اطلاعات جدید <b>کارت بانکی</b> را بفرستید:' },
};

export const settingsMenu = (): View => ({
  text: sections(heading('⚙️', 'تنظیمات ربات'), '👇 کدام بخش را ویرایش می‌کنید؟'),
  keyboard: inline(
    ...(Object.keys(SETTING_LABELS) as SettingKey[]).map((k) => [button(SETTING_LABELS[k].button, A.editSetting(k))]),
    toAdminRoot(),
  ),
});

/* ---------- FAQs & categories ---------- */

const toggleButton = (status: string, data: string) =>
  status === 'enable' ? button('🔴 غیرفعال کن', data, 'danger') : button('🟢 فعال کن', data, 'success');

export const faqsManage = (faqs: Faq[]): View => ({
  text: sections(heading('❓', 'سوالات متداول'), hint('🟢 فعال   🔴 غیرفعال')),
  keyboard: inline(
    [button('➕ افزودن سوال جدید', A.addFaq, 'success')],
    ...faqs.map((f) => [button(`${statusIcon(f.status)} ${truncate(f.question, 28)}`, CB.noop), toggleButton(f.status, A.toggleFaq(f.id))]),
    toAdminRoot(),
  ),
});

export const categoriesManage = (cats: Category[]): View =>
  cats.length
    ? {
        text: sections(heading('📂', 'دسته‌بندی‌ها'), hint('🟢 فعال   🔴 غیرفعال')),
        keyboard: inline(
          ...cats.map((c) => [button(`${statusIcon(c.status)} ${c.icon} ${c.name}`, CB.noop), toggleButton(c.status, A.toggleCategory(c.id))]),
          toAdminRoot(),
        ),
      }
    : done(sections(heading('📂', 'دسته‌بندی‌ها'), 'هنوز دسته‌بندی‌ای ساخته نشده است.'));

export const categoryDeleteList = (cats: Category[]): View =>
  cats.length
    ? {
        text: sections(
          heading('🗑', 'حذف دسته‌بندی'),
          '👇 دسته‌بندی مورد نظر را انتخاب کنید:',
          hint('⚠️ فقط دسته‌بندی‌های بدون محصول قابل حذف هستند.'),
        ),
        keyboard: inline(...cats.map((c) => [button(`${c.icon} ${c.name}`, A.deleteCategory(c.id))]), toAdminRoot()),
      }
    : done(sections(heading('🗑', 'حذف دسته‌بندی'), 'دسته‌بندی‌ای برای حذف وجود ندارد.'));

export const categoryDeleteConfirm = (c: Category, hasProducts: boolean): View =>
  hasProducts
    ? {
        text: sections(
          heading('🚫', 'امکان حذف وجود ندارد'),
          quote(`${c.icon} <b>${e(c.name)}</b> هنوز محصول دارد.`),
          hint('اول محصولات این دسته را به دسته‌ی دیگری منتقل کنید.'),
        ),
        keyboard: inline(backRow(A.deleteCategories)),
      }
    : {
        text: sections(heading('⚠️', 'حذف دسته‌بندی'), quote(`${c.icon} <b>${e(c.name)}</b>`), hint('این کار قابل بازگشت نیست.')),
        keyboard: inline([button('🗑 بله، حذف کن', A.deleteCategoryConfirm(c.id), 'danger'), button('انصراف', A.deleteCategories)]),
      };

/** Category picker used both when creating a product and when moving one. */
export const categoryPicker = (cats: Category[], title: string, toData: (c: Category) => string, back: InlineKeyboardButton[]): View => ({
  text: title,
  keyboard: inline(...cats.map((c) => [button(`${c.icon} ${c.name}`, toData(c))]), back),
});

/* ---------- products ---------- */

export const productsList = (products: Product[], page: number, total: number): View =>
  total
    ? {
        text: sections(heading('✏️', 'محصولات'), `${hint(`${fa(total)} محصول`)}   ${hint('🟢 فعال   🔴 غیرفعال   ⛔ ناموجود')}`),
        keyboard: inline(
          ...products.map((p) => [
            button(`${p.inventory <= 0 ? '⛔' : statusIcon(p.status)} ${truncate(p.title, 26)} · ${money(p.price)} ت`, A.product(p.id)),
          ]),
          ...pager(page, pageCount(total), A.productsPage),
          toAdminRoot(),
        ),
      }
    : done(sections(heading('✏️', 'محصولات'), 'هنوز محصولی ثبت نشده است.'));

export const productInfo = (p: Product, category: Category | null): View => ({
  text: sections(
    `📦 <b>${e(p.title)}</b>  ${hint(`#${p.id}`)}`,
    quote(
      `💰 <b>قیمت:</b> ${toman(p.price)}\n` +
        `🏷 <b>موجودی:</b> ${p.inventory}\n` +
        `📂 <b>دسته:</b> ${category ? `${category.icon} ${e(category.name)}` : hint('تعیین نشده')}\n` +
        `✍️ <b>نویسنده/مدرس:</b> ${e(p.author) || hint('ندارد')}\n` +
        `🖼 <b>تصویر:</b> ${p.image_file_id ? 'عکس آپلود شده' : e(p.image_url) || hint('ندارد')}\n` +
        `📌 <b>وضعیت:</b> ${p.status === 'enable' ? '🟢 فعال' : '🔴 غیرفعال'}`,
    ),
    p.description && `📝 <b>توضیحات</b>\n${expandable(e(p.description))}`,
  ),
  photo: p.image_file_id || undefined,
  keyboard: inline(
    [button('✏️ ویرایش', A.editProduct(p.id), 'primary')],
    [p.status === 'enable' ? button('🔴 غیرفعال کن (حذف)', A.toggleProduct(p.id), 'danger') : button('🟢 فعال کن', A.toggleProduct(p.id), 'success')],
    backRow(A.products, '🔙 لیست محصولات'),
  ),
});

export const PRODUCT_FIELD_LABELS = {
  title: { button: '📝 نام', prompt: 'نام جدید محصول را بفرستید:' },
  description: { button: '💬 توضیحات', prompt: 'توضیحات جدید محصول را بفرستید:' },
  price: { button: '💰 قیمت', prompt: 'قیمت جدید را به <b>تومان</b> بفرستید (فقط عدد):' },
  author: { button: '✍️ نویسنده', prompt: 'نام نویسنده/مدرس جدید را بفرستید:' },
  image_url: { button: '🖼 تصویر', prompt: '🖼 عکس جدید محصول را بفرستید (یا لینک تصویر):' },
  inventory: { button: '🏷 موجودی', prompt: 'موجودی جدید را بفرستید (فقط عدد):' },
} as const;

export const productEditMenu = (id: number): View => {
  const f = (field: keyof typeof PRODUCT_FIELD_LABELS) => button(PRODUCT_FIELD_LABELS[field].button, A.editField(id, field));
  return {
    text: sections(heading('✏️', `ویرایش محصول #${id}`), '👇 کدام مورد را تغییر می‌دهید؟'),
    keyboard: inline(
      [f('title'), f('price')],
      [f('inventory'), f('image_url')],
      [f('author'), f('description')],
      [button('📂 تغییر دسته', A.pickCategory(id)), button('⏯ تغییر وضعیت', A.toggleProduct(id))],
      backRow(A.product(id)),
    ),
  };
};

/* ---------- orders ---------- */

const STATUS_ICON: Record<string, string> = { payed: '🟡', approved: '🟢', sending: '📤', rejected: '🔴', cancel: '⚪', pending: '⚪' };

const STATUS_LEGEND = hint('🟡 منتظر تایید   🟢 تایید شده   📤 ارسال شده   🔴 رد شده');
const orderButton = (o: Order) => button(`${STATUS_ICON[o.status]} ${o.track_id} · ${formatPersianDate(o.time)}`, A.order(o.id));

export const ordersList = (orders: Order[], page: number, total: number): View =>
  total
    ? {
        text: sections(heading('🧾', 'سفارشات'), `${hint(`${fa(total)} سفارش`)}\n${STATUS_LEGEND}`),
        keyboard: inline(...orders.map((o) => [orderButton(o)]), ...pager(page, pageCount(total), A.ordersPage), toAdminRoot()),
      }
    : done(sections(heading('🧾', 'سفارشات'), 'هنوز سفارشی ثبت نشده است.'));

/* ---------- customers ---------- */

const customerLabel = (c: CustomerSummary) =>
  `${c.status === 'disable' ? '🚫' : c.awaiting_review ? '🟡' : '👤'} ${truncate(c.name || String(c.chat_id), 22)} · ${fa(c.orders_count)} سفارش`;

export const customersList = (customers: CustomerSummary[], page: number, total: number): View => ({
  text: sections(
    heading('👥', 'مشتریان'),
    `${hint(`${fa(total)} مشتری · به ترتیب آخرین فعالیت`)}\n${hint('🟡 سفارش منتظر تایید دارد   🚫 مسدود')}`,
  ),
  keyboard: inline(
    [button('🔍 جستجوی مشتری', A.findCustomer, 'primary')],
    ...customers.map((c) => [button(customerLabel(c), A.customer(c.id))]),
    ...pager(page, pageCount(total), A.customersPage),
    toAdminRoot(),
  ),
});

export const customerSearchResults = (query: string, customers: CustomerSummary[]): View => ({
  text: customers.length
    ? sections(heading('🔍', 'نتیجه جستجو'), hint(`«${e(query)}» · ${fa(customers.length)} مشتری`))
    : sections(heading('🔍', 'نتیجه جستجو'), `مشتری‌ای با «${e(query)}» پیدا نشد.`),
  keyboard: inline(
    ...customers.map((c) => [button(customerLabel(c), A.customer(c.id))]),
    [button('🔍 جستجوی دوباره', A.findCustomer), button('🔙 لیست مشتریان', A.customers)],
  ),
});

export const CUSTOMER_SEARCH_PROMPT = sections(
  heading('🔍', 'جستجوی مشتری'),
  'یکی از این‌ها را بفرستید:',
  quote('👤 نام\n🔗 @یوزرنیم\n📱 شماره موبایل\n🧾 کد رهگیری سفارش\n🆔 شناسه عددی تلگرام'),
);

export const customerView = (
  c: CustomerSummary,
  contact: { phone_number: string; address: string } | null,
  orders: Order[],
  page: number,
  isAdmin: boolean,
): View => ({
  text: sections(
    `👤 <b>${e(c.name) || hint('بدون نام')}</b>${c.username ? `  @${e(c.username)}` : ''}`,
    quote(
      `🆔 شناسه: <code>${c.chat_id}</code>\n` +
        `🗓 عضویت: ${formatPersianDate(c.created_at)}` +
        (contact ? `\n📱 موبایل: <code>${e(contact.phone_number)}</code>\n📍 آدرس: ${e(contact.address)}` : ''),
    ),
    `📊 <b>خلاصه خرید</b>\n` +
      quote(
        `🧾 سفارش‌ها: <b>${fa(c.orders_count)}</b>\n` +
          `🟡 منتظر تایید: <b>${fa(c.awaiting_review)}</b>\n` +
          `💰 مجموع خرید تاییدشده: <b>${toman(c.total_spent)}</b>`,
      ),
    `📌 وضعیت: ${c.status === 'disable' ? '🚫 <b>مسدود</b>' : '🟢 فعال'}` + (isAdmin ? `  ${hint('(ادمین)')}` : ''),
    c.orders_count ? `👇 سفارش‌های این مشتری:\n${STATUS_LEGEND}` : hint('این مشتری هنوز سفارشی ثبت نکرده است.'),
  ),
  keyboard: inline(
    ...orders.map((o) => [orderButton(o)]),
    ...pager(page, pageCount(c.orders_count), (p) => A.customer(c.id, p)),
    [
      button('✉️ پیام', A.messageCustomer(c.id)),
      ...(isAdmin
        ? []
        : [
            c.status === 'disable'
              ? button('✅ رفع مسدودی', A.toggleCustomerBlock(c.id), 'success')
              : button('🚫 مسدود کردن', A.toggleCustomerBlock(c.id), 'danger'),
          ]),
    ],
    backRow(A.customers, '🔙 لیست مشتریان'),
  ),
});

const ACTION_BUTTONS: Record<AdminOrderAction, [string, ButtonStyle]> = {
  approve: ['✅ تایید سفارش', 'success'],
  reject: ['❌ رد سفارش', 'danger'],
  send: ['📤 ارسال شد', 'primary'],
};

/** Order card with the receipt photo; `title` distinguishes a new-order alert from a lookup. */
export const orderView = ({ order, details, lines }: FullOrder, title = heading('🧾', 'جزئیات سفارش')): View => {
  const text = sections(
    `${title}\n<code>${order.track_id}</code>`,
    `🗓 ${formatPersianDate(order.time)}\n📌 وضعیت: <b>${STATUS_FA[order.status]}</b>`,
    details && quote(`👤 ${e(details.first_name)} ${e(details.last_name)}\n📍 ${e(details.address)}\n📱 <code>${e(details.phone_number)}</code>`),
    itemsWithTotal(lines),
  );
  const actions = ALLOWED_ACTIONS[order.status].map((a) => button(ACTION_BUTTONS[a][0], A.orderAction(order.id, a), ACTION_BUTTONS[a][1]));
  return {
    text,
    photo: details?.receipt_file_id ?? undefined,
    keyboard: inline(
      ...(actions.length ? [actions] : []),
      [button('👤 مشتری', A.customer(order.user_id)), button('✉️ پیام به خریدار', A.contactBuyer(order.id))],
      backRow(A.orders, '🔙 لیست سفارشات'),
    ),
  };
};

export const dialogOpened = (buyerChatId: number, name: string): View => ({
  text: sections(
    heading('✉️', name ? `گفتگو با ${e(name)}` : 'گفتگو با مشتری'),
    'پیام‌تان را بفرستید؛ <b>متن</b> یا <b>عکس با کپشن</b>.',
    hint('پاسخ‌های مشتری تا پایان گفتگو برای شما فرستاده می‌شود.'),
    CANCEL_HINT,
  ),
  keyboard: inline([button('🔚 پایان گفتگو', A.closeDialog(buyerChatId), 'danger')], toAdminRoot()),
});
