/**
 * "📚 آموزش" in the platform bot: step-by-step lessons for sellers who have never made a bot.
 * Each lesson can show a screenshot the platform owner uploads from the platform bot (stored as a
 * Telegram file_id), so the lessons stay visual without shipping images in the code.
 */
import { backRow, button, inline, urlButton } from '../telegram/keyboard';
import type { View } from '../telegram/types';
import { fa, heading, hint, quote, sections } from './common';

export interface Lesson {
  icon: string;
  title: string;
  /** Steps, one per line. Kept short: with a screenshot the whole lesson is a photo caption (1,024 characters). */
  steps: string[];
  tip?: string;
  /** A button that takes the seller where the lesson happens. */
  link?: { text: string; url: string };
}

const BOTFATHER = 'https://t.me/BotFather';

export const LESSONS: Lesson[] = [
  {
    icon: '🤖',
    title: 'ساختن ربات در BotFather',
    steps: [
      'در تلگرام <b>@BotFather</b> را باز کنید و <b>Start</b> را بزنید.',
      'دستور <code>/newbot</code> را بفرستید.',
      '<b>اسم</b> ربات را بفرستید؛ مشتری‌ها همین را می‌بینند. مثلاً: <i>کتاب‌فروشی سارا</i>',
      '<b>یوزرنیم</b> را بفرستید؛ انگلیسی و آخرش <code>bot</code>. مثلاً: <code>sara_books_bot</code>',
      'BotFather یک <b>توکن</b> می‌دهد؛ مثل <code>123456789:AAH…</code>. روی آن بزنید تا کپی شود.',
    ],
    tip: 'توکن مثل رمز ربات است؛ آن را فقط به همین ربات پلتفرم بدهید.',
    link: { text: '🤖 باز کردن BotFather', url: BOTFATHER },
  },
  {
    icon: '➕',
    title: 'ساختن فروشگاه',
    steps: [
      'به همین ربات برگردید و «<b>➕ ساخت فروشگاه جدید</b>» را بزنید.',
      'توکنی را که کپی کردید <b>بفرستید</b>. پیامتان برای امنیت فوراً پاک می‌شود.',
      'پیام «<b>🎉 فروشگاه شما ساخته شد</b>» می‌آید. دوره‌ی آزمایشی رایگان از همین لحظه شروع می‌شود.',
    ],
    tip: 'اگر خطای «توکن را قبول نکرد» آمد، توکن را کامل و بدون فاصله کپی کنید.',
  },
  {
    icon: '🔐',
    title: 'ورود به پنل مدیریت',
    steps: [
      'روی دکمه‌ی «<b>🤖 رفتن به ربات</b>» بزنید، یا ربات خودتان را در تلگرام جستجو کنید.',
      '<b>/start</b> را بزنید. چون صاحب فروشگاه هستید، به‌جای منوی مشتری <b>🔐 پنل مدیریت</b> را می‌بینید.',
      'هر وقت خواستید مثل مشتری فروشگاه را ببینید، «<b>👀 نمایش منوی کاربر</b>» را بزنید.',
    ],
    tip: 'از منوی پایین صفحه، «پنل ادمین 🏠» شما را به پنل برمی‌گرداند.',
  },
  {
    icon: '⚙️',
    title: 'تنظیمات اولیه',
    steps: [
      'در پنل، «<b>⚙️ تنظیمات</b>» را بزنید.',
      '<b>🏪 نام فروشگاه</b> و <b>👋 متن خوش‌آمد</b> را بنویسید.',
      '<b>💳 اطلاعات کارت</b>: شماره کارت و نام صاحب کارت؛ مشتری به این کارت واریز می‌کند.',
      '<b>🗣 پشتیبانی</b>: آیدی یا شماره‌ای که مشتری با آن با شما تماس بگیرد.',
      '<b>🧾 اطلاعات ثبت سفارش</b>: انتخاب کنید مشتری نام، آدرس و موبایل بدهد یا نه (مثلاً برای فایل و دوره، آدرس لازم نیست).',
    ],
  },
  {
    icon: '📦',
    title: 'دسته‌بندی و محصول',
    steps: [
      'اول «<b>➕ دسته‌بندی جدید</b>»: اسم دسته و یک ایموجی، مثلاً «کتاب زبان 📚».',
      'بعد «<b>➕ محصول جدید</b>» و مرحله‌به‌مرحله: نام، توضیح، قیمت (تومان)، سازنده، موجودی و <b>عکس</b>.',
      'در آخر دسته‌بندی را انتخاب کنید؛ اگر هنوز نساخته‌اید، همان‌جا اسمش را بفرستید تا ساخته شود. محصول فوراً برای مشتری‌ها نمایش داده می‌شود.',
      'برای ویرایش قیمت، موجودی یا عکس: «<b>✏️ محصولات</b>».',
    ],
    tip: 'محصولی که موجودی‌اش صفر شود، «ناموجود» نشان داده می‌شود و خریدنی نیست.',
  },
  {
    icon: '🧾',
    title: 'دریافت و رسیدگی به سفارش',
    steps: [
      'مشتری سبد خرید را تکمیل می‌کند، کارت‌به‌کارت واریز می‌کند و <b>عکس رسید</b> را می‌فرستد.',
      'همان لحظه پیام «<b>🔔 سفارش جدید</b>» با عکس رسید برای شما می‌آید.',
      'واریز را در حساب بانکی ببینید، بعد «<b>✅ تایید سفارش</b>» یا «<b>❌ رد</b>» را بزنید.',
      'بعد از ارسال کالا «<b>📤 ارسال شد</b>» را بزنید. مشتری در هر مرحله خبردار می‌شود.',
      'با «<b>✉️ پیام به خریدار</b>» مستقیم از داخل ربات با مشتری حرف بزنید.',
    ],
    tip: 'همه‌ی سفارش‌ها در «🧾 سفارشات» و همه‌ی خریدارها در «👥 مشتریان» هستند.',
  },
  {
    icon: '🎨',
    title: 'عکس و معرفی ربات',
    steps: [
      'در @BotFather دستور <code>/mybots</code> را بفرستید و ربات فروشگاه را انتخاب کنید.',
      '<b>Edit Bot → Edit Botpic</b>: لوگوی فروشگاه (مربعی).',
      '<b>Edit About</b>: یک جمله‌ی کوتاه که زیر اسم ربات دیده می‌شود.',
      '<b>Edit Description</b>: معرفی کامل‌تر، قبل از اینکه مشتری Start بزند.',
    ],
    link: { text: '🎨 باز کردن BotFather', url: BOTFATHER },
  },
  {
    icon: '📣',
    title: 'معرفی فروشگاه به مشتری‌ها',
    steps: [
      'لینک فروشگاه شما این است: <code>t.me/یوزرنیم_ربات</code>',
      'آن را در بیو اینستاگرام، کانال تلگرام، واتساپ و استوری بگذارید.',
      'مشتری با زدن لینک و <b>Start</b> مستقیم وارد فروشگاه می‌شود؛ ثبت‌نام لازم ندارد.',
    ],
    tip: 'برای کمک به فروش یا پاسخ به مشتری، همکارتان را ادمین کنید (درس بعد).',
  },
  {
    icon: '💳',
    title: 'تمدید اشتراک و ادمین دوم',
    steps: [
      'در همین ربات: «<b>🏪 فروشگاه‌های من</b>» ← فروشگاه ← «<b>💳 تمدید اشتراک</b>».',
      'مدت را انتخاب کنید، واریز کنید و <b>عکس رسید</b> را بفرستید. بعد از تایید، خبر می‌دهیم.',
      '<b>ادمین دوم:</b> در صفحه‌ی فروشگاه یک کد <code>/claim …</code> هست. همکارتان آن را در ربات فروشگاه بفرستد.',
    ],
    tip: 'قبل از تمام شدن اشتراک یادآوری می‌فرستیم. اگر تمدید نشود فروشگاه بسته می‌شود، ولی داده‌ها تا مدتی نگه داشته می‌شوند.',
  },
];

