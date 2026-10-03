import type { Category, CategoryWithCount, CustomerSummary, Faq, Order, Product } from '../db/models';
import type { SettingKey } from '../db/repositories';
import type { FullOrder } from '../services/OrderService';
import { ALLOWED_ACTIONS, STATUS_FA, type AdminOrderAction } from '../services/orderStatus';
import { WARN_SHARE } from '../capacity';
import { UNCAPPED } from '../db/usage';
import { CHECKOUT_FIELDS, type CheckoutField } from '../services/checkoutFields';
import { GRACE_DAYS, type Access } from '../services/subscription';
import { backRow, button, inline, replyKeyboard, urlButton } from '../telegram/keyboard';
import type { ButtonStyle, InlineKeyboardButton, View } from '../telegram/types';
import { escapeHtml as e, money, truncate } from '../utils/format';
import { formatPersianDate } from '../utils/persian';
import { CB } from './callbacks';
import { slotLines } from './slots';
import { CANCEL_HINT, withCancel, contactLines, expandable, fa, heading, hint, itemsWithTotal, num, progress, quote, sections, toman } from './common';

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

/**
 * ◀️ قبلی   صفحه ۲   بعدی ▶️ – for lists that can grow without bound (orders, customers): counting
 * them would read every row on every view, so the page only knows whether another one follows.
 */
const openPager = (page: number, hasNext: boolean, toData: (page: number) => string): InlineKeyboardButton[][] =>
  page === 0 && !hasNext
    ? []
    : [
        [
          ...(page > 0 ? [button('◀️ قبلی', toData(page - 1))] : []),
          button(`صفحه ${fa(page + 1)}`, CB.noop),
          ...(hasNext ? [button('بعدی ▶️', toData(page + 1))] : []),
        ],
      ];

/** Subscription state of a seller's shop, shown on the admin panel (absent for the owner's own shop). */
export interface SubscriptionInfo {
  access: Access;
  trial: boolean;
  paidUntil: number;
  daysLeft: number;
  /** Link to the platform bot's renewal flow for this shop. */
  renewUrl?: string;
  /** When the data is deleted if the shop stays unpaid. */
  purgeAt?: number;
  /** The platform's step-by-step tutorial. */
  learnUrl?: string;
}

const subscriptionLine = (s: SubscriptionInfo): string => {
  const until = formatPersianDate(s.paidUntil).split(' - ')[0];
  switch (s.access) {
    case 'ok':
      return s.trial
        ? `🎁 دوره‌ی آزمایشی: <b>${fa(s.daysLeft)}</b> روز مانده`
        : `${s.daysLeft <= 3 ? '⚠️' : '💳'} اشتراک: <b>${fa(s.daysLeft)}</b> روز مانده ${hint(`(تا ${until})`)}`;
    case 'grace':
      return `⚠️ <b>اشتراک تمام شده و فروشگاه برای مشتری‌ها بسته است.</b> پنل شما تا <b>${fa(GRACE_DAYS + s.daysLeft)}</b> روز دیگر باز می‌ماند؛ برای باز شدن فروشگاه تمدید کنید.`;
    case 'expired':
      return '🔒 <b>اشتراک تمام شده و فروشگاه بسته است.</b> با تمدید، فوراً باز می‌شود.';
    case 'suspended':
      return '⛔ <b>این فروشگاه توسط پلتفرم متوقف شده است.</b> با پشتیبانی پلتفرم تماس بگیرید.';
  }
};

/** How many updates the bot handled today, against the shop's daily cap. */
export interface UsageInfo {
  updates: number;
  cap: number;
}

const usageLine = (u: UsageInfo): string => {
  if (u.cap >= UNCAPPED) return `📶 پیام‌های امروز: <b>${num(u.updates)}</b>`;
  const line = `📶 مصرف امروز: <b>${num(Math.min(u.updates, u.cap))}</b> از ${num(u.cap)} پیام ${hint(`(${fa(Math.min(100, Math.round((100 * u.updates) / u.cap)))}٪)`)}`;
  if (u.updates >= u.cap) return `${line}\n⛔ <b>ظرفیت امروز تکمیل شده.</b> مشتری‌ها تا ۳:۳۰ بامداد پیام «ظرفیت امروز تکمیل شده» می‌بینند؛ شما همچنان به پنل دسترسی دارید.`;
  if (u.updates >= u.cap * WARN_SHARE) return `${line}\n⚠️ نزدیک سقف روزانه‌اید. سقف هر روز ساعت ۳:۳۰ بامداد از نو شروع می‌شود.`;
  return line;
};

