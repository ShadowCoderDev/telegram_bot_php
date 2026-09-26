import type { Category, Faq, Order, Product } from '../db/models';
import type { SettingKey } from '../db/repositories';
import type { FullOrder } from '../services/OrderService';
import { ALLOWED_ACTIONS, STATUS_FA, type AdminOrderAction } from '../services/orderStatus';
import { backRow, button, inline, replyKeyboard } from '../telegram/keyboard';
import type { InlineKeyboardButton, View } from '../telegram/types';
import { escapeHtml as e, money, truncate } from '../utils/format';
import { formatPersianDate } from '../utils/persian';
import { CB } from './callbacks';
import { itemsWithTotal } from './common';

const A = CB.admin;
const HR = '─────────────────';
const toAdminRoot = () => backRow(A.root);
const statusIcon = (s: string) => (s === 'enable' ? '✅' : '⛔');
const CANCEL_HINT = '\n(برای لغو /cancel)';

export const ADMIN_HOME = 'پنل ادمین 🏠';

export const adminReplyKeyboard = (): View => ({
  text: 'از منوی پایین برای دسترسی سریع استفاده کنید 👇',
  keyboard: replyKeyboard([[ADMIN_HOME]]),
});

export const adminRoot = (): View => ({
  text: '🔐 <b>پنل مدیریت</b>\n\nیکی از گزینه‌ها را انتخاب کن:',
  keyboard: inline(
    [button('❓ مدیریت سوالات متداول', A.faqs)],
    [button('📊 آمار کلی', A.stats), button('🧾 مدیریت سفارشات', A.orders)],
    [button('➕ افزودن محصول', A.addProduct), button('➕ افزودن دسته‌بندی', A.addCategory)],
    [button('✏️ مدیریت محصولات', A.products), button('📂 مدیریت دسته‌بندی‌ها', A.categories)],
    [button('🗑️ حذف دسته بندی', A.deleteCategories)],
    [button('⚙️ تنظیمات ربات', A.settings)],
    [button('👀 نمایش منوی کاربر', CB.home)],
  ),
});

export const done = (text: string): View => ({ text, keyboard: inline(toAdminRoot()) });
export const prompt = (text: string): View => ({ text: text + CANCEL_HINT });

export const statsView = (s: { users: number; products: number; completed: number; daily: number; monthly: number }): View => ({
  text:
    '📊 <b>آمار کلی ربات:</b>\n\n' +
    `👤 کاربران: <b>${s.users}</b>\n` +
    `📦 محصولات: <b>${s.products}</b>\n` +
    `✅ سفارشات موفق: <b>${s.completed}</b>\n${HR}\n` +
    '💰 <b>عملکرد مالی:</b>\n\n' +
    `☀️ درآمد امروز: <b>${money(s.daily)} تومان</b>\n` +
    `🌙 درآمد این ماه: <b>${money(s.monthly)} تومان</b>\n`,
  keyboard: inline(toAdminRoot()),
});

/* ---------- settings ---------- */

export const SETTING_LABELS: Record<SettingKey, { button: string; prompt: string }> = {
  help_text: { button: '📝 ویرایش متن راهنما', prompt: 'لطفاً متن جدید <b>راهنما</b> را ارسال کنید:' },
  support: { button: '🗣️ ویرایش متن پشتیبانی', prompt: 'لطفاً متن جدید <b>پشتیبانی</b> را ارسال کنید:' },
  bank_info: { button: '💳 ویرایش اطلاعات کارت', prompt: 'لطفاً اطلاعات جدید <b>شماره کارت</b> را ارسال کنید:' },
};

export const settingsMenu = (): View => ({
  text: '⚙️ <b>تنظیمات ربات</b>\n\nکدام بخش را می‌خواهید ویرایش کنید؟',
  keyboard: inline(
    ...(Object.keys(SETTING_LABELS) as SettingKey[]).map((k) => [button(SETTING_LABELS[k].button, A.editSetting(k))]),
    toAdminRoot(),
  ),
});

/* ---------- FAQs & categories ---------- */

