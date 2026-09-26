import type { ShopRow, SubscriptionPayment } from '../db/platform';
import type { PlatformSettingKey } from '../db/repositories';
import { PLAN_LIMITS } from '../limits';
import { RENEW_OPTIONS, daysLeft, shopAccess, type Access } from '../services/subscription';
import { backRow, button, inline, urlButton } from '../telegram/keyboard';
import type { View } from '../telegram/types';
import { escapeHtml as e } from '../utils/format';
import { formatPersianDate } from '../utils/persian';
import { CANCEL_HINT, fa, heading, hint, quote, sections, toman } from './common';

/** Callback data of the platform bot ("p:" for sellers, "pa:" for the platform owner). */
export const PCB = {
  home: 'p:home',
  newShop: 'p:new',
  shops: 'p:shops',
  shop: (id: number) => `p:shop:${id}`,
  renew: (id: number) => `p:renew:${id}`,
  pay: (id: number, months: number) => `p:pay:${id}:${months}`,
  changeToken: (id: number) => `p:token:${id}`,
  reconnect: (id: number) => `p:hook:${id}`,
  deleteShop: (id: number) => `p:del:${id}`,
  deleteShopConfirm: (id: number) => `p:delok:${id}`,
  limits: 'p:limits',
  support: 'p:support',
  admin: {
    root: 'pa:root',
    payments: 'pa:pays',
    payment: (id: number) => `pa:pay:${id}`,
    approve: (id: number) => `pa:pay:ok:${id}`,
    reject: (id: number) => `pa:pay:no:${id}`,
    shops: 'pa:shops',
    shopsPage: (page: number) => `pa:shops:${page}`,
    shop: (id: number) => `pa:shop:${id}`,
    addDays: (id: number) => `pa:shop:add30:${id}`,
    toggleSuspend: (id: number) => `pa:shop:susp:${id}`,
    stats: 'pa:stats',
    settings: 'pa:settings',
    editSetting: (key: PlatformSettingKey) => `pa:set:${key}`,
  },
} as const;

const toHome = () => backRow(PCB.home, '🏠 منوی اصلی');
const date = (unix: number) => formatPersianDate(unix).split(' - ')[0];
const botLink = (s: ShopRow) => (s.bot_username ? `@${e(s.bot_username)}` : `#${s.id}`);

const ACCESS_LABEL: Record<Access, string> = {
  ok: '🟢 فعال',
  grace: '🟠 منقضی (مهلت تمدید)',
  expired: '🔴 منقضی (بسته برای مشتری)',
  suspended: '⛔ متوقف‌شده',
};

const statusLine = (s: ShopRow, now: number): string => {
  const access = shopAccess(s, now);
  const left = daysLeft(s.paid_until, now);
  if (s.plan === 'owner') return '👑 فروشگاه اصلی پلتفرم (بدون اشتراک)';
  if (access === 'ok') return `${s.plan === 'trial' ? '🎁 آزمایشی' : '🟢 فعال'} · <b>${fa(left)}</b> روز مانده ${hint(`(تا ${date(s.paid_until)})`)}`;
  return ACCESS_LABEL[access];
};

/* ---------- sellers ---------- */

export const welcome = (price: number, trialDays: number, isPlatformAdmin: boolean): View => ({
  text: sections(
    heading('🏪', 'فروشگاه‌ساز تلگرام'),
    'فروشگاه تلگرامی خودت را در <b>۲ دقیقه</b> بساز؛ بدون سرور، بدون برنامه‌نویسی.',
    quote(
      '🛍 دسته‌بندی، محصول با عکس، سبد خرید\n' +
        '💳 پرداخت کارت‌به‌کارت با رسید و تایید سفارش\n' +
        '👥 لیست مشتری‌ها، آمار فروش، گفتگو با خریدار\n' +
        '🛡 قفل قیمت، ضد اسپم و ضد رسید تکراری',
    ),
    `🎁 <b>${fa(trialDays)} روز رایگان</b>، بعد فقط <b>${toman(price)}</b> در ماه.`,
  ),
  keyboard: inline(
    [button('➕ ساخت فروشگاه جدید', PCB.newShop, 'success')],
    [button('🏪 فروشگاه‌های من', PCB.shops, 'primary')],
    [button('📋 امکانات و محدودیت‌ها', PCB.limits), button('🗣 پشتیبانی', PCB.support)],
    ...(isPlatformAdmin ? [[button('🔐 پنل مدیریت پلتفرم', PCB.admin.root)]] : []),
  ),
});

