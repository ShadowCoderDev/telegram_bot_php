# ربات فروشگاه تلگرام روی Cloudflare Workers

این پوشه همان ربات فروشگاه PHP (پوشه‌ی بالایی) است که برای **Cloudflare Workers** با TypeScript
به‌صورت ماژولار، شیءگرا (OOP) و تابعی (functional) دوباره نوشته شده است.

## آیا می‌شود خود کد PHP را روی Worker اجرا کرد؟

Workers به‌صورت بومی فقط JavaScript/TypeScript، Python و WebAssembly را اجرا می‌کنند. سه راه بررسی شد:

| روش | نتیجه |
|---|---|
| **PHP کامپایل‌شده به WebAssembly** (php-wasm) داخل Worker | ❌ عملاً نشدنی. باینری PHP چند مگابایت است و به سقف حجم Worker می‌خورد. PDO-MySQL و cURL در wasm کار نمی‌کنند (سوکت و شبکه‌ی خام ندارد). فایل‌سیستم هم موقتی است و پوشه‌ی `uploads/` بعد از هر درخواست پاک می‌شود. |
| **Cloudflare Containers** (از آوریل ۲۰۲۶ GA شده) | ✅ شدنی. یک ایمیج Docker با PHP ساخته می‌شود و یک Worker درخواست‌ها را به آن می‌فرستد. ولی پلن پولی Workers لازم است، MySQL باید جای دیگری میزبانی شود، و دیسک کانتینر هم موقتی است (رسیدها باید به R2 بروند). مشکلات فعلی کد (توکن داخل کد، متغیرهای global، `exit`) هم سر جایشان می‌مانند. |
| **بازنویسی بومی در TypeScript** (همین پوشه) | ✅ **پیشنهاد اصلی.** روی پلن رایگان اجرا می‌شود، حجم باندل حدود ۲۲KB (gzip) است، دیتابیس **D1** و فایل‌ها در **R2** هستند، استارت سرد ندارد و سرور یا ngrok لازم نیست. |

<details>
<summary>اگر فقط می‌خواهید همین PHP را با Containers بالا بیاورید</summary>

```jsonc
// wrangler.jsonc
{
  "containers": [{ "class_name": "PhpBot", "image": "./Dockerfile", "max_instances": 1 }],
  "durable_objects": { "bindings": [{ "name": "PHP", "class_name": "PhpBot" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["PhpBot"] }]
}
```
```dockerfile
FROM php:8.3-apache
RUN docker-php-ext-install pdo_mysql
COPY . /var/www/html/
```
```ts
import { Container, getContainer } from '@cloudflare/containers';
export class PhpBot extends Container { defaultPort = 80; sleepAfter = '10m'; }
export default { fetch: (req, env) => getContainer(env.PHP).fetch(req) };
```
قبل از این کار توکن و مشخصات دیتابیس را به متغیرهای محیطی (env) منتقل کنید و آدرس `config/db.php` را به یک MySQL بیرونی بدهید.
</details>

## معماری

```
src/
├── index.ts               نقطه‌ی ورود: /webhook و صفحه‌ی وضعیت / (ثبت خودکار وبهوک)
├── setup.ts               ثبت وبهوک و صفحه‌ی وضعیت
├── limits.ts              سقف طول ورودی‌ها
├── bot.ts                 ساخت روترها و dispatch هر update
├── deps.ts                composition root: همه‌ی اشیا اینجا ساخته و تزریق می‌شوند (DI)
├── env.ts                 تایپ bindingها و secretها
├── telegram/
│   ├── TelegramClient.ts  کلاس Bot API روی fetch (جایگزین Telegram.php و cURL)
│   ├── BotContext.ts      اطلاعات update جاری + reply/render (جایگزین globalها)
│   ├── Router.ts          dispatch اعلانی (جایگزین زنجیره‌ی if/strpos/exit)
│   ├── keyboard.ts        سازنده‌های خالص کیبورد
│   └── types.ts
├── db/
│   ├── migrate.ts         Worker جدول‌ها را خودش می‌سازد و به‌روز می‌کند
│   ├── models.ts          تایپ‌های دامنه
│   └── repositories.ts    یک کلاس Repository برای هر جدول، همه با prepared statement
├── services/
│   ├── CartService.ts     قوانین سبد خرید و موجودی
│   ├── OrderService.ts    تایید/رد/ارسال سفارش به‌صورت تراکنشی
│   ├── orderStatus.ts     state machine خالص وضعیت سفارش
│   └── FileStore.ts       R2 (جایگزین پوشه‌ی uploads/)
├── views/                 توابع خالص: داده ← { text, keyboard }
│   ├── callbacks.ts       همه‌ی callback_dataها در یک جا
│   ├── user.ts
│   └── admin.ts
├── handlers/
│   ├── user.ts            مسیرهای کاربر + مراحل checkout + گفتگو با پشتیبانی
│   └── admin.ts           مسیرهای ادمین + فلوهای چندمرحله‌ای
└── utils/                 اعداد فارسی، تاریخ جلالی، فرمت مبلغ، کد رهگیری
```

