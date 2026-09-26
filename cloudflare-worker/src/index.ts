import { createBot } from './bot';
import { ensureSchema } from './db/migrate';
import { createDeps } from './deps';
import type { Env } from './env';
import { ensureWebhook, statusPage } from './setup';
import type { Update } from './telegram/types';

/**
 * Routes:
 *   POST /webhook       Telegram updates (authenticated by the secret-token header)
 *   GET  /              status page; also registers the Telegram webhook (first-time setup)
 *   GET  /files/<key>   public product images from R2 (only when R2 is configured)
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const deps = createDeps(env, url.origin);

    if (request.method === 'POST' && url.pathname === '/webhook') {
      const secret = request.headers.get('x-telegram-bot-api-secret-token');
      if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) return new Response('Forbidden', { status: 403 });
      const update = (await request.json()) as Update;
      try {
        await ensureSchema(env.DB);
        await createBot(deps)(update);
      } catch (err) {
        // Always ACK: a non-2xx makes Telegram redeliver the same update in a loop.
        console.error('update failed', update.update_id, err);
      }
      return new Response('ok');
    }

    if (request.method === 'GET' && url.pathname === '/') {
      await ensureSchema(env.DB);
      return statusPage(await ensureWebhook(deps, url.origin));
    }

    if (request.method === 'GET' && url.pathname.startsWith('/files/') && deps.files) {
      return deps.files.serve(decodeURIComponent(url.pathname.slice('/files/'.length)));
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
