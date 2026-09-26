import type { Deps } from '../deps';
import type { Session } from '../db/models';
import { cartTotal, clampQty, stockProblems } from '../services/CartService';
import type { BotContext } from '../telegram/BotContext';
import type { Router } from '../telegram/Router';
import { escapeHtml } from '../utils/format';
import { isIranMobile, toEnglishDigits } from '../utils/persian';
import * as admin from '../views/admin';
import { CB } from '../views/callbacks';
import * as v from '../views/user';

export const CHECKOUT = 'checkout';

export function registerUserRoutes(router: Router, d: Deps): Router {
  const showHome = async (ctx: BotContext) => {
    await d.user(ctx.chatId, ctx.firstName);
    await ctx.render(v.mainMenu(ctx.firstName));
  };
  const showShop = async (ctx: BotContext) => ctx.render(v.categoriesView(await d.categories.list(true)));
  const showCart = async (ctx: BotContext) => {
    const cart = await d.cart.contents(await d.user(ctx.chatId, ctx.firstName));
    await ctx.render(cart ? v.cartView(cart.lines) : v.emptyCart());
  };
  const showOrders = async (ctx: BotContext) => {
    const user = await d.user(ctx.chatId, ctx.firstName);
    const orders = await d.orders.recentForUser(user.id);
    await ctx.render(v.myOrdersView(orders, await d.orders.linesFor(orders.map((o) => o.id))));
  };
  const showFaqs = async (ctx: BotContext) => ctx.render(v.faqsView(await d.faqs.list(true)));
  const showSupport = async (ctx: BotContext) => ctx.render(v.supportView(await d.settings.get('support', 'پشتیبانی تنظیم نشده')));
  const showHelp = async (ctx: BotContext) => ctx.render(v.helpView(await d.settings.get('help_text', 'راهنما هنوز تنظیم نشده است.')));
  const showProduct = async (ctx: BotContext, id: number, qty: number) => {
    const product = await d.products.find(id);
    await ctx.render(product?.status === 'enable' ? v.productCard(product, clampQty(qty)) : v.productNotFound());
  };

  return (
    router
      /* ----- text commands & persistent keyboard ----- */
      .text(['/start', v.MENU.home], async (ctx) => {
        await showHome(ctx);
        await ctx.reply(v.persistentKeyboard());
      })
      .text('/cancel', async (ctx) => {
        await d.sessions.clear(ctx.chatId);
        await ctx.reply({ text: '✅ عملیات لغو شد.' });
        await showHome(ctx);
      })
      .text(v.MENU.shop, showShop)
      .text(v.MENU.cart, showCart)
      .text(v.MENU.orders, showOrders)
      .text(v.MENU.support, showSupport)
      .text(v.MENU.faqs, showFaqs)
      .text(/^\/delete_item_(\d+)$/, async (ctx, [id]) => {
        const removed = await d.cart.removeItem(await d.user(ctx.chatId, ctx.firstName), Number(id));
        await ctx.reply({ text: removed ? '🗑️ آیتم از سبد خرید حذف شد.' : '⚠️ آیتم معتبر یافت نشد.' });
        await showCart(ctx);
      })

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
        await ctx.render(v.categoryProductsView(category, products));
      })
      .callback(/^prod:(\d+)$/, (ctx, [id]) => showProduct(ctx, Number(id), 1))
      .callback(/^qty:(\d+):(-?\d+)$/, (ctx, [id, qty]) => showProduct(ctx, Number(id), Number(qty)))

      /* ----- cart ----- */
      .callback(/^add:(\d+):(\d+)$/, async (ctx, [id, rawQty]) => {
        const qty = clampQty(Number(rawQty));
        const result = await d.cart.add(await d.user(ctx.chatId, ctx.firstName), Number(id), qty);
        if (result.ok) return ctx.render(v.addedToCart(qty));
        await ctx.render(result.reason === 'not_found' ? v.productNotFound() : v.notEnoughStock(result.product, result.inCart, qty));
      })
      .callback(CB.clearCart, async (ctx) => {
        await d.cart.clear(await d.user(ctx.chatId, ctx.firstName));
        await d.sessions.clear(ctx.chatId);
        await ctx.render({ text: '⛔📝 سبد خرید شما با موفقیت خالی شد' });
        await ctx.reply(v.mainMenu(ctx.firstName));
      })
      .callback(CB.checkout, async (ctx) => {
        const cart = await d.cart.contents(await d.user(ctx.chatId, ctx.firstName));
        if (!cart) return ctx.render(v.emptyCart());
        const problems = stockProblems(cart.lines);
        if (problems.length) return ctx.render(v.stockProblemsView(problems));
        const data: v.CheckoutData = { orderId: cart.order.id };
        await d.sessions.set(ctx.chatId, CHECKOUT, 'name', data);
        await ctx.render(v.checkoutPrompts.name());
      })

      /* ----- free input: checkout steps, buyer replies to admin ----- */
      .fallback(async (ctx) => {
        if (ctx.isCallback) {
          // A button from an old message (or the previous PHP bot) – just show the menu.
          return ctx.reply(v.mainMenu(ctx.firstName));
        }
        const session = await d.sessions.get<v.CheckoutData>(ctx.chatId);
        if (session?.flow === CHECKOUT) return checkoutStep(ctx, session, d);

        const dialog = await d.dialogs.findByBuyer(ctx.chatId);
        if (dialog) return forwardBuyerReply(ctx, d, dialog.admin_chat_id, dialog.order_id);

        await ctx.reply(v.unknownCommand());
      })
  );
}

