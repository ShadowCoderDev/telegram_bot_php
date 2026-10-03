import { ADMIN_HEADROOM, CAPACITY_KEYS, CRITICAL_SHARE, SHOP_MAX_SHARE, type CapacityKey, type CapacityReport, type QuotaUsage, type Share } from '../capacity';
import type { ShopRow, SubscriptionPayment } from '../db/platform';
import type { PlatformSettingKey } from '../db/repositories';
import { UNCAPPED, type DayUsage } from '../db/usage';
import { PLAN_LIMITS } from '../limits';
import { GRACE_DAYS, RENEW_OPTIONS, daysLeft, purgeAt, shopAccess, type Access, type ReminderStage } from '../services/subscription';
import { backRow, button, inline, urlButton } from '../telegram/keyboard';
import type { InlineKeyboardButton, View } from '../telegram/types';
import { escapeHtml as e } from '../utils/format';
import { formatPersianDate } from '../utils/persian';
import { LEARN } from './tutorial';
import { withCancel, fa, heading, hint, num, quote, sections, toman } from './common';

/** Callback data of the platform bot ("p:" for sellers, "pa:" for the platform owner). */
export const PCB = {
  home: 'p:home',
  cancel: 'p:cancel',
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
    doubleCap: (id: number) => `pa:shop:cap2:${id}`,
    defaultCap: (id: number) => `pa:shop:capdef:${id}`,
    capacity: 'pa:cap',
    capacitySettings: 'pa:capset',
    stats: 'pa:stats',
    settings: 'pa:settings',
    editSetting: (key: PlatformSettingKey) => `pa:set:${key}`,
  },
} as const;

/** Typed answers always come with a glass button to give up (same as /cancel). */
const cancelRow = () => [button('✖️ انصراف', PCB.cancel)];
export const prompt = (text: string): View => withCancel(text, PCB.cancel);
/** A short message that always leaves a way back. */
export const notice = (text: string, ...extra: InlineKeyboardButton[][]): View => ({ text, keyboard: inline(...extra, toHome()) });
const toHome = () => backRow(PCB.home, '🏠 منوی اصلی');
const date = (unix: number) => formatPersianDate(unix).split(' - ')[0];
const botLink = (s: ShopRow) => (s.bot_username ? `@${e(s.bot_username)}` : `#${s.id}`);

const ACCESS_LABEL: Record<Access, string> = {
  ok: '🟢 فعال',
  grace: '🟠 منقضی (مهلت تمدید)',
  expired: '🔴 منقضی (فروشگاه بسته)',
  suspended: '⛔ متوقف‌شده',
};

const statusLine = (s: ShopRow, now: number): string => {
  const access = shopAccess(s, now);
  const left = daysLeft(s.paid_until, now);
  if (s.plan === 'owner') return '👑 فروشگاه اصلی پلتفرم (بدون اشتراک)';
  if (access === 'ok') return `${s.plan === 'trial' ? '🎁 آزمایشی' : '🟢 فعال'} · <b>${fa(left)}</b> روز مانده ${hint(`(تا ${date(s.paid_until)})`)}`;
  return ACCESS_LABEL[access];
};

/** For a closed shop: until when its data is kept. */
const keptUntilLine = (s: ShopRow, now: number, retentionDays: number): string =>
  s.plan !== 'owner' && shopAccess(s, now) === 'expired'
    ? `🗄 داده‌ها تا <b>${date(purgeAt(s.paid_until, retentionDays))}</b> نگه داشته می‌شود، بعد پاک می‌شود مگر تمدید شود.`
    : '';

/** Today's usage of a shop's bot against its daily cap. */
export interface ShopUsage {
  today: DayUsage;
  cap: number;
}