export const adminRoot = (awaitingReview = 0, subscription?: SubscriptionInfo, usage?: UsageInfo, scheduling = false): View => ({
  text: sections(
    heading('🔐', 'پنل مدیریت'),
    subscription && subscriptionLine(subscription),
    usage && usageLine(usage),
    awaitingReview ? `🟡 <b>${fa(awaitingReview)}</b> سفارش منتظر تایید شماست.` : '',
    '👇 یکی از بخش‌ها را انتخاب کنید:',
  ),
  keyboard: inline(
    ...(subscription?.renewUrl && subscription.access !== 'suspended'
      ? [[urlButton('💳 تمدید اشتراک', subscription.renewUrl, subscription.access === 'ok' && subscription.daysLeft > 3 ? undefined : 'success')]]
      : []),
    [
      button(awaitingReview ? `🧾 سفارشات (🟡 ${fa(awaitingReview)})` : '🧾 سفارشات', A.orders, 'primary'),
      button('👥 مشتریان', A.customers, 'primary'),
    ],
    scheduling ? [button('📅 برنامه و نوبت‌ها', A.agenda, 'primary'), button('📊 آمار', A.stats)] : [button('📊 آمار', A.stats)],
    [button('➕ محصول جدید', A.addProduct, 'success'), button('➕ دسته‌بندی جدید', A.addCategory, 'success')],
    [button('✏️ محصولات', A.products), button('📂 دسته‌بندی‌ها', A.categories)],
    [button('❓ سوالات متداول', A.faqs), button('⚙️ تنظیمات', A.settings)],
    [button('👀 نمایش منوی کاربر', CB.home)],
    ...(subscription?.learnUrl ? [[urlButton('📚 آموزش استفاده از ربات', subscription.learnUrl)]] : []),
  ),
});

/** The panel of a closed shop (subscription over, or suspended): renew, and finish paid orders. */
export const closedAdminRoot = (awaitingReview: number, subscription: SubscriptionInfo): View => ({
  text: sections(
    heading('🔒', 'فروشگاه بسته است'),
    subscriptionLine(subscription),
    'مشتری‌ها فعلاً نه محصولی می‌بینند و نه می‌توانند سفارش بدهند. شما فقط سفارش‌هایی را که قبلاً پرداخت شده‌اند رسیدگی می‌کنید.',
    awaitingReview ? `🟡 <b>${fa(awaitingReview)}</b> سفارش منتظر تایید شماست.` : '',
    subscription.purgeAt ? `🗄 همه‌ی داده‌ها تا <b>${formatPersianDate(subscription.purgeAt).split(' - ')[0]}</b> نگه داشته می‌شود؛ با تمدید، فوراً همه‌چیز برمی‌گردد.` : '',
  ),
  keyboard: inline(
    ...(subscription.renewUrl && subscription.access !== 'suspended' ? [[urlButton('💳 تمدید اشتراک', subscription.renewUrl, 'success')]] : []),
    [button(awaitingReview ? `🧾 سفارشات (🟡 ${fa(awaitingReview)})` : '🧾 سفارشات', A.orders, 'primary')],
  ),
});

export const done = (text: string): View => ({ text, keyboard: inline(toAdminRoot()) });
export const prompt = (text: string): View => withCancel(text, A.cancel);
/** A step of a multi-step admin form, with a progress bar. */
export const formStep = (title: string, step: number, total: number, body: string): View =>
  prompt(sections(`${heading('📝', title)}\n${progress(step, total)}`, body));

export interface ShopStats {
  /** When the numbers were computed (they are reused for a few minutes). */
  at: number;
  users: number;
  products: number;
  completed: number;
  daily: number;
  monthly: number;
}

