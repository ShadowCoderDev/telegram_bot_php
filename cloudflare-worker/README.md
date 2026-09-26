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
├── index.ts               نقطه‌ی ورود: /webhook ، /files/* ، /setup-webhook
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
| `uploads/` + `CURLFile` | رسید با `file_id` تلگرام ارسال می‌شود و نسخه‌ی آرشیوی آن در R2 است. عکس محصول در R2 قرار می‌گیرد و از `/files/...` سرو می‌شود. |
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

## راه‌اندازی

```bash
cd cloudflare-worker
npm install

# ۱) ساخت منابع
npx wrangler d1 create shop            # database_id را در wrangler.jsonc بگذارید
npx wrangler r2 bucket create shop-files

# ۲) ساخت جدول‌ها
npm run db:migrate:remote

# ۳) secretها
npx wrangler secret put BOT_TOKEN       # توکن جدید از BotFather
npx wrangler secret put WEBHOOK_SECRET  # یک رشته‌ی تصادفی طولانی
#    ADMIN_CHAT_IDS را در wrangler.jsonc تنظیم کنید (با کاما جدا می‌شوند)

# ۴) دیپلوی و ثبت وبهوک
npm run deploy
curl -X POST https://telegram-shop-bot.<subdomain>.workers.dev/setup-webhook \
     -H "Authorization: Bearer <WEBHOOK_SECRET>"
```

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
npm run test:e2e  # Worker واقعی در wrangler dev با D1/R2 محلی و یک Telegram API ساختگی
```

تست e2e کل سناریو را اجرا می‌کند: ادمین دسته و محصول می‌سازد، مشتری خرید و checkout می‌کند
و رسید می‌فرستد، ادمین تایید و رد می‌کند (کم و زیاد شدن موجودی بررسی می‌شود)، گفتگوی دوطرفه و در آخر آمار.

## انتقال داده از MySQL

ساختار جدول‌ها در `migrations/0001_init.sql` است. نام چند جدول و ستون عوض شده است
(`orders_item` ← `order_items`، `trackId` ← `track_id`، `receipt_image_url` ← `receipt_file_id`).
داده‌ها را با `mysqldump --no-create-info --compatible=ansi` خروجی بگیرید، این نام‌ها را اصلاح کنید و با
`wrangler d1 execute shop --remote --file dump.sql` وارد کنید. برای رسیدهای قدیمی که `file_id` ندارند
می‌توانید فایل را در R2 آپلود کنید و کلید آن را در `receipt_r2_key` بگذارید.