/** One function per checkout step; each validates input, stores it and asks for the next value. */
async function checkoutStep(ctx: BotContext, s: Session<v.CheckoutData>, d: Deps): Promise<void> {
  const text = ctx.text;
  const advance = (step: string, data: v.CheckoutData) => d.sessions.set(ctx.chatId, CHECKOUT, step, data);

  switch (s.step) {
    case 'name': {
      const parts = text?.split(/\s+/) ?? [];
      if (parts.length < 2 || text!.startsWith('/')) return ctx.reply(v.checkoutPrompts.badName());
      await advance('address', { ...s.data, firstName: parts[0], lastName: parts.slice(1).join(' ') });
      return ctx.reply(v.checkoutPrompts.address());
    }
    case 'address': {
      if (!text || text.startsWith('/')) return ctx.reply(v.checkoutPrompts.address());
      await advance('phone', { ...s.data, address: text });
      return ctx.reply(v.checkoutPrompts.phone());
    }
    case 'phone': {
      const phone = toEnglishDigits(text ?? '').replace(/[\s-]/g, '');
      if (!isIranMobile(phone)) return ctx.reply(v.checkoutPrompts.badPhone());
      const total = cartTotal(await d.orders.lines(s.data.orderId));
      await advance('receipt', { ...s.data, phone, total });
      return ctx.reply(v.checkoutPrompts.payment(await d.settings.get('bank_info', 'شماره کارت هنوز تنظیم نشده است.'), total));
    }
    case 'receipt': {
      const fileId = ctx.imageFileId;
      if (!fileId) return ctx.reply(v.checkoutPrompts.needImage());

      // Archive to R2; the Telegram file_id alone is enough to show the receipt, so this is best-effort.
      const r2Key = d.files
        ? await d.files.saveTelegramFile(fileId, 'receipts').catch((err) => {
            console.error('receipt archive failed', err);
            return null;
          })
        : null;
      await d.orders.markPaid({
        order_id: s.data.orderId,
        first_name: s.data.firstName ?? '',
        last_name: s.data.lastName ?? '',
        address: s.data.address ?? '',
        phone_number: s.data.phone ?? '',
        receipt_file_id: fileId,
        receipt_r2_key: r2Key,
      });
      await d.sessions.clear(ctx.chatId);

      const full = (await d.orderService.load(s.data.orderId))!;
      await ctx.reply(v.receiptAccepted(full.order.track_id, { ...s.data, total: cartTotal(full.lines) }));
      const alert = admin.orderView(full, '🔔 <b>سفارش جدید ثبت شد!</b>');
      await Promise.all(d.adminIds.map((id) => ctx.sendTo(id, alert).catch((err) => console.error('notify admin', id, err))));
      return;
    }
  }
}

async function forwardBuyerReply(ctx: BotContext, d: Deps, adminChatId: number, orderId: number): Promise<void> {
  const header = `📥 <b>پاسخ خریدار</b> (Order #${orderId}):\n\n`;
  const photo = ctx.update.message?.photo?.at(-1)?.file_id;
  if (photo) await ctx.sendTo(adminChatId, { photo, text: header + escapeHtml(ctx.caption) });
  else if (ctx.text) await ctx.sendTo(adminChatId, { text: header + escapeHtml(ctx.text) });
  else return ctx.reply({ text: '⚠️ فقط متن یا عکس قابل ارسال است.' });
  await ctx.reply({ text: '✅ پیام شما برای پشتیبانی ارسال شد.' });
}