export const statsView = (s: ShopStats): View => ({
  text: sections(
    heading('📊', 'آمار فروشگاه'),
    quote(`👥 کاربران: <b>${num(s.users)}</b>\n📦 محصولات: <b>${num(s.products)}</b>\n✅ سفارشات موفق: <b>${num(s.completed)}</b>`),
    `💰 <b>درآمد</b>\n` + quote(`☀️ امروز: <b>${toman(s.daily)}</b>\n🌙 این ماه: <b>${toman(s.monthly)}</b>`),
    hint(`سفارش‌های پرداخت‌شده، تاییدشده و ارسال‌شده حساب می‌شوند.\n🕒 به‌روز شده در ${formatPersianDate(s.at).split(' - ')[1] ?? ''} · هر ۱۰ دقیقه تازه می‌شود.`),
  ),
  keyboard: inline(toAdminRoot()),
});

/* ---------- settings ---------- */

export const SETTING_LABELS: Record<SettingKey, { button: string; prompt: string }> = {
  shop_name: { button: '🏪 نام فروشگاه', prompt: '<b>نام فروشگاه</b> را بفرستید (در منوی اصلی نمایش داده می‌شود):' },
  welcome_text: { button: '👋 متن خوش‌آمد', prompt: '<b>متن خوش‌آمد</b> منوی اصلی را بفرستید:' },
  track_prefix: {
    button: '🧾 پیشوند کد رهگیری',
    prompt: `<b>پیشوند کد رهگیری</b> را بفرستید (فقط حروف انگلیسی و عدد، حداکثر ۸).\n${hint('مثال: IELTS  →  کدها مثل IELTS-7K2QD')}`,
  },
  bank_info: { button: '💳 اطلاعات کارت', prompt: 'اطلاعات جدید <b>کارت بانکی</b> را بفرستید:' },
  support: { button: '🗣️ آیدی پشتیبانی', prompt: 'آیدی یا متن جدید <b>پشتیبانی</b> را بفرستید:' },
  help_text: { button: '📝 متن راهنما', prompt: 'متن جدید <b>راهنما</b> را بفرستید:' },
};

const FIELD_LABELS: Record<CheckoutField, string> = { name: '👤 نام', address: '📍 آدرس', phone: '📱 شماره موبایل' };

/** Which details customers give at checkout; each one toggles on and off. */
export const checkoutFieldsView = (fields: CheckoutField[]): View => ({
  text: sections(
    heading('🧾', 'اطلاعات ثبت سفارش'),
    'مشتری هنگام خرید کدام اطلاعات را وارد کند؟',
    quote(CHECKOUT_FIELDS.map((f) => `${fields.includes(f) ? '✅' : '⬜️'} ${FIELD_LABELS[f]}`).join('\n')),
    hint('روی هر مورد بزنید تا روشن یا خاموش شود. اگر همه خاموش باشند، مشتری مستقیم به مرحله‌ی پرداخت می‌رود.'),
  ),
  keyboard: inline(
    ...CHECKOUT_FIELDS.map((f) => [
      button(`${fields.includes(f) ? '✅' : '⬜️'} ${FIELD_LABELS[f]}`, A.toggleCheckoutField(f), fields.includes(f) ? 'success' : undefined),
    ]),
    backRow(A.settings, '🔙 تنظیمات'),
  ),
});

export const settingsMenu = (values: Record<SettingKey, string>, fields?: CheckoutField[]): View => ({
  text: sections(
    heading('⚙️', 'تنظیمات ربات'),
    quote(
      `🏪 <b>${e(values.shop_name)}</b>\n` +
        `👋 ${e(truncate(values.welcome_text, 60))}\n` +
        `🧾 کد رهگیری: <code>${e(values.track_prefix)}XXXXX</code>\n` +
        `💳 ${e(truncate(values.bank_info, 40))}\n` +
        `🗣️ ${e(truncate(values.support, 40))}` +
        (fields ? `\n🧾 هنگام خرید: ${fields.length ? fields.map((f) => FIELD_LABELS[f]).join('، ') : 'بدون پرسش'}` : ''),
    ),
    '👇 کدام بخش را ویرایش می‌کنید؟',
  ),
  keyboard: inline(
    [button(SETTING_LABELS.shop_name.button, A.editSetting('shop_name')), button(SETTING_LABELS.welcome_text.button, A.editSetting('welcome_text'))],
    [button(SETTING_LABELS.bank_info.button, A.editSetting('bank_info')), button(SETTING_LABELS.support.button, A.editSetting('support'))],
    [button(SETTING_LABELS.help_text.button, A.editSetting('help_text')), button(SETTING_LABELS.track_prefix.button, A.editSetting('track_prefix'))],
    [button('⏰ زمان‌بندی سفارش', A.schedule), button('🧾 اطلاعات ثبت سفارش', A.checkoutFields)],
    [button('👮 ادمین‌ها', A.admins)],
    toAdminRoot(),
  ),
});