export const newShopInstructions = (): View => ({
  text: sections(
    heading('➕', 'ساخت فروشگاه'),
    quote(
      '۱. به <a href="https://t.me/BotFather">@BotFather</a> بروید و <code>/newbot</code> را بفرستید.\n' +
        '۲. یک اسم و یک یوزرنیم (که به bot ختم شود) برای ربات فروشگاه‌تان انتخاب کنید.\n' +
        '۳. BotFather یک <b>توکن</b> می‌دهد؛ مثل:\n<code>123456789:AAH...</code>',
    ),
    '👇 همان توکن را همین‌جا بفرستید:',
    hint('توکن رمزنگاری‌شده ذخیره می‌شود و پیام شما بلافاصله پاک می‌شود.'),
    CANCEL_HINT,
  ),
});

export const shopCreated = (s: ShopRow, trialDays: number): View => ({
  text: sections(
    heading('🎉', 'فروشگاه شما ساخته شد!'),
    quote(`🤖 ربات: @${e(s.bot_username)}\n🎁 دوره‌ی آزمایشی: <b>${fa(trialDays)}</b> روز (تا ${date(s.paid_until)})`),
    `👇 حالا به ربات فروشگاه‌تان بروید و <b>/start</b> را بزنید؛ شما ادمین آن هستید و پنل مدیریت را می‌بینید.`,
    hint('اول از «⚙️ تنظیمات» نام فروشگاه و شماره کارت را وارد کنید، بعد دسته‌بندی و محصول اضافه کنید.'),
  ),
  keyboard: inline([urlButton(`🤖 رفتن به @${s.bot_username}`, `https://t.me/${s.bot_username}`, 'success')], [button('🏪 فروشگاه‌های من', PCB.shops)]),
});

export const myShops = (shops: ShopRow[], now: number): View =>
  shops.length
    ? {
        text: sections(heading('🏪', 'فروشگاه‌های من'), shops.map((s) => `🤖 <b>${botLink(s)}</b>\n${statusLine(s, now)}`).join('\n\n')),
        keyboard: inline(...shops.map((s) => [button(`🤖 ${s.bot_username || s.id}`, PCB.shop(s.id))]), [button('➕ فروشگاه جدید', PCB.newShop)], toHome()),
      }
    : {
        text: sections(heading('🏪', 'فروشگاه‌های من'), 'هنوز فروشگاهی نساخته‌اید.'),
        keyboard: inline([button('➕ ساخت فروشگاه', PCB.newShop, 'success')], toHome()),
      };

export const shopPage = (s: ShopRow, now: number, claimCode: string, pendingPayment: boolean): View => ({
  text: sections(
    `🤖 <b>${botLink(s)}</b>`,
    quote(`📌 ${statusLine(s, now)}\n🗓 ساخته‌شده: ${date(s.created_at)}`),
    pendingPayment ? '⏳ یک پرداخت شما در حال بررسی است.' : '',
    `👮 برای اضافه کردن ادمین دیگر، او باید در ربات فروشگاه این را بفرستد:\n<code>/claim ${claimCode}</code>\n${hint('این کد را فقط به افراد مورد اعتماد بدهید.')}`,
  ),
  keyboard: inline(
    [button('💳 تمدید اشتراک', PCB.renew(s.id), 'success')],
    [urlButton('🤖 باز کردن ربات', `https://t.me/${s.bot_username}`), button('🔄 اتصال مجدد', PCB.reconnect(s.id))],
    [button('🔑 تغییر توکن', PCB.changeToken(s.id)), button('🗑 حذف فروشگاه', PCB.deleteShop(s.id), 'danger')],
    backRow(PCB.shops, '🔙 فروشگاه‌های من'),
  ),
});

export const renewOptions = (s: ShopRow, price: number, now: number): View => ({
  text: sections(heading('💳', `تمدید اشتراک ${botLink(s)}`), `📌 ${statusLine(s, now)}`, '👇 مدت تمدید را انتخاب کنید:', hint('روزهای باقی‌مانده از بین نمی‌رود؛ تمدید به انتهای دوره‌ی فعلی اضافه می‌شود.')),
  keyboard: inline(
    ...RENEW_OPTIONS.map((m) => [button(`${fa(m)} ماه · ${toman(price * m)}`, PCB.pay(s.id, m), m === 1 ? 'success' : undefined)]),
    backRow(PCB.shop(s.id)),
  ),
});