/** callback_data of the tutorial ("p:" = platform bot). */
export const LEARN = {
  index: 'p:learn',
  lesson: (n: number) => `p:learn:${n}`,
  setPhoto: (n: number) => `pa:learnpic:${n}`,
  removePhoto: (n: number) => `pa:learnpicdel:${n}`,
} as const;

/** Settings key holding a lesson's screenshot (file_id) – stored under the platform (shop 0). */
export const lessonPhotoKey = (n: number) => `tutorial_photo_${n}` as const;

export const tutorialIndex = (): View => ({
  text: sections(
    heading('📚', 'آموزش گام‌به‌گام'),
    'از صفر تا اولین فروش، در چند دقیقه. لازم نیست برنامه‌نویسی بلد باشید.',
    hint(`${fa(LESSONS.length)} درس کوتاه؛ از درس ۱ شروع کنید یا مستقیم سراغ هر درس بروید.`),
  ),
  keyboard: inline(
    [button('▶️ شروع از درس ۱', LEARN.lesson(1), 'success')],
    ...LESSONS.map((l, i) => [button(`${fa(i + 1)}. ${l.icon} ${l.title}`, LEARN.lesson(i + 1))]),
    backRow('p:home', '🏠 منوی اصلی'),
  ),
});

/** Lesson `n` (1-based), with its screenshot if the platform owner set one. */
export function lessonView(n: number, photo: string | null, isPlatformAdmin: boolean): View {
  const l = LESSONS[n - 1]!;
  const text = sections(
    `${heading(l.icon, `درس ${fa(n)} از ${fa(LESSONS.length)}: ${l.title}`)}`,
    quote(l.steps.map((s, i) => `${fa(i + 1)}. ${s}`).join('\n')),
    l.tip && hint(`💡 ${l.tip}`),
  );
  return {
    text,
    photo: photo ?? undefined,
    keyboard: inline(
      ...(l.link ? [[urlButton(l.link.text, l.link.url)]] : []),
      [
        ...(n > 1 ? [button('◀️ قبلی', LEARN.lesson(n - 1))] : []),
        button(`${fa(n)} / ${fa(LESSONS.length)}`, LEARN.index),
        ...(n < LESSONS.length ? [button('بعدی ▶️', LEARN.lesson(n + 1), 'primary')] : [button('➕ ساخت فروشگاه', 'p:new', 'success')]),
      ],
      ...(isPlatformAdmin
        ? [[button(photo ? '🖼 عوض کردن عکس درس' : '🖼 گذاشتن عکس برای درس', LEARN.setPhoto(n)), ...(photo ? [button('🗑 حذف عکس', LEARN.removePhoto(n), 'danger')] : [])]]
        : []),
      [button('📚 فهرست درس‌ها', LEARN.index)],
    ),
  };
}