**لایه‌ها:** `handlers` ← `services` ← `repositories` ← D1. تنها جایی که `env` خوانده می‌شود `deps.ts` است.

- **OOP:** `TelegramClient`، `BotContext`، `Router`، Repositoryها و Serviceها. وابستگی‌ها از سازنده (constructor) تزریق می‌شوند.
- **Functional:** viewها، state machine سفارش، ابزارهای فارسی و کیبورد همه توابع خالص‌اند و بدون دیتابیس و شبکه تست می‌شوند.

نمونه‌ی مسیریابی به جای `if (strpos($callback_data, 'qty_plus_') === 0) {...; exit;}`:

```ts
router
  .callback(/^prod:(\d+)$/, (ctx, [id]) => showProduct(ctx, Number(id), 1))
  .callback(/^qty:(\d+):(-?\d+)$/, (ctx, [id, qty]) => showProduct(ctx, Number(id), Number(qty)))
```

## نگاشت PHP به این پروژه

| PHP | Worker |
|---|---|
| `index.php` + `$is_admin` | `index.ts` + `bot.ts` (اول روتر ادمین، بعد روتر کاربر) |
| `Telegram.php` | `telegram/TelegramClient.ts` |
| `query("SELECT", ...)` و PDO | `db/repositories.ts` روی D1 |
| `user_checkout_state` و `admin_process_state` | یک جدول `sessions` (هر چت یک فلوی فعال) + جدول `dialogs` |
| `renderProductCard`، `renderCart` و ... | `views/user.ts` |
| `sendAdminRootMenu`، `showOrderDetailsToAdmin` و ... | `views/admin.ts` |
| `uploads/` + `CURLFile` | عکس رسید و عکس محصول با `file_id` تلگرام نگه داشته می‌شوند (فایل را خود تلگرام نگه می‌دارد). R2 فقط برای آرشیو رسیدهاست و اختیاری است. |
| `$BASE_PUBLIC_URL` (ngrok) | لازم نیست، از آدرس خود Worker استفاده می‌شود |

## باگ‌هایی از نسخه‌ی PHP که در این نسخه رفع شده‌اند

1. **توکن ربات داخل کد و گیت است** (`index.php`، `base.php`، `gemini.php`، `clude.php`). ⚠️ همین حالا از BotFather توکن را revoke کنید. در این نسخه توکن secret است.
2. وبهوک احراز هویت نداشت و هر کسی می‌توانست update جعلی (مثلاً با chat_id ادمین) بفرستد. حالا هدر `X-Telegram-Bot-Api-Secret-Token` چک می‌شود.
3. پیام‌های خریدار در گفتگو با ادمین هیچ‌وقت به ادمین نمی‌رسید، چون `buyer_reply` فقط در `admin_handler.php` بررسی می‌شد.
4. ادمین کلید `support_text` را ذخیره می‌کرد ولی کاربر `support` را می‌خواند، پس ویرایش متن پشتیبانی بی‌اثر بود.
5. با زنجیره‌ی تایید ← رد ← تایید، موجودی دو بار کم می‌شد و با رد شدن سفارش برنمی‌گشت. حالا state machine و فیلد `stock_taken` این را کنترل می‌کنند و CHECK(`inventory >= 0`) در یک batch تراکنشی جلوی فروش بیش از موجودی را می‌گیرد.
6. لیست سفارشات ادمین ستون `trackId` را SELECT نمی‌کرد و همیشه `#id` نشان می‌داد.
7. متن‌هایی که کاربر وارد می‌کند (آدرس، نام، سوال و ...) escape نمی‌شدند و HTML تلگرام را خراب می‌کردند.
8. کپشن عکس بیشتر از ۱۰۲۴ کاراکتر باعث خطا در ارسال سفارش به ادمین می‌شد.