const usageLine = (u: ShopUsage): string =>
  u.cap >= UNCAPPED
    ? `📶 پیام‌های امروز: <b>${num(u.today.updates)}</b> ${hint('(بدون سقف)')}`
    : `📶 مصرف امروز: <b>${num(Math.min(u.today.updates, u.cap))}</b> از ${num(u.cap)} پیام ${hint(`(${fa(Math.round((100 * u.today.updates) / u.cap))}٪)`)}` +
      (u.today.updates >= u.cap ? '\n⛔ ظرفیت امروز تکمیل شده؛ از ۳:۳۰ بامداد دوباره باز می‌شود.' : '');

/* ---------- sellers ---------- */

export const welcome = (price: number, trialDays: number, isPlatformAdmin: boolean): View => ({
  text: sections(
    heading('🏪', 'فروشگاه‌ساز تلگرام'),
    'فروشگاه تلگرامی خودت را در <b>۲ دقیقه</b> بساز؛ بدون سرور، بدون برنامه‌نویسی.',
    quote(
      '🛍 دسته‌بندی، محصول با عکس، سبد خرید\n' +
        '💳 پرداخت کارت‌به‌کارت با رسید و تایید سفارش\n' +
        '⏰ نوبت‌دهی و زمان تحویل (پزشک، غذا، دریافت حضوری)\n' +
        '🔎 جستجوی محصول در هر چت (Inline)\n' +
        '👥 لیست مشتری‌ها، آمار فروش، گفتگو با خریدار\n' +
        '🛡 قفل قیمت، ضد اسپم و ضد رسید تکراری',
    ),
    `🎁 <b>${fa(trialDays)} روز رایگان</b>، بعد فقط <b>${toman(price)}</b> در ماه.`,
  ),
  keyboard: inline(
    [button('➕ ساخت فروشگاه جدید', PCB.newShop, 'success')],
    [button('🏪 فروشگاه‌های من', PCB.shops, 'primary')],
    [button('📚 آموزش گام‌به‌گام', 'p:learn')],
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
    hint('بلد نیستید؟ «📚 آموزش» در منوی اصلی، قدم‌به‌قدم با عکس نشان می‌دهد.'),
    hint('توکن رمزنگاری‌شده ذخیره می‌شود و پیام شما بلافاصله پاک می‌شود.'),
  ),
  keyboard: inline([button('📚 آموزش ساخت ربات', LEARN.index)], cancelRow()),
});

