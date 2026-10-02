import type { Deps } from '../deps';
import type { Session } from '../db/models';
import { SETTING_DEFAULTS } from '../db/repositories';
import { clampQty, stockProblems } from '../services/CartService';
import { CHECKOUT_FIELDS } from '../services/checkoutFields';
import { availableSlots, dayNo, dayStart, formatSlot, isOffered, type DaySlots } from '../services/schedule';
import type { ScheduledCategory } from '../db/schedule';
import type { BotContext } from '../telegram/BotContext';
import type { Router } from '../telegram/Router';
import type { View } from '../telegram/types';
import { sameSecret } from '../crypto';
import { LIMITS, MAX_AWAITING_REVIEW, charCount, planLimits } from '../limits';
import { escapeHtml } from '../utils/format';
import { isIranMobile, toEnglishDigits } from '../utils/persian';
import * as admin from '../views/admin';
import { button } from '../telegram/keyboard';
import { CB } from '../views/callbacks';
import { heading, hint, quote, sections } from '../views/common';
import { noSlotsAvailable, slotDayPicker, slotTaken, slotTimePicker } from '../views/schedule';
import * as v from '../views/user';

export const CHECKOUT = 'checkout';
const MIN_CLAIM_SECRET = 16;

/** How long the amount shown at the payment step stays valid before prices are re-read. */
export const PRICE_LOCK_MINUTES = 60;
/**
 * How long a time the customer picked is held while they type their details. Once the amount is
 * shown it is held as long as the price (PRICE_LOCK_MINUTES), for the payment.
 */