export const faqsManage = (faqs: Faq[]): View => ({
  text: '❓ <b>مدیریت سوالات متداول</b>:',
  keyboard: inline(
    [button('➕ افزودن سوال جدید', A.addFaq)],
    ...faqs.map((f) => [
      button(`${statusIcon(f.status)} ${truncate(f.question, 30)}`, CB.noop),
      button(f.status === 'enable' ? 'غیرفعال‌سازی' : 'فعال‌سازی', A.toggleFaq(f.id)),
    ]),
    toAdminRoot(),
  ),
});

export const categoriesManage = (cats: Category[]): View =>
  cats.length
    ? {
        text: '📂 <b>مدیریت دسته‌بندی‌ها</b>:',
        keyboard: inline(
          ...cats.map((c) => [
            button(`${statusIcon(c.status)} ${c.icon} ${c.name}`, CB.noop),
            button(c.status === 'enable' ? 'غیرفعال‌سازی ⛔' : 'فعال‌سازی ✅', A.toggleCategory(c.id)),
          ]),
          toAdminRoot(),
        ),
      }
    : done('❌ دسته‌بندی‌ای وجود ندارد.');

export const categoryDeleteList = (cats: Category[]): View =>
  cats.length
    ? {
        text:
          '🗑️ <b>حذف دسته‌بندی</b>\n\nکدام دسته‌بندی را می‌خواهید حذف کنید؟\n\n' +
          '⚠️ <b>توجه:</b> فقط دسته‌بندی‌هایی که هیچ محصولی ندارند قابل حذف هستند.',
        keyboard: inline(...cats.map((c) => [button(`${c.icon} ${c.name}`, A.deleteCategory(c.id))]), toAdminRoot()),
      }
    : done('❌ هیچ دسته‌بندی برای حذف وجود ندارد.');

export const categoryDeleteConfirm = (c: Category, hasProducts: boolean): View =>
  hasProducts
    ? {
        text:
          '🚫 <b>امکان حذف وجود ندارد!</b>\n\n' +
          `دسته‌بندی «<b>${e(c.name)}</b>» قابل حذف نیست، زیرا هنوز محصولاتی در آن وجود دارد.\n\n` +
          'ابتدا باید تمام محصولات این دسته‌بندی را به دسته‌بندی دیگری منتقل کنید.',
        keyboard: inline(backRow(A.deleteCategories)),
      }
    : {
        text: `❓ <b>آیا از حذف دسته‌بندی زیر اطمینان دارید؟</b>\n\n<b>${e(c.name)}</b>\n\nاین عمل غیرقابل بازگشت است.`,
        keyboard: inline(
          [button('✅ بله، حذف کن', A.deleteCategoryConfirm(c.id))],
          [button('❌ خیر، منصرف شدم', A.deleteCategories)],
        ),
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
        text: `✏️ <b>مدیریت محصولات</b> — تعداد کل: <b>${products.length}</b>`,
        keyboard: inline(
          ...products.map((p) => [button(`${statusIcon(p.status)} ${truncate(p.title, 28)} (${money(p.price)} ت)`, A.product(p.id))]),
          toAdminRoot(),
        ),
      }
    : done('❌ محصولی وجود ندارد.');

export const productInfo = (p: Product, category: Category | null): View => ({
  text:
    `<b>📦 اطلاعات محصول #${p.id}:</b>\n\n` +
    `<b>نام:</b> ${e(p.title)}\n` +
    `<b>توضیحات:</b> ${e(truncate(p.description, 120))}\n` +
    `<b>قیمت:</b> ${money(p.price)} تومان\n` +
    `<b>نویسنده/مدرس:</b> ${e(p.author)}\n` +
    `<b>تصویر:</b> ${p.image_file_id ? '📷 عکس آپلود شده' : e(p.image_url) || '<i>ندارد</i>'}\n` +
    `<b>دسته:</b> ${category ? `${category.icon} ${e(category.name)}` : '<i>تعیین نشده</i>'}\n` +
    `<b>موجودی:</b> ${p.inventory}\n` +
    `<b>وضعیت:</b> ${p.status === 'enable' ? '✅ فعال' : '❌ غیرفعال'}\n`,
  keyboard: inline(
    [button('✏️ ویرایش این محصول', A.editProduct(p.id))],
    [button(p.status === 'enable' ? '🗑️ غیرفعال‌سازی (حذف)' : '♻️ فعال‌سازی', A.toggleProduct(p.id))],
    backRow(A.products),
  ),
});