## امنیت و جلوگیری از سوءاستفاده

| خطر | محافظت |
|---|---|
| وبهوک جعلی | هدر secret تلگرام بررسی می‌شود |
| استفاده از قیمت قدیمی | سبد خرید قیمت ذخیره نمی‌کند؛ قیمت فقط هنگام نمایش مبلغ پرداخت، تا ۶۰ دقیقه قفل می‌شود |
| اضافه کردن کالا بعد از دیدن مبلغ | هر تغییر سبد، `/start` یا `/cancel` فرایند پرداخت را لغو و قفل قیمت را آزاد می‌کند |
| تغییر قیمت بعد از ثبت سفارش | قیمت و نام هر آیتم هنگام پرداخت در سفارش ذخیره می‌شود (snapshot) |
| یک رسید برای چند سفارش | `file_unique_id` عکس رسید یکتاست (UNIQUE index) |
| ارسال رسیدهای جعلی پشت سر هم | حداکثر ۳ سفارش «منتظر تایید» برای هر مشتری |
| دوبار زدن «تایید» یا دو ادمین هم‌زمان | تغییر وضعیت و موجودی در یک تراکنش و فقط از وضعیت مورد انتظار؛ `CHECK(inventory >= 0)` از فروش بیش از موجودی جلوگیری می‌کند |
| دکمه‌ی قدیمی یا callback جعلی | همه‌ی callbackها سمت سرور دوباره بررسی می‌شوند (محصول/دسته‌ی غیرفعال، موجودی، مالکیت آیتم سبد) |
| تکرار update توسط تلگرام | هر `update_id` فقط یک بار پردازش می‌شود |
| اسپم پیام | بیش از ۳۰ پیام در ۱۰ ثانیه از یک چت نادیده گرفته می‌شود (`FLOOD_LIMIT`) |
| متن خیلی طولانی | سقف طول برای همه‌ی ورودی‌ها (`src/limits.ts`)؛ پیام‌های بلند به چند بخش تقسیم می‌شوند |
| گروه‌ها | ربات فقط در چت خصوصی کار می‌کند |
| مشتری مزاحم | ادمین از صفحه‌ی مشتری مسدودش می‌کند |

> ربات نمی‌تواند واقعی بودن واریز را بررسی کند؛ ادمین باید قبل از «تایید» مبلغ را در حساب بانکی ببیند.

## مشتریان (پنل ادمین)

«👥 مشتریان» همه‌ی مشتری‌ها را به ترتیب آخرین فعالیت نشان می‌دهد (با تعداد سفارش و 🟡 برای سفارش منتظر تایید).
جستجو با نام، @یوزرنیم، موبایل، کد رهگیری یا شناسه‌ی تلگرام. صفحه‌ی هر مشتری: اطلاعات تماس، خلاصه‌ی خرید،
لیست سفارش‌ها (صفحه‌بندی‌شده)، ارسال پیام و مسدود/رفع مسدودی.

## دیپلوی

همه‌ی کارها را `scripts/deploy.mjs` انجام می‌دهد و اجرای دوباره‌اش هم بی‌خطر است:
دیتابیس D1 را بر اساس اسم پیدا می‌کند یا اگر نبود می‌سازد (نیازی به کپی کردن database_id نیست)،
migrationها را اجرا می‌کند،
Worker را همراه با secretها دیپلوی می‌کند و در آخر وبهوک تلگرام را تنظیم می‌کند.

> فایل تنظیمات این پروژه `wrangler.jsonc` است. این همان `wrangler.toml` است، فقط با فرمت JSON که Cloudflare برای پروژه‌های جدید پیشنهاد می‌کند.

### پیش‌نیاز (فقط یک بار)

