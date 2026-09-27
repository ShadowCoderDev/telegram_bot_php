import type { Deps } from '../deps';
import type { Session } from '../db/models';
import { SETTING_DEFAULTS } from '../db/repositories';
import { clampQty, stockProblems } from '../services/CartService';
import { CHECKOUT_FIELDS, type CheckoutField } from '../services/checkoutFields';
import type { BotContext } from '../telegram/BotContext';
import type { Router } from '../telegram/Router';
import type { View } from '../telegram/types';
import { sameSecret } from '../crypto';
import { LIMITS, MAX_AWAITING_REVIEW, charCount, planLimits } from '../limits';
import { escapeHtml } from '../utils/format';
import { isIranMobile, toEnglishDigits } from '../utils/persian';
import * as admin from '../views/admin';
import { CB } from '../views/callbacks';
import { heading, hint, quote, sections } from '../views/common';
import * as v from '../views/user';

export const CHECKOUT = 'checkout';
const MIN_CLAIM_SECRET = 16;

/** How long the amount shown at the payment step stays valid before prices are re-read. */
export const PRICE_LOCK_MINUTES = 60;

const now = () => Math.floor(Date.now() / 1000);

export function registerUserRoutes(router: Router, d: Deps): Router {
  const showHome = async (ctx: BotContext) => {
    await d.user(ctx);
    await ctx.render(v.mainMenu(ctx.firstName, await shop()));
  };
  /** Shop name and welcome text. A shop that never set its name shows its bot's name, not a placeholder. */
  const shop = async () => {
    const info = await d.settings.getMany(['shop_name', 'welcome_text']);
    if (info.shop_name === SETTING_DEFAULTS.shop_name && (await d.settings.raw('shop_name')) === null) {
      const me = await d.tg.call<{ first_name?: string }>('getMe').catch(() => null);
      const name = me?.first_name?.trim();
      if (name) {
        await d.settings.set('shop_name', name); // once: from now on it is a normal setting the admin can change
        info.shop_name = name;
      }
    }
    return info;
  };
  const showShop = async (ctx: BotContext) => ctx.render(v.categoriesView(await d.categories.list(true)));
  const showCart = async (ctx: BotContext) => {
    const cart = await d.cart.contents(await d.user(ctx));
    await ctx.render(cart ? v.cartView(cart.lines) : v.emptyCart());
  };
  const showOrders = async (ctx: BotContext) => {
    const user = await d.user(ctx);
    const orders = await d.orders.recentForUser(user.id);
    await ctx.render(v.myOrdersView(orders, await d.orders.linesFor(orders.map((o) => o.id))));
  };
  const showFaqs = async (ctx: BotContext) => ctx.render(v.faqsView(await d.faqs.list(true)));
  const showSupport = async (ctx: BotContext) => ctx.render(v.supportView(await d.settings.get('support')));
  const showHelp = async (ctx: BotContext) => ctx.render(v.helpView(await d.settings.get('help_text')));
  const showProduct = async (ctx: BotContext, id: number, qty: number) => {
    const product = await d.products.findVisible(id);
    await ctx.render(product ? v.productCard(product, clampQty(qty, product.inventory)) : v.productNotFound());
  };
  const removeItem = async (ctx: BotContext, itemId: number) => {
    const aborted = await abortCheckout(ctx.chatId, d);
    const removed = await d.cart.removeItem(await d.user(ctx), itemId);
    if (!removed) await ctx.reply({ text: '⚠️ این آیتم در سبد خرید شما نیست.' });
    if (aborted) await ctx.reply(v.checkoutPrompts.cancelledByCartChange());
    await showCart(ctx);
  };

  return (
    router
      /* ----- text commands & persistent keyboard ----- */
      .text(['/start', v.MENU.home], async (ctx) => {
        await abortCheckout(ctx.chatId, d);
        await showHome(ctx);
        await ctx.reply(v.persistentKeyboard());
      })
      .text('/cancel', async (ctx) => {
        await abortCheckout(ctx.chatId, d);
        await d.sessions.clear(ctx.chatId);
        await ctx.reply({ text: '✅ عملیات لغو شد.' });
        await showHome(ctx);
      })
      .text(/^\/claim(?:\s+(\S+))?$/, async (ctx, [secret]) => {
        // Someone the shop owner trusts becomes an extra admin with the shop's claim code
        // (shown to the seller in the platform bot; WEBHOOK_SECRET for the owner's own shop).
        if (d.claimCode.length < MIN_CLAIM_SECRET) {
          return ctx.reply({ text: `⚠️ کد /claim باید حداقل ${MIN_CLAIM_SECRET} کاراکتر باشد تا فعال شود.` });
        }
        if (!secret || !(await sameSecret(secret, d.claimCode))) return ctx.reply({ text: '❌ کد اشتباه است.' });
        const limits = planLimits(d.shop.plan);
        if ((await d.settings.claimedAdmins()).length >= limits.extraAdmins) {
          return ctx.reply({ text: `⚠️ این فروشگاه حداکثر ${limits.extraAdmins} ادمین اضافه می‌تواند داشته باشد.` });
        }
        await d.settings.addAdmin(ctx.chatId);
        await ctx.reply({ text: '✅ شما ادمین این ربات شدید. برای ورود به پنل /start را بزنید.' });
      })
      .text(v.MENU.shop, showShop)
      .text(v.MENU.cart, showCart)
      .text(v.MENU.orders, showOrders)
      .text(v.MENU.support, showSupport)
      .text(v.MENU.faqs, showFaqs)
      .text(/^\/delete_item_(\d+)$/, (ctx, [id]) => removeItem(ctx, Number(id)))

      /* ----- inline navigation ----- */
      .callback(CB.noop, async () => {})
      .callback(CB.home, showHome)
      .callback(CB.shop, showShop)
      .callback(CB.cart, showCart)
      .callback(CB.myOrders, showOrders)
      .callback(CB.faqs, showFaqs)
      .callback(CB.support, showSupport)
      .callback(CB.help, showHelp)
      .callback(/^faq:(\d+)$/, async (ctx, [id]) => {
        const faq = await d.faqs.find(Number(id));
        if (faq?.status === 'enable') await ctx.render(v.faqAnswerView(faq));
      })
      .callback(/^cat:(\d+)$/, async (ctx, [id]) => {
        const [category, products] = await Promise.all([d.categories.find(Number(id)), d.products.listByCategory(Number(id))]);
        // A disabled category is hidden even when reached through an old button.
        await ctx.render(category?.status === 'enable' ? v.categoryProductsView(category, products) : v.categoriesView(await d.categories.list(true)));
      })
      .callback(/^prod:(\d+)$/, (ctx, [id]) => showProduct(ctx, Number(id), 1))
      .callback(/^qty:(\d+):(-?\d+)$/, (ctx, [id, qty]) => showProduct(ctx, Number(id), Number(qty)))

      /* ----- cart (every change cancels a checkout in progress, so a shown amount can't go stale) ----- */
      .callback(/^add:(\d+):(\d+)$/, async (ctx, [id, rawQty]) => {
        const qty = clampQty(Number(rawQty));
        const result = await d.cart.add(await d.user(ctx), Number(id), qty);
        if (!result.ok) {
          return ctx.render(result.reason === 'not_found' ? v.productNotFound() : v.notEnoughStock(result.product, result.inCart, qty));
        }
        const aborted = await abortCheckout(ctx.chatId, d);
        const product = await d.products.find(Number(id));
        await ctx.render(v.addedToCart(product?.title ?? '', qty));
        if (aborted) await ctx.reply(v.checkoutPrompts.cancelledByCartChange());
      })
      .callback(/^cart:del:(\d+)$/, (ctx, [id]) => removeItem(ctx, Number(id)))
      .callback(CB.clearCart, async (ctx) => {
        await abortCheckout(ctx.chatId, d);
        await d.cart.clear(await d.user(ctx));
        await ctx.render({ text: sections(heading('🗑', 'سبد خرید خالی شد'), hint('هر وقت خواستید دوباره خرید کنید.')) });
        await ctx.reply(v.mainMenu(ctx.firstName, await shop()));
      })
      .callback(CB.checkout, async (ctx) => {
        const user = await d.user(ctx);
        await abortCheckout(ctx.chatId, d); // restarting checkout never keeps an old lock
        const cart = await d.cart.contents(user);
        if (!cart) return ctx.render(v.emptyCart());
        if ((await d.orders.countAwaitingReview(user.id)) >= MAX_AWAITING_REVIEW) {
          return ctx.render(v.checkoutPrompts.tooManyAwaiting(MAX_AWAITING_REVIEW));
        }
        const problems = stockProblems(cart.lines);
        if (problems.length) return ctx.render(v.stockProblemsView(problems));
        const fields = await d.checkoutFields();
        const data: v.CheckoutData = { orderId: cart.order.id, fields };
        if (!fields.length) return showPayment(ctx, d, data); // the shop asks for nothing: straight to paying
        await d.sessions.set(ctx.chatId, CHECKOUT, fields[0]!, data);
        await ctx.render(askFor(ctx, fields[0]!, data));
      })
      // "✅ use my Telegram name" at the name step.
      .callback(CB.useTelegramName, async (ctx) => {
        const s = await d.sessions.get<v.CheckoutData>(ctx.chatId);
        if (s?.flow === CHECKOUT && s.step === 'name') return checkoutStep(ctx, s, d, ctx.firstName);
        await ctx.reply(v.mainMenu(ctx.firstName, await shop()));
      })

      /* ----- free input: checkout steps, buyer replies to admin ----- */
      .fallback(async (ctx) => {
        if (ctx.isCallback) {
          // A button from an old message (or the previous PHP bot) – just show the menu.
          return ctx.reply(v.mainMenu(ctx.firstName, await shop()));
        }
        const session = await d.sessions.get<v.CheckoutData>(ctx.chatId);
        if (session?.flow === CHECKOUT) return checkoutStep(ctx, session, d);

        const dialog = await d.dialogs.findByBuyer(ctx.chatId);
        if (dialog) return forwardBuyerReply(ctx, d, dialog.admin_chat_id, dialog.order_id);

        await ctx.reply(v.unknownCommand());
      })
  );
}