export const paymentInstructions = (s: ShopRow, months: number, amount: number, bankInfo: string): View => ({
  text: sections(
    heading('💳', `پرداخت ${fa(months)} ماه اشتراک ${botLink(s)}`),
    `💰 <b>مبلغ قابل پرداخت</b>\n${quote(`<b>${toman(amount)}</b>`)}`,
    `🏦 <b>اطلاعات واریز</b> ${hint('(برای کپی لمس کنید)')}\n<code>${e(bankInfo)}</code>`,
    '📸 بعد از واریز، <b>عکس رسید</b> را همین‌جا بفرستید.',
    CANCEL_HINT,
  ),
});

export const paymentReceived = (): View => ({
  text: sections(heading('✅', 'رسید دریافت شد'), 'پس از بررسی، اشتراک شما تمدید می‌شود و همین‌جا خبرتان می‌کنیم.', hint('معمولاً کمتر از چند ساعت.')),
  keyboard: inline(toHome()),
});

export const limitsView = (price: number, trialDays: number): View => ({
  text: sections(
    heading('📋', 'امکانات و محدودیت‌ها'),
    `💰 <b>قیمت:</b> ${toman(price)} در ماه · 🎁 ${fa(trialDays)} روز رایگان`,
    `<b>در هر فروشگاه:</b>\n` +
      quote(
        `📦 تا <b>${fa(PLAN_LIMITS.products)}</b> محصول\n` +
          `📂 تا <b>${fa(PLAN_LIMITS.categories)}</b> دسته‌بندی\n` +
          `❓ تا <b>${fa(PLAN_LIMITS.faqs)}</b> سوال متداول\n` +
          `👮 مالک + تا <b>${fa(PLAN_LIMITS.extraAdmins)}</b> ادمین دیگر\n` +
          '👥 تعداد مشتری و سفارش: <b>نامحدود</b>\n' +
          '🖼 عکس محصول و رسید: <b>نامحدود</b> (عکس‌ها روی سرورهای تلگرام نگه‌داری می‌شوند)',
      ),
    hint('اگر اشتراک تمام شود، فروشگاه ۳ روز دیگر باز می‌ماند؛ بعد برای مشتری‌ها بسته می‌شود ولی هیچ داده‌ای پاک نمی‌شود و با تمدید فوراً باز می‌شود.'),
  ),
  keyboard: inline([button('➕ ساخت فروشگاه', PCB.newShop, 'success')], toHome()),
});

export const supportView = (support: string): View => ({
  text: sections(heading('🗣', 'پشتیبانی'), quote(`<b>${e(support)}</b>`)),
  keyboard: inline(toHome()),
});

export const deleteConfirm = (s: ShopRow): View => ({
  text: sections(
    heading('⚠️', `حذف فروشگاه ${botLink(s)}`),
    'ربات از پلتفرم جدا می‌شود و دیگر به مشتری‌ها جواب نمی‌دهد. اشتراک باقی‌مانده برنمی‌گردد.',
    hint('اگر بعداً با همین ربات دوباره فروشگاه بسازید، داده‌های قبلی برمی‌گردند.'),
  ),
  keyboard: inline([button('🗑 بله، حذف کن', PCB.deleteShopConfirm(s.id), 'danger'), button('انصراف', PCB.shop(s.id))]),
});

export const reminder = (s: ShopRow, stage: 1 | 2 | 3): View => ({
  text:
    stage === 1
      ? sections(heading('⏰', 'اشتراک رو به پایان است'), `اشتراک فروشگاه ${botLink(s)} تا <b>${date(s.paid_until)}</b> معتبر است.`, 'برای اینکه فروشگاه‌تان بسته نشود، همین حالا تمدید کنید.')
      : stage === 2
        ? sections(heading('⚠️', 'اشتراک تمام شد'), `اشتراک فروشگاه ${botLink(s)} تمام شده. فروشگاه فقط <b>۳ روز</b> دیگر برای مشتری‌ها باز می‌ماند.`)
        : sections(heading('🔒', 'فروشگاه بسته شد'), `فروشگاه ${botLink(s)} برای مشتری‌ها بسته شد. داده‌های شما محفوظ است و با تمدید، فوراً باز می‌شود.`),
  keyboard: inline([button('💳 تمدید اشتراک', PCB.renew(s.id), 'success')]),
});

