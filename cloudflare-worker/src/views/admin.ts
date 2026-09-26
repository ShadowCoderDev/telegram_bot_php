import type { Category, Faq, Order, Product } from '../db/models';
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

export const adminRoot = (): View => ({
  text: sections(heading('🔐', 'پنل مدیریت'), '👇 یکی از بخش‌ها را انتخاب کنید:'),
  keyboard: inline(
    [button('🧾 سفارشات', A.orders, 'primary'), button('📊 آمار', A.stats)],
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

export const productsList = (products: Product[]): View =>
  products.length
    ? {
        text: sections(heading('✏️', 'محصولات'), `${hint(`${fa(products.length)} محصول`)}   ${hint('🟢 فعال   🔴 غیرفعال')}`),
        keyboard: inline(
          ...products.map((p) => [button(`${statusIcon(p.status)} ${truncate(p.title, 26)} · ${money(p.price)} ت`, A.product(p.id))]),
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

export const ordersList = (orders: Order[]): View =>
  orders.length
    ? {
        text: sections(heading('🧾', 'سفارشات اخیر'), hint('🟡 منتظر تایید   🟢 تایید شده   📤 ارسال شده   🔴 رد شده')),
        keyboard: inline(
          ...orders.map((o) => [button(`${STATUS_ICON[o.status]} ${o.track_id} · ${formatPersianDate(o.time)}`, A.order(o.id))]),
          toAdminRoot(),
        ),
      }
    : done(sections(heading('🧾', 'سفارشات'), 'هنوز سفارشی ثبت نشده است.'));

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
      [button('✉️ پیام به خریدار', A.contactBuyer(order.id))],
      backRow(A.orders, '🔙 لیست سفارشات'),
    ),
  };
};

export const dialogOpened = (buyerChatId: number): View => ({
  text: sections(heading('✉️', 'گفتگو با خریدار'), 'پیام‌تان را بفرستید؛ <b>متن</b> یا <b>عکس با کپشن</b>.', CANCEL_HINT),
  keyboard: inline([button('🔚 پایان گفتگو', A.closeDialog(buyerChatId), 'danger')], toAdminRoot()),
});