1. در [dash.cloudflare.com](https://dash.cloudflare.com) حساب بسازید (پلن رایگان کافی است).
2. یک بار وارد بخش **Workers & Pages** شوید تا زیردامنه‌ی `workers.dev` شما ساخته شود.
3. در @BotFather توکن ربات را **عوض کنید** (`/revoke`)، چون توکن قبلی در تاریخچه‌ی گیت مانده است.
4. R2 لازم نیست. عکس‌ها را خود تلگرام نگه می‌دارد. اگر آرشیو رسیدها را در R2 هم می‌خواهید، بخش `r2_buckets` را در `wrangler.jsonc` از حالت کامنت خارج کنید. فعال کردن R2 نیاز به ثبت روش پرداخت دارد.

### روش ۱: دیپلوی خودکار با GitHub (پیشنهادی)

بعد از این تنظیمات، هر push روی `master` اول تست‌ها را اجرا می‌کند و بعد ربات را دیپلوی می‌کند.

1. **ساخت API Token در Cloudflare:** بروید به My Profile ← API Tokens ← Create Token، قالب **Edit Cloudflare Workers** را انتخاب کنید،
   با **+ Add more** دسترسی `Account · D1 · Edit` را هم اضافه کنید و توکن را بسازید.
2. **Account ID:** در صفحه‌ی **Workers & Pages** ستون سمت راست (یا بخشی از آدرس داشبورد) است.
3. در GitHub بروید به **Settings ← Secrets and variables ← Actions** و این‌ها را در تب **Secrets** اضافه کنید:

   | نام | مقدار |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | توکن مرحله‌ی ۱ |
   | `CLOUDFLARE_ACCOUNT_ID` | Account ID |
   | `BOT_TOKEN` | توکن جدید ربات |
   | `WEBHOOK_SECRET` | *(اختیاری)* اگر خالی بماند در هر دیپلوی خودکار ساخته می‌شود |

   *(اختیاری)* در تب **Variables** مقدار `ADMIN_CHAT_IDS` را وارد کنید (آیدی عددی ادمین‌ها، جدا شده با کاما).
   اگر این را خالی بگذارید، بعد از دیپلوی در ربات `/claim <WEBHOOK_SECRET>` بفرستید تا ادمین شوید. برای این کار `WEBHOOK_SECRET` را حتماً ثابت تعیین کنید.
4. بروید به تب **Actions ← Cloudflare Worker ← Run workflow**، یا فقط یک commit روی `master` push کنید.
5. در لاگ مرحله‌ی `npm run deploy` آدرس Worker و لینک ربات چاپ می‌شود. در تلگرام `/start` بفرستید.

### روش ۲: با یک دستور از کامپیوتر خودتان

```bash
cd cloudflare-worker
npm install
npm run deploy
```

مرورگر برای ورود به Cloudflare باز می‌شود و بعد توکن ربات پرسیده می‌شود. بقیه‌ی مراحل خودکار است.
برای اجرای بدون سؤال، مقادیر را به‌صورت متغیر محیطی بدهید: `BOT_TOKEN=... ADMIN_CHAT_IDS=123,456 npm run deploy`.
اگر به‌جای `workers.dev` از دامنه‌ی شخصی استفاده می‌کنید، `WORKER_URL=https://bot.example.com` را هم اضافه کنید.

### توسعه‌ی محلی

```bash
cp .dev.vars.example .dev.vars   # مقادیر را پر کنید
npm run db:migrate:local
npm run dev                      # برای اتصال به تلگرام واقعی از cloudflared tunnel استفاده کنید
```

### تست

```bash
npm run typecheck
npm test          # تست‌های واحد (توابع خالص، روتر، state machine)
npm run test:e2e  # Worker واقعی در wrangler dev با D1 محلی و یک Telegram API ساختگی
```

تست e2e کل سناریو را اجرا می‌کند: ادمین دسته و محصول می‌سازد، مشتری خرید و checkout می‌کند
و رسید می‌فرستد، ادمین تایید و رد می‌کند (کم و زیاد شدن موجودی بررسی می‌شود)، گفتگوی دوطرفه و در آخر آمار.

## فروش به چند فروشنده

هر فروشنده یک نسخه‌ی کاملاً جدا دارد: ربات خودش، حساب Cloudflare خودش و دیتابیس خودش. این نسخه‌ها هیچ داده‌ی مشترکی ندارند.
تمام تنظیمات فروشگاه داخل ربات قابل تغییر است (**⚙️ تنظیمات**: نام فروشگاه، متن خوش‌آمد، پیشوند کد رهگیری، کارت، پشتیبانی، راهنما)،
پس برای هر فروشنده کد را کپی یا دستکاری نمی‌کنید.

### راه A: شما برای همه دیپلوی می‌کنید؛ کد خصوصی می‌ماند (پیشنهادی برای فروش)

یک ریپوی **خصوصی** و به ازای هر فروشنده یک **Environment** در GitHub. با هر push، همه‌ی فروشنده‌ها هم‌زمان به‌روز می‌شوند.

1. فروشنده حساب Cloudflare می‌سازد و یک API Token (قالب *Edit Cloudflare Workers* به‌علاوه‌ی `D1 · Edit`) به شما می‌دهد، به‌همراه Account ID و توکن ربات خودش.
2. در GitHub بروید به **Settings ← Environments ← New environment** و یک اسم بدهید، مثلاً `ali-shop`. در همان Environment این secretها را بگذارید:
   `CLOUDFLARE_API_TOKEN`، `CLOUDFLARE_ACCOUNT_ID`، `BOT_TOKEN`، `WEBHOOK_SECRET` (حداقل ۱۶ کاراکتر)
   و اگر آیدی عددی فروشنده را دارید، Variable به نام `ADMIN_CHAT_IDS`.
3. در **Settings ← Secrets and variables ← Actions ← Variables** متغیر `SELLERS` را بسازید و اسم همه‌ی Environmentها را در آن بنویسید:
   ```json
   ["ali-shop", "sara-books"]
   ```
4. **Actions ← Cloudflare Worker ← Run workflow**. برای هر فروشنده یک job جدا اجرا می‌شود. اگر یکی خطا بدهد، بقیه ادامه می‌دهند.
5. فروشنده در ربات خودش `/claim <WEBHOOK_SECRET>` می‌فرستد و ادمین می‌شود.

> اگر چند فروشنده را روی **یک** حساب Cloudflare می‌گذارید، برای هر کدام Variable به نام `WORKER_NAME` با اسم متفاوت تعیین کنید. هر کدام Worker و دیتابیس جدای خودش را می‌گیرد.

### راه B: فروشنده خودش با یک کلیک نصب می‌کند (دکمه‌ی Deploy to Cloudflare)

این دکمه ریپو را در GitHub فروشنده کپی می‌کند، دیتابیس D1 را می‌سازد، `BOT_TOKEN` و `WEBHOOK_SECRET` را از او می‌پرسد و دیپلوی می‌کند.
برای این راه، ریپو (یا حداقل پوشه‌ی `cloudflare-worker`) باید **public** باشد؛ یعنی کد برای همه قابل دیدن است.

```markdown
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/OWNER/REPO/tree/master/cloudflare-worker)
```

بعد از نصب، فروشنده فقط **یک بار آدرس Worker را در مرورگر باز می‌کند**. همین کار وبهوک را ثبت می‌کند و صفحه‌ی وضعیت می‌گوید چطور با `/claim` ادمین شود.
جدول‌های دیتابیس را خود Worker در اولین درخواست می‌سازد.
به‌روزرسانی‌های شما به‌صورت خودکار به ریپوهای فروشنده‌ها نمی‌رسد؛ خودشان باید از ریپوی شما sync کنند.

### راه C: یک سرویس برای همه (SaaS، multi-tenant)

یک Worker و یک دیتابیس برای همه‌ی فروشنده‌ها؛ فروشنده فقط توکن رباتش را می‌دهد و شما ماهانه اشتراک می‌گیرید.
این راه نیاز به تغییر ساختار دارد: ستون `shop_id` در همه‌ی جدول‌ها، مسیر `/webhook/<shop>` و ذخیره‌ی توکن هر فروشنده.
وقتی تعداد فروشنده‌ها زیاد شد ارزش دارد؛ برای شروع، راه A ساده‌تر و امن‌تر است.

## انتقال داده از MySQL

ساختار جدول‌ها در `migrations/0001_init.sql` است. نام چند جدول و ستون عوض شده است
(`orders_item` ← `order_items`، `trackId` ← `track_id`، `receipt_image_url` ← `receipt_file_id`).
داده‌ها را با `mysqldump --no-create-info --compatible=ansi` خروجی بگیرید، این نام‌ها را اصلاح کنید و با
`npx wrangler d1 execute shop --remote --file dump.sql -c wrangler.deploy.json` وارد کنید. فایل `wrangler.deploy.json` بعد از اولین `npm run deploy` ساخته می‌شود و شناسه‌ی واقعی دیتابیس را دارد. برای رسیدهای قدیمی که `file_id` ندارند
می‌توانید فایل را در R2 آپلود کنید و کلید آن را در `receipt_r2_key` بگذارید.