/* ---------- platform owner ---------- */

export const adminRoot = (pendingPayments: number, stats: { total: number; paid: number; trial: number; expired: number }): View => ({
  text: sections(
    heading('🔐', 'پنل مدیریت پلتفرم'),
    quote(`🏪 فروشگاه‌ها: <b>${fa(stats.total)}</b>\n🟢 پولی فعال: <b>${fa(stats.paid)}</b> · 🎁 آزمایشی: <b>${fa(stats.trial)}</b> · 🔴 منقضی: <b>${fa(stats.expired)}</b>`),
    pendingPayments ? `🟡 <b>${fa(pendingPayments)}</b> پرداخت منتظر بررسی است.` : '',
  ),
  keyboard: inline(
    [button(pendingPayments ? `💳 پرداخت‌ها (🟡 ${fa(pendingPayments)})` : '💳 پرداخت‌ها', PCB.admin.payments, 'primary')],
    [button('🏪 فروشگاه‌ها', PCB.admin.shops), button('📊 درآمد', PCB.admin.stats)],
    [button('⚙️ تنظیمات', PCB.admin.settings), button('👀 منوی فروشنده', PCB.home)],
  ),
});

export const paymentsList = (payments: SubscriptionPayment[], shops: Map<number, ShopRow>): View => ({
  text: payments.length ? sections(heading('💳', 'پرداخت‌های منتظر بررسی'), '👇 برای بررسی روی هر مورد بزنید:') : sections(heading('💳', 'پرداخت‌ها'), 'پرداخت منتظری وجود ندارد. ✅'),
  keyboard: inline(
    ...payments.map((p) => [button(`🟡 ${shops.get(p.shop_id)?.bot_username ?? p.shop_id} · ${fa(p.months)} ماه · ${toman(p.amount)}`, PCB.admin.payment(p.id))]),
    backRow(PCB.admin.root, '🔙 پنل'),
  ),
});

export const paymentView = (p: SubscriptionPayment, s: ShopRow | null, now: number, heading_ = heading('💳', 'پرداخت اشتراک')): View => ({
  photo: p.receipt_file_id,
  text: sections(
    heading_,
    quote(
      `🤖 فروشگاه: ${s ? botLink(s) : p.shop_id}\n` +
        `👤 پرداخت‌کننده: <code>${p.payer_chat_id}</code>\n` +
        `🗓 مدت: <b>${fa(p.months)}</b> ماه\n` +
        `💰 مبلغ: <b>${toman(p.amount)}</b>\n` +
        `🕒 ${formatPersianDate(p.created_at)}` +
        (s ? `\n📌 ${statusLine(s, now)}` : ''),
    ),
    p.status === 'pending' ? hint('مبلغ را در حساب بانکی ببینید، بعد تایید کنید.') : `وضعیت: <b>${p.status === 'approved' ? '✅ تایید شده' : '❌ رد شده'}</b>`,
  ),
  keyboard: inline(
    ...(p.status === 'pending' ? [[button('✅ تایید و تمدید', PCB.admin.approve(p.id), 'success'), button('❌ رد', PCB.admin.reject(p.id), 'danger')]] : []),
    backRow(PCB.admin.payments, '🔙 پرداخت‌ها'),
  ),
});