export const SLOT_PICK_HOLD_MINUTES = 30;

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
    await ctx.render(cart ? v.cartView(cart.lines, await d.schedules.requiredFor(cart.order.id)) : v.emptyCart());
  };
  const showOrders = async (ctx: BotContext) => {
    const user = await d.user(ctx);
    const orders = await d.orders.recentForUser(user.id);
    const ids = orders.map((o) => o.id);
    await ctx.render(v.myOrdersView(orders, await d.orders.linesFor(ids), await d.schedules.forOrders(ids)));
  };
  const showFaqs = async (ctx: BotContext) => ctx.render(v.faqsView(await d.faqs.list(true)));
  const showSupport = async (ctx: BotContext) => ctx.render(v.supportView(await d.settings.get('support')));
  const showHelp = async (ctx: BotContext) => ctx.render(v.helpView(await d.settings.get('help_text')));
  const showProduct = async (ctx: BotContext, id: number, qty: number) => {
    const product = await d.products.findVisible(id);
    const schedule = product?.category_id ? await d.schedules.active(product.category_id) : null;
    await ctx.render(product ? v.productCard(product, clampQty(qty, product.inventory), schedule) : v.productNotFound());
  };
  const removeItem = async (ctx: BotContext, itemId: number) => {
    const aborted = await abortCheckout(ctx.chatId, d);
    const removed = await d.cart.removeItem(await d.user(ctx), itemId);
    if (!removed) await ctx.reply(v.notice('⚠️ این آیتم در سبد خرید شما نیست.'));
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
      // Deep links: a product card sent from inline mode (?start=p_12), or the "open the shop" button (?start=shop).
      .text(/^\/start\s+p_(\d+)$/, async (ctx, [id]) => {
        await abortCheckout(ctx.chatId, d);
        await d.user(ctx);
        await showProduct(ctx, Number(id), 1);
      })
      .text(/^\/start\s+\S+$/, async (ctx) => {
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
          return ctx.reply(v.notice(`⚠️ کد /claim باید حداقل ${MIN_CLAIM_SECRET} کاراکتر باشد تا فعال شود.`));
        }
        if (!secret || !(await sameSecret(secret, d.claimCode))) return ctx.reply(v.notice('❌ کد اشتباه است.'));
        const limits = planLimits(d.shop.plan);
        if ((await d.settings.claimedAdmins()).length >= limits.extraAdmins) {
          return ctx.reply(v.notice(`⚠️ این فروشگاه حداکثر ${limits.extraAdmins} ادمین اضافه می‌تواند داشته باشد.`));
        }
        await d.settings.addAdmin(ctx.chatId);
        await ctx.reply(v.notice('✅ شما ادمین این ربات شدید. برای ورود به پنل /start را بزنید.'));
      })
      .text(v.MENU.shop, showShop)
      .text(v.MENU.cart, showCart)
      .text(v.MENU.orders, showOrders)
      .text(v.MENU.support, showSupport)
      .text(v.MENU.faqs, showFaqs)
      .text(/^\/delete_item_(\d+)$/, (ctx, [id]) => removeItem(ctx, Number(id)))

      /* ----- inline navigation ----- */
      .callback(CB.noop, async () => {})
      .callback(CB.home, async (ctx) => {
        await abortCheckout(ctx.chatId, d); // leaving for the menu gives up the checkout (and the times it holds)
        await showHome(ctx);
      })
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
        // Scheduled categories come first: a customer shouldn't type their details only to find
        // there is no free time. Every one of them must have something to choose from.
        const required = await d.schedules.requiredFor(cart.order.id);
        for (const s of required) {
          if (!(await slotDays(d, s, cart.order.id)).length) return ctx.render(noSlotsAvailable(s));
        }
        const steps = [...required.map((s) => `slot:${s.category_id}`), ...(await d.checkoutFields())];
        const data: v.CheckoutData = { orderId: cart.order.id, steps };
        if (!steps.length) return showPayment(ctx, d, data); // the shop asks for nothing: straight to paying
        await d.sessions.set(ctx.chatId, CHECKOUT, steps[0]!, data);
        await ctx.render(await askFor(ctx, d, steps[0]!, data));
      })
      .callback(CB.cancelCheckout, async (ctx) => {
        await abortCheckout(ctx.chatId, d);
        await showCart(ctx);
      })
      /* ----- scheduled categories: day → time ----- */
      .callback(/^sb:(\d+)$/, async (ctx, [cat]) => {
        const at = await slotStepOf(ctx, d, Number(cat));
        if (at) await ctx.render(await askFor(ctx, d, `slot:${cat}`, at.session.data));
      })
      .callback(/^sd:(\d+):(\d+)$/, async (ctx, [cat, day]) => {
        const at = await slotStepOf(ctx, d, Number(cat));
        if (!at) return;
        const days = await slotDays(d, at.schedule, at.session.data.orderId);
        const chosen = days.find((x) => x.day === Number(day));
        if (!chosen) return ctx.render(await askFor(ctx, d, `slot:${cat}`, at.session.data, '⚠️ این روز دیگر زمان خالی ندارد.'));
        const steps = stepsOf(at.session.data);
        await ctx.render(slotTimePicker(at.schedule, chosen, steps.indexOf(`slot:${cat}`) + 1, steps.length + 1));
      })
      .callback(/^sl:(\d+):(\d+)$/, async (ctx, [cat, rawAt]) => {
        const at = await slotStepOf(ctx, d, Number(cat));
        if (!at) return;
        const { schedule, session } = at;
        const t = now();
        const offered = isOffered(schedule, Number(rawAt), { now: t, closed: await d.schedules.closedDays(dayNo(t)) });
        // Checked and taken in one statement: only a time that is offered and still has room is reserved.
        if (!offered || !(await d.schedules.reserve(session.data.orderId, schedule.category_id, Number(rawAt), schedule.capacity, t, SLOT_PICK_HOLD_MINUTES * 60))) {
          return ctx.render(await askFor(ctx, d, `slot:${cat}`, session.data, slotTaken()));
        }
        await nextStep(ctx, d, session.data, `slot:${cat}`, `✅ ${schedule.label}: <b>${formatSlot(Number(rawAt))}</b>`);
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
 * Ends a checkout in progress and releases its price lock and the times it held, so the cart goes
 * back to live prices and the slots go back to other customers. Returns true when there was one.
 */
async function abortCheckout(chatId: number, d: Deps): Promise<boolean> {
  const s = await d.sessions.get<v.CheckoutData>(chatId);
  if (s?.flow !== CHECKOUT) return false;
  await d.orders.unlockPrices(s.data.orderId);
  if (stepsOf(s.data).some((x) => x.startsWith('slot:'))) await d.schedules.release(s.data.orderId);
  await d.sessions.clear(chatId);
  return true;
}

const stepsOf = (data: v.CheckoutData): string[] => data.steps ?? data.fields ?? [...CHECKOUT_FIELDS];
const SLOT_STEP = /^slot:(\d+)$/;

/** Days with a free time for a scheduled category, from the customer's point of view. */
async function slotDays(d: Deps, s: ScheduledCategory, orderId: number): Promise<DaySlots[]> {
  const t = now();
  const today = dayNo(t);
  const [closed, taken] = await Promise.all([
    d.schedules.closedDays(today),
    d.schedules.taken(s.category_id, dayStart(today), dayStart(today + s.horizon_days), t, orderId),
  ]);
  return availableSlots(s, { now: t, closed, taken });
}

/**
 * The checkout session and schedule behind a day/time button – only while the customer really is at
 * that step (an old button, or a switched-off schedule, gets a short notice instead).
 */
async function slotStepOf(ctx: BotContext, d: Deps, categoryId: number) {
  const session = await d.sessions.get<v.CheckoutData>(ctx.chatId);
  const schedule = session?.flow === CHECKOUT && session.step === `slot:${categoryId}` ? await d.schedules.active(categoryId) : null;
  if (!session || !schedule) {
    if (session?.flow === CHECKOUT && session.step === `slot:${categoryId}`) await abortCheckout(ctx.chatId, d); // its schedule is gone
    await ctx.reply(v.notice('⚠️ این مرحله دیگر معتبر نیست. از سبد خرید دوباره «تکمیل خرید» را بزنید.', [button('🛒 سبد خرید', CB.cart, 'primary')]));
    return null;
  }
  return { session: session as Session<v.CheckoutData>, schedule };
}

/** The question for one checkout step, numbered among this checkout's steps (then payment). */
async function askFor(ctx: BotContext, d: Deps, step: string, data: v.CheckoutData, note = ''): Promise<View> {
  const steps = stepsOf(data);
  const n = steps.indexOf(step) + 1;
  const total = steps.length + 1;
  const slot = SLOT_STEP.exec(step);
  if (slot) {
    const schedule = await d.schedules.active(Number(slot[1]));
    const days = schedule ? await slotDays(d, schedule, data.orderId) : [];
    return schedule && days.length ? slotDayPicker(schedule, days, n, total, note) : noSlotsAvailable(schedule ?? ({ icon: '', name: '', label: 'زمان' } as ScheduledCategory));
  }
  if (step === 'name') return v.checkoutPrompts.name(n, total, ctx.firstName);
  return step === 'address' ? v.checkoutPrompts.address(n, total) : v.checkoutPrompts.phone(n, total);
}

/** Asks the step after `done`, or shows the payment step. `note` is shown above the question. */
async function nextStep(ctx: BotContext, d: Deps, data: v.CheckoutData, done: string, note = ''): Promise<void> {
  const steps = stepsOf(data);
  const next = steps[steps.indexOf(done) + 1];
  if (!next) return showPayment(ctx, d, data, note);
  await d.sessions.set(ctx.chatId, CHECKOUT, next, data);
  const view = await askFor(ctx, d, next, data);
  await ctx.render(note ? { ...view, text: sections(note, view.text) } : view);
}

/**
 * Before the amount is shown: every scheduled category of the order has a time that is still its
 * own. Times whose hold ran out are taken again if free; otherwise the customer is sent back to
 * choose. Returns true when the order may go on to payment.
 */
async function slotsReady(ctx: BotContext, d: Deps, data: v.CheckoutData): Promise<boolean> {
  const required = await d.schedules.requiredFor(data.orderId);
  if (!required.length) return true;
  const held = new Map((await d.schedules.slotsOf(data.orderId)).map((r) => [r.category_id, r.slot_at]));
  const t = now();
  const closed = await d.schedules.closedDays(dayNo(t));
  for (const s of required) {
    const at = held.get(s.category_id);
    const keep = at !== undefined && isOffered(s, at, { now: t, closed }) && (await d.schedules.reserve(data.orderId, s.category_id, at, s.capacity, t, PRICE_LOCK_MINUTES * 60));
    if (keep) continue;
    // Back to this category's day picker (adding the step when the schedule was switched on mid-checkout).
    const step = `slot:${s.category_id}`;
    const steps = stepsOf(data);
    const fixed: v.CheckoutData = { ...data, steps: steps.includes(step) ? steps : [step, ...steps] };
    await d.sessions.set(ctx.chatId, CHECKOUT, step, fixed);
    await ctx.render(await askFor(ctx, d, step, fixed, at === undefined ? '' : slotTaken()));
    return false;
  }
  return true;
}

/** Locks current prices into the cart and shows the amount to pay (the last checkout step). */
async function showPayment(ctx: BotContext, d: Deps, data: v.CheckoutData, note = ''): Promise<void> {
  // Stock may have run out while the customer was typing their details.
  const problems = stockProblems(await d.orders.lines(data.orderId));
  if (problems.length) {
    await abortCheckout(ctx.chatId, d);
    return ctx.reply(v.stockProblemsView(problems));
  }
  if (!(await slotsReady(ctx, d, data))) return;
  await d.orders.lockPrices(data.orderId);
  const { total } = await d.orders.lockedTotal(data.orderId);
  await d.sessions.set(ctx.chatId, CHECKOUT, 'receipt', { ...data, total, lockedAt: now() });
  const bank = await d.settings.get('bank_info');
  const steps = stepsOf(data).length + 1;
  const view = v.checkoutPrompts.payment(steps, steps, bank, total, PRICE_LOCK_MINUTES);
  await ctx.render(note ? { ...view, text: sections(note, view.text) } : view);
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

/** Every scheduled category of the order still holds its time (and keeps it a few minutes more). */
async function slotsStillHeld(d: Deps, data: v.CheckoutData): Promise<boolean> {
  const required = await d.schedules.requiredFor(data.orderId);
  return !required.length || d.schedules.stillHeld(data.orderId, required.length, now(), now() + 600);
}

/** One function per checkout step; each validates input, stores it and asks for the next value. */
async function checkoutStep(ctx: BotContext, s: Session<v.CheckoutData>, d: Deps, input = ctx.text): Promise<void> {
  const text = input?.trim();

  switch (s.step) {
    case 'name': {
      // Any name will do – just "علی" too; nobody should be sent back for a missing surname.
      if (!text || text.startsWith('/') || charCount(text) < 2) return ctx.reply(v.checkoutPrompts.badName(ctx.firstName));
      if (charCount(text) > LIMITS.name) return ctx.reply(v.checkoutPrompts.tooLong(LIMITS.name));
      return nextStep(ctx, d, { ...s.data, firstName: text, lastName: '' }, 'name');
    }
    case 'address': {
      if (!text || text.startsWith('/') || charCount(text) < LIMITS.addressMin) return ctx.reply(await askFor(ctx, d, 'address', s.data));
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
      const lockOk = await lockStillValid(d, s.data);
      if (!lockOk || !(await slotsStillHeld(d, s.data))) {
        await ctx.reply(lockOk ? v.checkoutPrompts.slotsChanged() : v.checkoutPrompts.pricesChanged());
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
      await ctx.reply(v.receiptAccepted(full.order.track_id, s.data, full.lines, full.slots));
      const alert = admin.orderView(full, '🔔 <b>سفارش جدید ثبت شد!</b>');
      await Promise.all(d.adminIds.map((id) => ctx.sendTo(id, alert).catch((err) => console.error('notify admin', id, err))));
      return;
    }
    default:
      // Typed text at a day/time step: the buttons are the answer, so show them again.
      if (SLOT_STEP.test(s.step)) return ctx.reply(await askFor(ctx, d, s.step, s.data, '👆 لطفاً از دکمه‌ها انتخاب کنید.'));
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
  else return ctx.reply(v.notice('⚠️ فقط متن یا عکس قابل ارسال است.'));
  await ctx.reply(v.notice('✅ پیام شما برای پشتیبانی ارسال شد.', [button('📋 سفارش‌های من', CB.myOrders)]));
}