export const PRODUCT_FIELD_LABELS = {
  title: { button: '📝 تغییر نام', prompt: 'نام جدید محصول را بفرستید:' },
  description: { button: '💬 تغییر توضیحات', prompt: 'توضیحات جدید محصول را بفرستید:' },
  price: { button: '💵 تغییر قیمت', prompt: 'قیمت جدید را به تومان (فقط عدد) بفرستید:' },
  author: { button: '✍️ تغییر نویسنده', prompt: 'نام نویسنده/مدرس جدید را بفرستید:' },
  image_url: { button: '🖼 تغییر تصویر', prompt: 'تصویر جدید را به صورت Photo یا یک URL بفرستید:' },
  inventory: { button: '📦 تغییر موجودی', prompt: 'موجودی جدید را (فقط عدد) بفرستید:' },
} as const;

export const productEditMenu = (id: number): View => {
  const f = (field: keyof typeof PRODUCT_FIELD_LABELS) => button(PRODUCT_FIELD_LABELS[field].button, A.editField(id, field));
  return {
    text: `یک گزینه برای ویرایش محصول #${id} انتخاب کنید:`,
    keyboard: inline(
      [f('title'), f('description')],
      [f('price'), f('author')],
      [f('image_url'), f('inventory')],
      [button('🔁 تغییر دسته', A.pickCategory(id)), button('⏯ تغییر وضعیت', A.toggleProduct(id))],
      backRow(A.product(id)),
    ),
  };
};

/* ---------- orders ---------- */

export const ordersList = (orders: Order[]): View =>
  orders.length
    ? {
        text: '<b>لیست سفارشات اخیر</b>:',
        keyboard: inline(
          ...orders.map((o) => [button(`🧾 ${o.track_id} — ${STATUS_FA[o.status]} — ${formatPersianDate(o.time)}`, A.order(o.id))]),
          toAdminRoot(),
        ),
      }
    : done('هیچ سفارش پرداخت‌شده‌ای پیدا نشد.');

const ACTION_BUTTONS: Record<AdminOrderAction, string> = {
  approve: '✅ تایید سفارش',
  reject: '❌ رد سفارش',
  send: '📤 ارسال محصول به مشتری',
};

/** Order card with the receipt photo; `heading` distinguishes a new-order alert from a lookup. */
export const orderView = ({ order, details, lines }: FullOrder, heading = '🧾 <b>جزئیات سفارش</b>'): View => {
  const text =
    `${heading} (${order.track_id})\n` +
    `🗓 ${formatPersianDate(order.time)}\n` +
    (details ? `👤 ${e(details.first_name)} ${e(details.last_name)}\n📍 ${e(details.address)}\n📞 ${e(details.phone_number)}\n` : '') +
    `📌 وضعیت: <b>${STATUS_FA[order.status]}</b>\n${HR}\n\n` +
    itemsWithTotal(lines);
  const actions = ALLOWED_ACTIONS[order.status].map((a) => button(ACTION_BUTTONS[a], A.orderAction(order.id, a)));
  return {
    text,
    photo: details?.receipt_file_id ?? undefined,
    keyboard: inline(
      ...(actions.length ? [actions] : []),
      [button('✉️ پیام به خریدار', A.contactBuyer(order.id))],
      backRow(A.orders, '🔙 بازگشت به لیست'),
    ),
  };
};

export const dialogOpened = (buyerChatId: number): View => ({
  text: '✍️ پیام‌تان را برای خریدار بفرستید.\nمی‌توانید <b>متن</b> یا <b>عکس با کپشن</b> ارسال کنید.' + CANCEL_HINT,
  keyboard: inline([button('🔚 پایان گفتگو', A.closeDialog(buyerChatId))], toAdminRoot()),
});