export const shopsList = (shops: ShopRow[], page: number, pages: number, now: number): View => ({
  text: sections(heading('🏪', 'همه‌ی فروشگاه‌ها'), hint('🟢 فعال · 🎁 آزمایشی · 🟠 مهلت · 🔴 بسته · ⛔ متوقف')),
  keyboard: inline(
    ...shops.map((s) => {
      const a = shopAccess(s, now);
      const icon = s.plan === 'owner' ? '👑' : a === 'ok' ? (s.plan === 'trial' ? '🎁' : '🟢') : a === 'grace' ? '🟠' : a === 'expired' ? '🔴' : '⛔';
      return [button(`${icon} ${s.bot_username || `#${s.id}`} · ${s.plan === 'owner' ? '—' : `${fa(daysLeft(s.paid_until, now))} روز`}`, PCB.admin.shop(s.id))];
    }),
    ...(pages > 1
      ? [[...(page > 0 ? [button('◀️ قبلی', PCB.admin.shopsPage(page - 1))] : []), button(`${fa(page + 1)} / ${fa(pages)}`, 'noop'), ...(page < pages - 1 ? [button('بعدی ▶️', PCB.admin.shopsPage(page + 1))] : [])]]
      : []),
    backRow(PCB.admin.root, '🔙 پنل'),
  ),
});

export const adminShopPage = (s: ShopRow, now: number, payments: SubscriptionPayment[]): View => ({
  text: sections(
    `🤖 <b>${botLink(s)}</b>  ${hint(`#${s.id}`)}`,
    quote(`📌 ${statusLine(s, now)}\n👤 مالک: <code>${s.owner_chat_id}</code>\n🗓 ساخته‌شده: ${date(s.created_at)}`),
    payments.length
      ? `💳 <b>پرداخت‌ها</b>\n${quote(payments.map((p) => `${p.status === 'approved' ? '✅' : p.status === 'pending' ? '🟡' : '❌'} ${date(p.created_at)} · ${fa(p.months)} ماه · ${toman(p.amount)}`).join('\n'))}`
      : '',
  ),
  keyboard: inline(
    ...(s.plan === 'owner'
      ? []
      : [
          [button('➕ ۳۰ روز رایگان', PCB.admin.addDays(s.id), 'success')],
          [s.status === 'suspended' ? button('▶️ فعال‌سازی', PCB.admin.toggleSuspend(s.id), 'success') : button('⛔ توقف فروشگاه', PCB.admin.toggleSuspend(s.id), 'danger')],
        ]),
    backRow(PCB.admin.shops, '🔙 فروشگاه‌ها'),
  ),
});

export const revenueView = (r: { month: number; total: number }, stats: { total: number; paid: number; trial: number; expired: number; suspended: number }): View => ({
  text: sections(
    heading('📊', 'درآمد و آمار'),
    quote(`☀️ درآمد این ماه: <b>${toman(r.month)}</b>\n💰 کل درآمد: <b>${toman(r.total)}</b>`),
    quote(
      `🏪 کل فروشگاه‌ها: <b>${fa(stats.total)}</b>\n🟢 پولی فعال: <b>${fa(stats.paid)}</b>\n🎁 آزمایشی: <b>${fa(stats.trial)}</b>\n🔴 منقضی: <b>${fa(stats.expired)}</b>\n⛔ متوقف: <b>${fa(stats.suspended)}</b>`,
    ),
  ),
  keyboard: inline(backRow(PCB.admin.root, '🔙 پنل')),
});

export const PLATFORM_SETTING_LABELS: Record<PlatformSettingKey, { button: string; prompt: string }> = {
  monthly_price: { button: '💰 قیمت ماهانه', prompt: 'قیمت اشتراک ماهانه را به <b>تومان</b> بفرستید (فقط عدد):' },
  trial_days: { button: '🎁 روزهای آزمایشی', prompt: 'تعداد <b>روزهای رایگان</b> فروشگاه جدید را بفرستید (۰ تا ۳۰):' },
  bank_info: { button: '🏦 اطلاعات کارت', prompt: 'اطلاعات <b>کارت</b> برای دریافت اشتراک را بفرستید:' },
  support: { button: '🗣 پشتیبانی', prompt: 'آیدی یا متن <b>پشتیبانی</b> پلتفرم را بفرستید:' },
};

export const settingsView = (values: Record<PlatformSettingKey, string>): View => ({
  text: sections(
    heading('⚙️', 'تنظیمات پلتفرم'),
    quote(
      `💰 قیمت ماهانه: <b>${toman(Number(values.monthly_price))}</b>\n🎁 آزمایشی: <b>${fa(values.trial_days)}</b> روز\n🏦 ${e(values.bank_info)}\n🗣 ${e(values.support)}`,
    ),
  ),
  keyboard: inline(
    [button(PLATFORM_SETTING_LABELS.monthly_price.button, PCB.admin.editSetting('monthly_price')), button(PLATFORM_SETTING_LABELS.trial_days.button, PCB.admin.editSetting('trial_days'))],
    [button(PLATFORM_SETTING_LABELS.bank_info.button, PCB.admin.editSetting('bank_info')), button(PLATFORM_SETTING_LABELS.support.button, PCB.admin.editSetting('support'))],
    backRow(PCB.admin.root, '🔙 پنل'),
  ),
});
