import { createBot } from './bot';
import { createDeps } from './deps';
import type { Env } from './env';
import type { Update } from './telegram/types';

/**
 * Routes:
 *   POST /webhook           Telegram updates (authenticated by the secret-token header)
 *   GET  /files/<key>       public product images from R2
 *   POST /setup-webhook     registers <origin>/webhook with Telegram (send the secret as Bearer token)
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const deps = createDeps(env, url.origin);

    if (request.method === 'POST' && url.pathname === '/webhook') {
      if (request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) {
        return new Response('Forbidden', { status: 403 });
      }
      const update = (await request.json()) as Update;
      try {
        await createBot(deps)(update);
      } catch (err) {
        // Always ACK: a non-2xx makes Telegram redeliver the same update in a loop.
        console.error('update failed', update.update_id, err);
      }
      return new Response('ok');
    }

    if (request.method === 'GET' && url.pathname.startsWith('/files/')) {
      return deps.files.serve(decodeURIComponent(url.pathname.slice('/files/'.length)));
    }

    if (request.method === 'POST' && url.pathname === '/setup-webhook') {
      if (request.headers.get('authorization') !== `Bearer ${env.WEBHOOK_SECRET}`) {
        return new Response('Forbidden', { status: 403 });
      }
      const result = await deps.tg.setWebhook(`${url.origin}/webhook`, env.WEBHOOK_SECRET);
      return Response.json({ ok: true, result, webhook: `${url.origin}/webhook` });
    }

    return new Response('Telegram shop bot is running.', { status: url.pathname === '/' ? 200 : 404 });
  },
} satisfies ExportedHandler<Env>;
