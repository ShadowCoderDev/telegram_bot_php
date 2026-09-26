import type { Deps } from './deps';
import { escapeHtml as e } from './utils/format';

/** Changes whenever the Worker URL or the secret changes, so the webhook is re-registered then. */
async function marker(url: string, secret: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${url}#${secret}`)));
  return Array.from(hash.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

interface Status {
  ok: boolean;
  bot?: string;
  error?: string;
  admins: number;
}

/**
 * Makes sure Telegram sends updates to this Worker. Runs when someone opens the Worker's URL, so a
 * seller who deployed with the "Deploy to Cloudflare" button only has to visit it once.
 */
export async function ensureWebhook(d: Deps, origin: string): Promise<Status> {
  const admins = new Set([...d.envAdminIds, ...(await d.settings.claimedAdmins())]).size;
  if (!d.tg.hasToken) return { ok: false, error: 'BOT_TOKEN تنظیم نشده است.', admins };
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(d.webhookSecret)) {
    return { ok: false, error: 'WEBHOOK_SECRET باید حداقل ۱۶ کاراکتر و فقط شامل A-Z a-z 0-9 _ - باشد.', admins };
  }
  try {
    const me = await d.tg.call<{ username?: string }>('getMe');
    const url = `${origin}/webhook`;
    const current = await marker(url, d.webhookSecret);
    if ((await d.settings.raw('webhook_marker')) !== current) {
      await d.tg.setWebhook(url, d.webhookSecret);
      await d.settings.set('webhook_marker', current);
    }
    return { ok: true, bot: me.username, admins };
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err), admins };
  }
}

export function statusPage(s: Status): Response {
  const body = s.ok
    ? `<h1>✅ ربات فعال است</h1>
       ${s.bot ? `<p>ربات شما: <a href="https://t.me/${e(s.bot)}">@${e(s.bot)}</a></p>` : ''}
       ${
         s.admins
           ? `<p>تعداد ادمین‌ها: ${s.admins}</p>`
           : `<p><b>قدم آخر:</b> در ربات این پیام را بفرستید تا ادمین شوید:</p><pre>/claim WEBHOOK_SECRET</pre>
              <p class="hint">به‌جای WEBHOOK_SECRET همان رمزی را بنویسید که هنگام دیپلوی وارد کردید.</p>`
       }`
    : `<h1>⚠️ ربات هنوز آماده نیست</h1><p>${e(s.error)}</p>
       <p class="hint">مقادیر را در Cloudflare ← Workers ← این Worker ← Settings ← Variables and Secrets اصلاح کنید و دوباره همین صفحه را باز کنید.</p>`;
  return new Response(
    `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>وضعیت ربات</title><style>
body{font-family:system-ui,Tahoma,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;line-height:1.9;color:#1f2328;background:#fff}
pre{background:#f3f4f6;padding:12px;border-radius:8px;direction:ltr;text-align:left}.hint{color:#6b7280;font-size:.9em}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}pre{background:#161b22}.hint{color:#8b949e}a{color:#58a6ff}}
</style></head><body>${body}</body></html>`,
    { status: s.ok ? 200 : 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}