/**
 * Ends a checkout in progress and releases its price lock, so the cart goes back to live prices.
 * Returns true when there was one.
 */
async function abortCheckout(chatId: number, d: Deps): Promise<boolean> {
  const s = await d.sessions.get<v.CheckoutData>(chatId);
  if (s?.flow !== CHECKOUT) return false;
  await d.orders.unlockPrices(s.data.orderId);
  await d.sessions.clear(chatId);
  return true;
}

const fieldsOf = (data: v.CheckoutData): CheckoutField[] => data.fields ?? [...CHECKOUT_FIELDS];

/** The question for one checkout field, numbered among this checkout's steps (fields, then payment). */
function askFor(ctx: BotContext, field: CheckoutField, data: v.CheckoutData): View {
  const fields = fieldsOf(data);
  const n = fields.indexOf(field) + 1;
  const total = fields.length + 1;
  if (field === 'name') return v.checkoutPrompts.name(n, total, ctx.firstName);
  return field === 'address' ? v.checkoutPrompts.address(n, total) : v.checkoutPrompts.phone(n, total);
}

/** Stores the answer to `done` and asks the next enabled field, or shows the payment step. */
async function nextStep(ctx: BotContext, d: Deps, data: v.CheckoutData, done: CheckoutField): Promise<void> {
  const fields = fieldsOf(data);
  const next = fields[fields.indexOf(done) + 1];
  if (!next) return showPayment(ctx, d, data);
  await d.sessions.set(ctx.chatId, CHECKOUT, next, data);
  await ctx.reply(askFor(ctx, next, data));
}