/** Admins from the Worker config can't be removed here; ones who joined with /claim can. */
export const adminsPage = (configured: number[], claimed: number[], me: number): View => ({
  text: sections(
    heading('👮', 'ادمین‌ها'),
    quote(
      [
        ...configured.map((id) => `🔒 <code>${id}</code> ${hint('(از تنظیمات Cloudflare)')}`),
        ...claimed.filter((id) => !configured.includes(id)).map((id) => `👤 <code>${id}</code>${id === me ? ` ${hint('(شما)')}` : ''}`),
      ].join('\n') || hint('هیچ ادمینی ثبت نشده'),
    ),
    `➕ برای افزودن ادمین جدید، او باید در ربات این را بفرستد:\n<code>/claim WEBHOOK_SECRET</code>\n${hint('WEBHOOK_SECRET همان رمزی است که هنگام دیپلوی تعیین کردید؛ آن را فقط به افراد مورد اعتماد بدهید.')}`,
  ),
  keyboard: inline(
    ...claimed.filter((id) => !configured.includes(id)).map((id) => [button(`🗑 حذف ${id}`, A.removeAdmin(id), 'danger')]),
    backRow(A.settings, '🔙 تنظیمات'),
  ),
});

/* ---------- FAQs ---------- */

export const faqsManage = (faqs: Faq[]): View => ({
  text: sections(heading('❓', 'سوالات متداول'), faqs.length ? '👇 برای ویرایش یا حذف، روی سوال بزنید.' : hint('هنوز سوالی ثبت نشده است.'), faqs.length ? hint('🟢 فعال   🔴 غیرفعال') : ''),
  keyboard: inline(
    [button('➕ افزودن سوال جدید', A.addFaq, 'success')],
    ...faqs.map((f) => [button(`${statusIcon(f.status)} ${truncate(f.question, 40)}`, A.faq(f.id))]),
    toAdminRoot(),
  ),
});

export const faqPage = (f: Faq): View => ({
  text: sections(
    `❓ <b>${e(f.question)}</b>`,
    expandable(`✅ ${e(f.answer)}`),
    `📌 وضعیت: ${f.status === 'enable' ? '🟢 فعال (به مشتری‌ها نمایش داده می‌شود)' : '🔴 غیرفعال (پنهان)'}`,
  ),
  keyboard: inline(
    [button('✏️ ویرایش سوال', A.editFaq(f.id, 'question')), button('✏️ ویرایش پاسخ', A.editFaq(f.id, 'answer'))],
    [toggleButton(f.status, A.toggleFaq(f.id)), button('🗑 حذف', A.deleteFaq(f.id), 'danger')],
    backRow(A.faqs, '🔙 لیست سوالات'),
  ),
});

export const faqDeleteConfirm = (f: Faq): View => ({
  text: sections(heading('⚠️', 'حذف سوال'), quote(e(f.question)), hint('این کار قابل بازگشت نیست.')),
  keyboard: inline([button('🗑 بله، حذف کن', A.deleteFaqConfirm(f.id), 'danger'), button('انصراف', A.faq(f.id))]),
});

/* ---------- categories ---------- */

const toggleButton = (status: string, data: string) =>
  status === 'enable' ? button('🔴 غیرفعال کن', data, 'danger') : button('🟢 فعال کن', data, 'success');