export const shopCreated = (s: ShopRow, trialDays: number): View => ({
  text: sections(
    heading('🎉', 'فروشگاه شما ساخته شد!'),
    quote(`🤖 ربات: @${e(s.bot_username)}\n🎁 دوره‌ی آزمایشی: <b>${fa(trialDays)}</b> روز (تا ${date(s.paid_until)})`),
    `👇 حالا به ربات فروشگاه‌تان بروید و <b>/start</b> را بزنید؛ شما ادمین آن هستید و پنل مدیریت را می‌بینید.`,
    hint('اول از «⚙️ تنظیمات» نام فروشگاه و شماره کارت را وارد کنید، بعد دسته‌بندی و محصول اضافه کنید.'),
  ),
  keyboard: inline(
    [urlButton(`🤖 رفتن به @${s.bot_username}`, `https://t.me/${s.bot_username}`, 'success')],
    [button('📚 قدم بعدی: آموزش', 'p:learn:3'), button('🏪 فروشگاه‌های من', PCB.shops)],
  ),
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

export const shopPage = (s: ShopRow, now: number, claimCode: string, pendingPayment: boolean, usage: ShopUsage, retentionDays: number): View => ({
  text: sections(
    `🤖 <b>${botLink(s)}</b>`,
    quote(`📌 ${statusLine(s, now)}\n${usageLine(usage)}\n🗓 ساخته‌شده: ${date(s.created_at)}`),
    keptUntilLine(s, now, retentionDays),
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
  ),
  keyboard: inline(cancelRow()),
});

export const paymentReceived = (): View => ({
  text: sections(heading('✅', 'رسید دریافت شد'), 'پس از بررسی، اشتراک شما تمدید می‌شود و همین‌جا خبرتان می‌کنیم.', hint('معمولاً کمتر از چند ساعت.')),
  keyboard: inline(toHome()),
});

export const limitsView = (price: number, trialDays: number, caps: { trial: number; paid: number }, retentionDays: number): View => ({
  text: sections(
    heading('📋', 'امکانات و محدودیت‌ها'),
    `💰 <b>قیمت:</b> ${toman(price)} در ماه · 🎁 ${fa(trialDays)} روز رایگان`,
    `<b>در هر فروشگاه:</b>\n` +
      quote(
        `📶 تا <b>${num(caps.paid)}</b> پیام و کلیک مشتری در روز ${hint(`(دوره‌ی آزمایشی: ${num(caps.trial)})`)}\n` +
          `📦 تا <b>${fa(PLAN_LIMITS.products)}</b> محصول\n` +
          `📂 تا <b>${fa(PLAN_LIMITS.categories)}</b> دسته‌بندی\n` +
          `❓ تا <b>${fa(PLAN_LIMITS.faqs)}</b> سوال متداول\n` +
          `👮 مالک + تا <b>${fa(PLAN_LIMITS.extraAdmins)}</b> ادمین دیگر\n` +
          '👥 تعداد مشتری و سفارش: <b>نامحدود</b>\n' +
          '🖼 عکس محصول و رسید: <b>نامحدود</b> (عکس‌ها روی سرورهای تلگرام نگه‌داری می‌شوند)',
      ),
    hint(
      `اگر اشتراک تمام شود، فروشگاه همان لحظه برای مشتری‌ها بسته می‌شود (نه محصولی می‌بینند نه سفارش می‌دهند)؛ پنل خودتان ${fa(GRACE_DAYS)} روز دیگر برای تمدید باز می‌ماند. ` +
        `داده‌ها ${fa(retentionDays)} روز دیگر نگه داشته می‌شود و با تمدید همه‌چیز فوراً برمی‌گردد؛ بعد از آن پاک می‌شود.`,
    ),
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

export const reminder = (s: ShopRow, stage: ReminderStage, retentionDays: number): View => {
  const deleteOn = `<b>${date(purgeAt(s.paid_until, retentionDays))}</b>`;
  return {
    text:
      stage === 1
        ? sections(heading('⏰', 'اشتراک رو به پایان است'), `اشتراک فروشگاه ${botLink(s)} تا <b>${date(s.paid_until)}</b> معتبر است.`, 'برای اینکه فروشگاه‌تان بسته نشود، همین حالا تمدید کنید.')
        : stage === 2
          ? sections(heading('⚠️', 'اشتراک تمام شد'), `اشتراک فروشگاه ${botLink(s)} تمام شده. فروشگاه از همین لحظه برای مشتری‌ها بسته است و پنل شما <b>${fa(GRACE_DAYS)} روز</b> دیگر برای تمدید باز می‌ماند.`)
          : stage === 3
            ? sections(
                heading('🔒', 'فروشگاه بسته شد'),
                `فروشگاه ${botLink(s)} بسته شد: مشتری‌ها نه محصولی می‌بینند و نه می‌توانند سفارش بدهند.`,
                `داده‌های شما (محصولات، مشتری‌ها، سفارش‌ها) تا ${deleteOn} نگه داشته می‌شود و با تمدید، فوراً همه‌چیز برمی‌گردد.`,
              )
            : sections(
                heading('🗑', 'داده‌های فروشگاه به‌زودی پاک می‌شود'),
                `اگر فروشگاه ${botLink(s)} تا ${deleteOn} تمدید نشود، همه‌ی محصولات، مشتری‌ها و سفارش‌هایش <b>برای همیشه پاک می‌شود</b>.`,
              ),
    keyboard: inline([button('💳 تمدید اشتراک', PCB.renew(s.id), 'success')]),
  };
};

/** Sent when a lapsed shop's data has been deleted. */
export const purgedNotice = (s: ShopRow): View => ({
  text: sections(
    heading('🗑', 'داده‌های فروشگاه پاک شد'),
    `مهلت نگهداری فروشگاه ${botLink(s)} تمام شد و داده‌هایش پاک شد. ربات هم از پلتفرم جدا شد.`,
    hint('هر وقت خواستید، می‌توانید دوباره فروشگاه بسازید.'),
  ),
  keyboard: inline([button('➕ ساخت فروشگاه', PCB.newShop, 'success')]),
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
    [button('📈 ظرفیت', PCB.admin.capacity), button('⚙️ تنظیمات', PCB.admin.settings)],
    [button('👀 منوی فروشنده', PCB.home)],
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

export const adminShopPage = (s: ShopRow, now: number, payments: SubscriptionPayment[], usage: ShopUsage, retentionDays: number): View => ({
  text: sections(
    `🤖 <b>${botLink(s)}</b>  ${hint(`#${s.id}`)}`,
    quote(`📌 ${statusLine(s, now)}\n👤 مالک: <code>${s.owner_chat_id}</code>\n🗓 ساخته‌شده: ${date(s.created_at)}`),
    keptUntilLine(s, now, retentionDays),
    quote(
      `${usageLine(usage)}\n` +
        (s.plan === 'owner' ? '' : `🎚 سقف: ${s.daily_limit ? '<b>اختصاصی</b>' : 'پیش‌فرض پلن'}\n`) +
        `✍️ نوشتن امروز: ${num(usage.today.rows_written)} · 🚫 ردشده: ${num(usage.today.dropped)}`,
    ),
    payments.length
      ? `💳 <b>پرداخت‌ها</b>\n${quote(payments.map((p) => `${p.status === 'approved' ? '✅' : p.status === 'pending' ? '🟡' : '❌'} ${date(p.created_at)} · ${fa(p.months)} ماه · ${toman(p.amount)}`).join('\n'))}`
      : '',
  ),
  keyboard: inline(
    ...(s.plan === 'owner'
      ? []
      : [
          [button('➕ ۳۰ روز رایگان', PCB.admin.addDays(s.id), 'success')],
          [button('⬆️ سقف روزانه ×۲', PCB.admin.doubleCap(s.id)), ...(s.daily_limit ? [button('↩️ سقف پیش‌فرض', PCB.admin.defaultCap(s.id))] : [])],
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
  retention_days: {
    button: '🗄 مهلت نگهداری داده',
    prompt: 'فروشگاهی که تمدید نکند، چند روز بعد از بسته شدن <b>داده‌هایش پاک شود</b>؟ (۷ تا ۳۶۵)',
  },
  bank_info: { button: '🏦 اطلاعات کارت', prompt: 'اطلاعات <b>کارت</b> برای دریافت اشتراک را بفرستید:' },
  support: { button: '🗣 پشتیبانی', prompt: 'آیدی یا متن <b>پشتیبانی</b> پلتفرم را بفرستید:' },
  trial_daily_limit: { button: '🎁 سقف آزمایشی', prompt: 'سقف <b>پیام روزانه</b>ی هر فروشگاه آزمایشی را بفرستید (عدد):' },
  paid_daily_limit: { button: '💳 سقف با اشتراک', prompt: 'سقف <b>پیام روزانه</b>ی هر فروشگاه با اشتراک را بفرستید (عدد):' },
  platform_daily_limit: { button: '🏗 سقف ربات پلتفرم', prompt: 'سقف <b>پیام روزانه</b>ی فروشنده‌ها در ربات پلتفرم را بفرستید (مدیرها سقف ندارند):' },
  alert_percent: { button: '🔔 درصد هشدار', prompt: 'وقتی مصرف روزانه به چند <b>درصد</b> سهمیه رسید هشدار بگیرید؟ (۱۰ تا ۸۵)' },
  quota_requests: { button: '⚡️ سهمیه درخواست', prompt: 'سهمیه‌ی <b>درخواست روزانه</b>ی Cloudflare را بفرستید (پلن رایگان: 100000):' },
  quota_writes: { button: '✍️ سهمیه نوشتن', prompt: 'سهمیه‌ی <b>نوشتن روزانه</b> در D1 را بفرستید (پلن رایگان: 100000):' },
  quota_reads: { button: '📖 سهمیه خواندن', prompt: 'سهمیه‌ی <b>خواندن روزانه</b> از D1 را بفرستید (پلن رایگان: 5000000):' },
  quota_storage_mb: { button: '💾 حجم دیتابیس', prompt: 'حداکثر <b>حجم دیتابیس</b> را به مگابایت بفرستید (پلن رایگان: 500، پلن پولی: 10000):' },
};

export const settingsView = (values: Record<PlatformSettingKey, string>): View => ({
  text: sections(
    heading('⚙️', 'تنظیمات پلتفرم'),
    quote(
      `💰 قیمت ماهانه: <b>${toman(Number(values.monthly_price))}</b>\n🎁 آزمایشی: <b>${fa(values.trial_days)}</b> روز\n` +
        `🗄 نگهداری داده‌ی فروشگاه بسته: <b>${fa(values.retention_days)}</b> روز\n🏦 ${e(values.bank_info)}\n🗣 ${e(values.support)}`,
    ),
  ),
  keyboard: inline(
    [button(PLATFORM_SETTING_LABELS.monthly_price.button, PCB.admin.editSetting('monthly_price')), button(PLATFORM_SETTING_LABELS.trial_days.button, PCB.admin.editSetting('trial_days'))],
    [button(PLATFORM_SETTING_LABELS.retention_days.button, PCB.admin.editSetting('retention_days'))],
    [button(PLATFORM_SETTING_LABELS.bank_info.button, PCB.admin.editSetting('bank_info')), button(PLATFORM_SETTING_LABELS.support.button, PCB.admin.editSetting('support'))],
    backRow(PCB.admin.root, '🔙 پنل'),
  ),
});

/* ---------- capacity ---------- */

const bar = (share: number): string => {
  const filled = Math.max(0, Math.min(10, Math.round(share * 10)));
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
};
const pct = (share: number): string => `${fa(Math.round(share * 100))}٪`;
const dayDate = (utcDay: number) => date(utcDay * 86_400 + 43_200);
const shareIcon = (share: number, alertShare: number) => (share >= CRITICAL_SHARE ? '🔴' : share >= alertShare ? '🟠' : '🟢');
const quotaLine = (icon: string, label: string, s: Share, alertShare: number): string =>
  `${icon} ${label}: <b>${num(s.used)}</b> از ${num(s.quota)}\n${bar(s.share)} ${shareIcon(s.share, alertShare)} ${pct(s.share)}`;
const mb = (bytes: number) => `${fa((bytes / 1024 / 1024).toFixed(bytes < 100 * 1024 * 1024 ? 1 : 0))} MB`;
const storageLine = (s: Share, alertShare: number) => `💾 حجم دیتابیس: <b>${mb(s.used)}</b> از ${mb(s.quota)}\n${bar(s.share)} ${shareIcon(s.share, alertShare)} ${pct(s.share)}`;
const usageName = (shopId: number, username: string | null) => (shopId === 0 ? 'ربات پلتفرم' : username ? `@${e(username)}` : `#${shopId}`);

const LEVEL_TEXT = (r: CapacityReport): string =>
  r.level === 0
    ? `🟢 <b>امن.</b> تا حد هشدار (${pct(r.alertShare)}) امروز حدود <b>${num(r.updatesLeft)}</b> پیام دیگر جا هست.`
    : r.level === 1
      ? `🟠 <b>مصرف امروز از حد هشدار (${pct(r.alertShare)}) گذشته.</b> Workers Paid را فعال کنید یا سقف فروشگاه‌های پرمصرف را کم کنید.`
      : '🔴 <b>نزدیک سقف Cloudflare.</b> اگر سهمیه تمام شود، همه‌ی فروشگاه‌ها تا ۳:۳۰ بامداد از کار می‌افتند. همین حالا Workers Paid را فعال کنید.';

/** The platform owner's capacity page: today's use of the Cloudflare quotas and what's left. */
export const capacityView = (r: CapacityReport): View => ({
  text: sections(
    heading('📈', 'ظرفیت پلتفرم'),
    hint('امروز، از ساعت ۳:۳۰ بامداد (۰۰:۰۰ UTC) که سهمیه‌های Cloudflare صفر می‌شوند'),
    quote(
      [
        quotaLine('⚡️', 'درخواست', r.requests, r.alertShare),
        quotaLine('✍️', 'نوشتن در دیتابیس', r.writes, r.alertShare),
        quotaLine('📖', 'خواندن از دیتابیس', r.reads, r.alertShare),
        storageLine(r.storage, r.alertShare),
      ].join('\n\n'),
    ),
    LEVEL_TEXT(r),
    `🧮 <b>هزینه‌ی هر پیام</b> ${hint(r.perUpdate.measured ? '(اندازه‌گیری‌شده)' : '(تخمین؛ هنوز ترافیک کافی نیست)')}\n` +
      quote(`✍️ ${fa(r.perUpdate.writes.toFixed(1))} نوشتن · 📖 ${fa(Math.round(r.perUpdate.reads))} خواندن`),
    r.growth &&
      `🏪 <b>جا برای فروشگاه جدید</b>\n` +
        quote(
          `هر فروشگاه در شلوغ‌ترین روز اخیر: ${num(r.growth.perShopRequests)} درخواست · ${num(r.growth.perShopWrites)} نوشتن\n` +
            `➕ تا حد هشدار حدود <b>${num(r.growth.moreShops)}</b> فروشگاه مثل این‌ها دیگر جا دارید.`,
        ),
    r.worstCase.shops > 0 &&
      `🛡 <b>بدترین حالت</b>\n` +
        quote(
          `اگر هر ${fa(r.worstCase.shops)} فروشگاه باز هم‌زمان به سقف روزانه‌شان برسند: ${num(r.worstCase.updates)} پیام ≈ <b>${pct(r.worstCase.share)}</b> سهمیه.\n` +
            (r.worstCase.share <= r.alertShare
              ? '✅ حتی در این حالت هم از سهمیه رد نمی‌شوید.'
              : '⚠️ فقط اگر بیشتر فروشگاه‌ها هم‌زمان پرمصرف شوند از حد هشدار رد می‌شوید؛ هشدار خودکار ساعتی بررسی می‌کند.'),
        ),
    r.top.length > 0 &&
      `🔥 <b>پرمصرف‌های امروز</b>\n` +
        quote(r.top.map((t, i) => `${fa(i + 1)}. ${usageName(t.shop_id, t.bot_username)} · ${num(t.updates)} پیام · ${num(t.rows_written)} نوشتن`).join('\n')),
    r.history.length > 0 &&
      `🗓 <b>روزهای اخیر</b>\n` +
        quote(r.history.map((h) => `${dayDate(h.day)} · ${num(h.updates)} پیام · ${num(h.rows_written)} نوشتن ${hint(`(${pct(h.rows_written / r.writes.quota)})`)}`).join('\n')),
    hint('عدد دقیق Cloudflare: داشبورد ← Workers & Pages و Storage & Databases ← D1 ← Metrics.'),
  ),
  keyboard: inline(
    [button('🔄 به‌روزرسانی', PCB.admin.capacity), button('⚙️ سقف‌ها و سهمیه‌ها', PCB.admin.capacitySettings)],
    backRow(PCB.admin.root, '🔙 پنل'),
  ),
});

export const capacitySettingsView = (v: Record<CapacityKey, string>): View => ({
  text: sections(
    heading('⚙️', 'سقف‌ها و سهمیه‌ها'),
    `🎚 <b>سقف پیام روزانه</b>\n` +
      quote(
        `🎁 فروشگاه آزمایشی: <b>${num(Number(v.trial_daily_limit))}</b>\n💳 فروشگاه با اشتراک: <b>${num(Number(v.paid_daily_limit))}</b>\n` +
          `🏗 فروشنده‌ها در ربات پلتفرم: <b>${num(Number(v.platform_daily_limit))}</b>`,
      ),
    hint(`ادمین‌های هر فروشگاه تا ${fa(ADMIN_HEADROOM)} برابر سقف کار می‌کنند، و هیچ فروشگاهی بیش از ${fa(Math.round(SHOP_MAX_SHARE * 100))}٪ سهمیه‌ی روزانه‌ی دیتابیس را مصرف نمی‌کند.`),
    `☁️ <b>سهمیه‌ی روزانه‌ی Cloudflare</b> ${hint('(هشدار در ' + fa(v.alert_percent) + '٪)')}\n` +
      quote(
        `⚡️ درخواست: <b>${num(Number(v.quota_requests))}</b>\n✍️ نوشتن: <b>${num(Number(v.quota_writes))}</b>\n📖 خواندن: <b>${num(Number(v.quota_reads))}</b>\n` +
          `💾 حجم دیتابیس: <b>${num(Number(v.quota_storage_mb))}</b> MB`,
      ),
    hint('پیش‌فرض‌ها سقف‌های پلن رایگان است. با Workers Paid (ماهی ۵ دلار) سهمیه ماهانه می‌شود: مثلاً درخواست ۳۳۰٬۰۰۰، نوشتن ۱٬۶۰۰٬۰۰۰ در روز و حجم ۱۰٬۰۰۰ MB بگذارید.'),
  ),
  keyboard: inline(
    ...[0, 2, 4, 6].map((i) => CAPACITY_KEYS.slice(i, i + 2).map((k) => button(PLATFORM_SETTING_LABELS[k].button, PCB.admin.editSetting(k)))),
    backRow(PCB.admin.capacity, '🔙 ظرفیت'),
  ),
});

/** Sent by the hourly check when a quota passes the alarm threshold (once per level per day). */
export const capacityAlarm = (r: QuotaUsage): View => ({
  text: sections(
    heading(r.level === 2 ? '🔴' : '🟠', r.level === 2 ? 'ظرفیت پلتفرم نزدیک سقف Cloudflare است' : 'هشدار ظرفیت پلتفرم'),
    quote(
      [
        quotaLine('⚡️', 'درخواست', r.requests, r.alertShare),
        quotaLine('✍️', 'نوشتن', r.writes, r.alertShare),
        quotaLine('📖', 'خواندن', r.reads, r.alertShare),
        storageLine(r.storage, r.alertShare),
      ].join('\n\n'),
    ),
    `<b>چه کار کنم؟</b>\n` +
      quote(
        '۱. در داشبورد Cloudflare پلن <b>Workers Paid</b> (ماهی ۵ دلار) را فعال کنید؛ سقف روزانه برداشته می‌شود.\n' +
          '۲. یا سقف روزانه‌ی فروشگاه‌های پرمصرف را پایین بیاورید (📈 ظرفیت ← پرمصرف‌ها).',
      ),
    hint('اگر سهمیه‌ای تمام شود، همه‌ی فروشگاه‌ها تا ۳:۳۰ بامداد از کار می‌افتند.'),
  ),
  keyboard: inline([button('📈 جزئیات ظرفیت', PCB.admin.capacity, 'primary')]),
});