/** Locks current prices into the cart and shows the amount to pay (the last checkout step). */
async function showPayment(ctx: BotContext, d: Deps, data: v.CheckoutData): Promise<void> {
  // Stock may have run out while the customer was typing their details.
  const problems = stockProblems(await d.orders.lines(data.orderId));
  if (problems.length) {
    await abortCheckout(ctx.chatId, d);
    return ctx.reply(v.stockProblemsView(problems));
  }
  await d.orders.lockPrices(data.orderId);
  const { total } = await d.orders.lockedTotal(data.orderId);
  await d.sessions.set(ctx.chatId, CHECKOUT, 'receipt', { ...data, total, lockedAt: now() });
  const bank = await d.settings.get('bank_info');
  const steps = fieldsOf(data).length + 1;
  await ctx.reply(v.checkoutPrompts.payment(steps, steps, bank, total, PRICE_LOCK_MINUTES));
}

/**
 * A receipt is only accepted for exactly the amount that was shown: the cart must be fully locked,
 * unchanged and the lock not expired. Anything else re-locks at current prices and asks again.
 */
async function lockStillValid(d: Deps, data: v.CheckoutData): Promise<boolean> {
  const order = await d.orders.find(data.orderId);
  if (order?.status !== 'pending') return false;
  const lock = await d.orders.lockedTotal(data.orderId);
  const fresh = data.lockedAt !== undefined && now() - data.lockedAt <= PRICE_LOCK_MINUTES * 60;
  return fresh && lock.lines > 0 && lock.unlocked === 0 && lock.total === data.total;
}

