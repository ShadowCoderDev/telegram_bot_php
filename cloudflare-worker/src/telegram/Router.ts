import type { BotContext } from './BotContext';

/** Return `false` to decline, letting dispatch continue as if the route hadn't matched. */
export type Handler = (ctx: BotContext, params: string[]) => Promise<void | boolean>;
type Matcher = (value: string) => string[] | null;

const toMatcher = (pattern: string | RegExp): Matcher =>
  typeof pattern === 'string'
    ? (value) => (value === pattern ? [] : null)
    : (value) => {
        const m = pattern.exec(value);
        return m ? m.slice(1) : null;
      };

interface Route {
  match: Matcher;
  handler: Handler;
}

/**
 * Declarative dispatch replacing the long `if (strpos($callback_data, ...) === 0) { ... exit; }` chains.
 *
 *   router.callback(/^product:(\d+)$/, (ctx, [id]) => ...)
 *   router.text('/start', ...)
 *   router.fallback(...)  – anything unmatched (e.g. input for a multi-step flow)
 *
 * dispatch() resolves to false when nothing handled the update, so routers can be chained.
 *
 * The first matching route wins, so order registrations from specific to general.
 */
export class Router {
  private readonly callbacks: Route[] = [];
  private readonly texts: Route[] = [];
  private fallbackHandler: Handler | undefined;

  callback(pattern: string | RegExp, handler: Handler): this {
    this.callbacks.push({ match: toMatcher(pattern), handler });
    return this;
  }

  text(pattern: string | RegExp | string[], handler: Handler): this {
    const patterns = Array.isArray(pattern) ? pattern : [pattern];
    for (const p of patterns) this.texts.push({ match: toMatcher(p), handler });
    return this;
  }

  fallback(handler: Handler): this {
    this.fallbackHandler = handler;
    return this;
  }

  /** Returns true when some handler ran. */
  async dispatch(ctx: BotContext): Promise<boolean> {
    const [routes, value] = ctx.isCallback ? [this.callbacks, ctx.callbackData] : [this.texts, ctx.text];
    if (value !== undefined) {
      for (const route of routes) {
        const params = route.match(value);
        if (params && (await route.handler(ctx, params)) !== false) return true;
      }
    }
    return this.fallbackHandler !== undefined && (await this.fallbackHandler(ctx, [])) !== false;
  }
}