export const categoriesManage = (cats: CategoryWithCount[]): View => ({
  text: sections(
    heading('📂', 'دسته‌بندی‌ها'),
    cats.length ? '👇 برای ویرایش، فعال/غیرفعال کردن یا حذف، روی دسته‌بندی بزنید.' : hint('هنوز دسته‌بندی‌ای ساخته نشده است.'),
    cats.length ? hint('🟢 فعال   🔴 غیرفعال') : '',
  ),
  keyboard: inline(
    [button('➕ دسته‌بندی جدید', A.addCategory, 'success')],
    ...cats.map((c) => [button(`${statusIcon(c.status)} ${c.icon} ${c.name} · ${fa(c.product_count)} محصول`, A.category(c.id))]),
    toAdminRoot(),
  ),
});

export const categoryPage = (c: CategoryWithCount): View => ({
  text: sections(
    `${c.icon} <b>${e(c.name)}</b>`,
    quote(
      `📦 تعداد محصولات: <b>${fa(c.product_count)}</b>\n` +
        `📌 وضعیت: ${c.status === 'enable' ? '🟢 فعال' : '🔴 غیرفعال (این دسته و محصولاتش از دید مشتری پنهان‌اند)'}`,
    ),
    c.product_count ? hint('🗑 حذف فقط برای دسته‌بندی خالی ممکن است؛ اول محصولاتش را به دسته‌ی دیگری منتقل کنید.') : '',
  ),
  keyboard: inline(
    [button('✏️ تغییر نام', A.editCategory(c.id, 'name')), button('🎨 تغییر ایموجی', A.editCategory(c.id, 'icon'))],
    [toggleButton(c.status, A.toggleCategory(c.id)), ...(c.product_count ? [] : [button('🗑 حذف', A.deleteCategory(c.id), 'danger')])],
    [button('⏰ زمان‌بندی سفارش این دسته', A.scheduleCategory(c.id))],
    backRow(A.categories, '🔙 لیست دسته‌بندی‌ها'),
  ),
});

export const categoryDeleteConfirm = (c: Category): View => ({
  text: sections(heading('⚠️', 'حذف دسته‌بندی'), quote(`${c.icon} <b>${e(c.name)}</b>`), hint('این کار قابل بازگشت نیست.')),
  keyboard: inline([button('🗑 بله، حذف کن', A.deleteCategoryConfirm(c.id), 'danger'), button('انصراف', A.category(c.id))]),
});

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

export const ordersList = (orders: Order[], page: number, hasNext: boolean): View =>
  orders.length
    ? {
        text: sections(heading('🧾', 'سفارشات'), `${hint('جدیدترین اول')}\n${STATUS_LEGEND}`),
        keyboard: inline(...orders.map((o) => [orderButton(o)]), ...openPager(page, hasNext, A.ordersPage), toAdminRoot()),
      }
    : done(sections(heading('🧾', 'سفارشات'), 'هنوز سفارشی ثبت نشده است.'));

/* ---------- customers ---------- */

const customerLabel = (c: CustomerSummary) =>
  `${c.status === 'disable' ? '🚫' : c.awaiting_review ? '🟡' : '👤'} ${truncate(c.name || String(c.chat_id), 22)} · ${fa(c.orders_count)} سفارش`;

export const customersList = (customers: CustomerSummary[], page: number, hasNext: boolean): View => ({
  text: sections(
    heading('👥', 'مشتریان'),
    customers.length ? `${hint('به ترتیب آخرین فعالیت')}\n${hint('🟡 سفارش منتظر تایید دارد   🚫 مسدود')}` : 'هنوز مشتری‌ای ندارید.',
  ),
  keyboard: inline(
    [button('🔍 جستجوی مشتری', A.findCustomer, 'primary')],
    ...customers.map((c) => [button(customerLabel(c), A.customer(c.id))]),
    ...openPager(page, hasNext, A.customersPage),
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
export const orderView = ({ order, details, lines, slots }: FullOrder, title = heading('🧾', 'جزئیات سفارش')): View => {
  const contact = details && contactLines({ name: `${details.first_name} ${details.last_name}`, address: details.address, phone: details.phone_number });
  const text = sections(
    `${title}\n<code>${order.track_id}</code>`,
    `🗓 ${formatPersianDate(order.time)}\n📌 وضعیت: <b>${STATUS_FA[order.status]}</b>`,
    slots.length > 0 && slotLines(slots),
    contact && quote(contact),
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