/** One function per checkout step; each validates input, stores it and asks for the next value. */
async function checkoutStep(ctx: BotContext, s: Session<v.CheckoutData>, d: Deps, input = ctx.text): Promise<void> {
  const text = input?.trim();

  switch (s.step) {
    case 'name': {
      // Any name will do – just "علی" too; nobody should be sent back for a missing surname.
      if (!text || text.startsWith('/') || charCount(text) < 2) return ctx.reply(v.checkoutPrompts.badName());
      if (charCount(text) > LIMITS.name) return ctx.reply(v.checkoutPrompts.tooLong(LIMITS.name));
      return nextStep(ctx, d, { ...s.data, firstName: text, lastName: '' }, 'name');
    }
    case 'address': {
      if (!text || text.startsWith('/') || charCount(text) < LIMITS.addressMin) return ctx.reply(askFor(ctx, 'address', s.data));
      if (charCount(text) > LIMITS.address) return ctx.reply(v.checkoutPrompts.tooLong(LIMITS.address));
      return nextStep(ctx, d, { ...s.data, address: text }, 'address');
    }
    case 'phone': {
      const phone = toEnglishDigits(text ?? '').replace(/[\s-]/g, '');
      if (!isIranMobile(phone)) return ctx.reply(v.checkoutPrompts.badPhone());
      return nextStep(ctx, d, { ...s.data, phone }, 'phone');
    }
    case 'receipt': {
      const image = ctx.image;
      if (!image) return ctx.reply(v.checkoutPrompts.needImage());
      const fileId = image.fileId;

      const order = await d.orders.find(s.data.orderId);
      if (order?.status !== 'pending') {
        await d.sessions.clear(ctx.chatId);
        // e.g. a second photo of an album arriving after the first was accepted
        return ctx.reply(order?.status === 'payed' ? v.checkoutPrompts.alreadyReceived() : v.emptyCart());
      }
      // One receipt can back only one order (checked again atomically by a UNIQUE index below).
      if ((await d.orders.orderUsingReceipt(image.uniqueId)) !== null) return ctx.reply(v.checkoutPrompts.receiptReused());
      if (!(await lockStillValid(d, s.data))) {
        await ctx.reply(v.checkoutPrompts.pricesChanged());
        return showPayment(ctx, d, s.data);
      }

      // Archive to R2; the Telegram file_id alone is enough to show the receipt, so this is best-effort.
      const r2Key = d.files
        ? await d.files.saveTelegramFile(fileId, 'receipts').catch((err) => {
            console.error('receipt archive failed', err);
            return null;
          })
        : null;
      const paid = await d.orders.markPaid({
        order_id: s.data.orderId,
        first_name: s.data.firstName ?? '',
        last_name: s.data.lastName ?? '',
        address: s.data.address ?? '',
        phone_number: s.data.phone ?? '',
        receipt_file_id: fileId,
        receipt_r2_key: r2Key,
        receipt_unique_id: image.uniqueId,
      });
      if (paid === 'receipt_reused') return ctx.reply(v.checkoutPrompts.receiptReused());
      if (paid === 'not_pending') return ctx.reply(v.checkoutPrompts.alreadyReceived());
      await d.sessions.clear(ctx.chatId);

      const full = (await d.orderService.load(s.data.orderId))!;
      await ctx.reply(v.receiptAccepted(full.order.track_id, s.data, full.lines));
      const alert = admin.orderView(full, '🔔 <b>سفارش جدید ثبت شد!</b>');
      await Promise.all(d.adminIds.map((id) => ctx.sendTo(id, alert).catch((err) => console.error('notify admin', id, err))));
      return;
    }
  }
}

async function forwardBuyerReply(ctx: BotContext, d: Deps, adminChatId: number, orderId: number): Promise<void> {
  const user = await d.users.findByChatId(ctx.chatId);
  const who = user ? `${escapeHtml(user.name)}${user.username ? ` @${user.username}` : ''}` : String(ctx.chatId);
  const header = `📥 <b>پیام مشتری</b> ${hint(`${who}${orderId ? ` · سفارش #${orderId}` : ''}`)}\n\n`;
  if (charCount(ctx.text ?? ctx.caption ?? '') > LIMITS.dialog) return ctx.reply(v.checkoutPrompts.tooLong(LIMITS.dialog));
  const photo = ctx.update.message?.photo?.at(-1)?.file_id;
  if (photo) await ctx.sendTo(adminChatId, { photo, text: header + quote(escapeHtml(ctx.caption) || '📷') });
  else if (ctx.text) await ctx.sendTo(adminChatId, { text: header + quote(escapeHtml(ctx.text)) });
  else return ctx.reply({ text: '⚠️ فقط متن یا عکس قابل ارسال است.' });
  await ctx.reply({ text: '✅ پیام شما برای پشتیبانی ارسال شد.' });
}
