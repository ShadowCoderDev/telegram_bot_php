import type { Deps } from '../deps';
import { flip, type Session } from '../db/models';
import { EDITABLE_PRODUCT_FIELDS, SETTING_KEYS, type EditableProductField, type ProductDraft, type ProductImage, type SettingKey } from '../db/repositories';
import type { AdminOrderAction } from '../services/orderStatus';
import type { BotContext } from '../telegram/BotContext';
import { backRow, button } from '../telegram/keyboard';
import type { Router } from '../telegram/Router';
import { escapeHtml as e, money } from '../utils/format';
import { parseAmount, tehranDayAndMonthStart } from '../utils/persian';
import * as v from '../views/admin';
import { CB } from '../views/callbacks';

const A = CB.admin;

/** Admin multi-step flows, stored in the shared `sessions` table. */
const FLOW = {
  setting: 'edit_setting',
  faq: 'add_faq',
  category: 'add_category',
  product: 'add_product',
  edit: 'edit_product',
  dialog: 'dialog',
} as const;
const ADMIN_FLOWS: readonly string[] = Object.values(FLOW);

type Data = Record<string, unknown>;

/**
 * Registered before the user router and only for admins. Anything it doesn't match falls through
 * to the user routes, so an admin can also browse the shop like a customer.
 */
export function registerAdminRoutes(router: Router, d: Deps): Router {
  const showRoot = (ctx: BotContext) => ctx.render(v.adminRoot());
  const showProduct = async (ctx: BotContext, id: number) => {
    const p = await d.products.find(id);
    if (!p) return ctx.render(v.done('❌ محصول یافت نشد.'));
    await ctx.render(v.productInfo(p, p.category_id ? await d.categories.find(p.category_id) : null));
  };
  const showOrder = async (ctx: BotContext, id: number) => {
    const full = await d.orderService.load(id);
    await ctx.render(full ? v.orderView(full) : v.done('❌ سفارش یافت نشد.'));
  };
  const start = async (ctx: BotContext, flow: string, step: string, data: Data, message: string) => {
    await d.sessions.set(ctx.chatId, flow, step, data);
    await ctx.reply(v.prompt(message));
  };

  return (
    router
      .text(['/start', '/admin', v.ADMIN_HOME], async (ctx) => {
        await ctx.reply(v.adminRoot());
        await ctx.reply(v.adminReplyKeyboard());
      })
      .text('/cancel', async (ctx) => {
        await closeDialogFor(ctx.chatId, d);
        await d.sessions.clear(ctx.chatId);
        await ctx.reply(v.done('✅ عملیات لغو شد.'));
      })
      .callback(A.root, showRoot)
      .callback(A.cancel, async (ctx) => {
        await d.sessions.clear(ctx.chatId);
        await ctx.render(v.done('✅ عملیات لغو شد.'));
      })

      /* ----- stats ----- */
      .callback(A.stats, async (ctx) => {
        const [users, products, money] = await Promise.all([
          d.users.count(),
          d.products.count(),
          d.orders.stats(tehranDayAndMonthStart(Math.floor(Date.now() / 1000))),
        ]);
        await ctx.render(v.statsView({ users, products, ...money }));
      })

      /* ----- settings ----- */
      .callback(A.settings, (ctx) => ctx.render(v.settingsMenu()))
      .callback(/^a:set:(\w+)$/, async (ctx, [key]) => {
        if (!SETTING_KEYS.includes(key as SettingKey)) return;
        await start(ctx, FLOW.setting, 'value', { key }, v.SETTING_LABELS[key as SettingKey].prompt);
      })

      /* ----- FAQs ----- */
      .callback(A.faqs, async (ctx) => ctx.render(v.faqsManage(await d.faqs.list(false))))
      .callback(A.addFaq, (ctx) => start(ctx, FLOW.faq, 'question', {}, '<b>مرحله ۱: افزودن سوال</b>\n\nلطفاً «سوال» را به صورت کامل وارد کنید:'))
      .callback(/^a:faq:toggle:(\d+)$/, async (ctx, [id]) => {
        const faq = await d.faqs.find(Number(id));
        if (faq) await d.faqs.setStatus(faq.id, flip(faq.status));
        await ctx.render(v.faqsManage(await d.faqs.list(false)));
      })

      /* ----- categories ----- */
      .callback(A.categories, async (ctx) => ctx.render(v.categoriesManage(await d.categories.list(false))))
      .callback(A.addCategory, (ctx) => start(ctx, FLOW.category, 'name', {}, '<b>مرحله ۱: افزودن دسته‌بندی</b>\n\nنام دسته‌بندی را وارد کنید:'))
      .callback(/^a:cat:toggle:(\d+)$/, async (ctx, [id]) => {
        const cat = await d.categories.find(Number(id));
        if (cat) await d.categories.setStatus(cat.id, flip(cat.status));
        await ctx.render(v.categoriesManage(await d.categories.list(false)));
      })
      .callback(A.deleteCategories, async (ctx) => ctx.render(v.categoryDeleteList(await d.categories.list(false))))
      .callback(/^a:cat:del:(\d+)$/, async (ctx, [id]) => {
        const cat = await d.categories.find(Number(id));
        if (!cat) return ctx.render(v.done('❌ دسته‌بندی یافت نشد.'));
        await ctx.render(v.categoryDeleteConfirm(cat, await d.categories.hasProducts(cat.id)));
      })
      .callback(/^a:cat:delok:(\d+)$/, async (ctx, [id]) => {
        const catId = Number(id);
        if (await d.categories.hasProducts(catId)) return ctx.render(v.done('🚫 این دسته‌بندی شامل محصول است و قابل حذف نیست.'));
        await d.categories.delete(catId);
        await ctx.reply({ text: '✅ دسته‌بندی با موفقیت حذف شد.' });
        await ctx.render(v.categoryDeleteList(await d.categories.list(false)));
      })

      /* ----- products ----- */
      .callback(A.products, async (ctx) => ctx.render(v.productsList(await d.products.listAll())))
      .callback(A.addProduct, (ctx) => start(ctx, FLOW.product, 'title', {}, '<b>مرحله ۱: افزودن محصول</b>\n\nنام محصول را وارد کنید:'))
      .callback(/^a:prod:(\d+)$/, (ctx, [id]) => showProduct(ctx, Number(id)))
      .callback(/^a:prod:edit:(\d+)$/, (ctx, [id]) => ctx.render(v.productEditMenu(Number(id))))
      .callback(/^a:prod:field:(\d+):(\w+)$/, async (ctx, [id, field]) => {
        if (!EDITABLE_PRODUCT_FIELDS.includes(field as EditableProductField)) return;
        const label = v.PRODUCT_FIELD_LABELS[field as EditableProductField];
        await start(ctx, FLOW.edit, field!, { productId: Number(id) }, `✏️ ویرایش محصول #${id}\n\n${label.prompt}`);
      })
      .callback(/^a:prod:toggle:(\d+)$/, async (ctx, [id]) => {
        const p = await d.products.find(Number(id));
        if (p) await d.products.update(p.id, 'status', flip(p.status));
        await showProduct(ctx, Number(id));
      })
      .callback(/^a:prod:cat:(\d+)$/, async (ctx, [id]) => {
        const pid = Number(id);
        const cats = await d.categories.list(true);
        await ctx.render(v.categoryPicker(cats, `🔁 دسته‌ی جدید را برای محصول #${pid} انتخاب کنید:`, (c) => A.setCategory(pid, c.id), backRow(A.editProduct(pid))));
      })
      .callback(/^a:prod:setcat:(\d+):(\d+)$/, async (ctx, [id, catId]) => {
        await d.products.update(Number(id), 'category_id', Number(catId));
        await showProduct(ctx, Number(id));
      })
      .callback(/^a:prod:newcat:(\d+)$/, async (ctx, [catId]) => {
        const s = await d.sessions.get<Partial<ProductDraft>>(ctx.chatId);
        if (s?.flow !== FLOW.product || s.step !== 'category') return ctx.render(v.done('❌ فرایند افزودن محصول یافت نشد. دوباره شروع کنید.'));
        const draft = { ...s.data, category_id: Number(catId) } as ProductDraft;
        const id = await d.products.create(draft);
        await d.sessions.clear(ctx.chatId);
        await ctx.render(v.done(`✅ محصول '<b>${e(draft.title)}</b>' با شناسه #${id} اضافه شد.`));
      })

      /* ----- orders ----- */
      .callback(A.orders, async (ctx) => ctx.render(v.ordersList(await d.orders.recentNonPending())))
      .callback(/^a:order:(\d+)$/, (ctx, [id]) => showOrder(ctx, Number(id)))
      .callback(/^a:order:(approve|reject|send):(\d+)$/, async (ctx, [action, id]) => {
        const result = await d.orderService.apply(Number(id), action as AdminOrderAction);
        if (result.ok) {
          await ctx.render(v.orderView(result.order));
          await notifyBuyer(ctx, result.order.order.user_chat_id, result.order.order.track_id, action as AdminOrderAction);
          return;
        }
        const msg =
          result.reason === 'no_stock'
            ? `⚠️ <b>خطا در تایید سفارش #${id}</b>\n\n` +
              result.problems.map((p) => `موجودی '<b>${e(p.title)}</b>' کافی نیست: ${p.inventory} | درخواستی: ${p.quantity}`).join('\n')
            : result.reason === 'not_found'
              ? '❌ سفارش یافت نشد.'
              : '⚠️ این عملیات برای وضعیت فعلی سفارش مجاز نیست.';
        await ctx.reply({ text: msg });
      })

      /* ----- admin ↔ buyer dialog ----- */
      .callback(/^a:dialog:(\d+)$/, async (ctx, [id]) => {
        const order = await d.orders.find(Number(id));
        if (!order) return ctx.reply({ text: '❌ سفارش یافت نشد.' });
        await d.dialogs.open({ buyer_chat_id: order.user_chat_id, admin_chat_id: ctx.chatId, order_id: order.id });
        await d.sessions.set(ctx.chatId, FLOW.dialog, 'await', { buyerChatId: order.user_chat_id, orderId: order.id });
        await ctx.reply(v.dialogOpened(order.user_chat_id));
      })
      .callback(/^a:dialog:close:(\d+)$/, async (ctx, [buyer]) => {
        await d.dialogs.close(Number(buyer));
        await d.sessions.clear(ctx.chatId);
        await ctx.render(v.done('🔒 گفتگو بسته شد.'));
      })

      /* ----- free input for admin flows; decline otherwise so the user router gets it ----- */
      .fallback(async (ctx) => {
        if (ctx.isCallback) return false;
        const s = await d.sessions.get<Data>(ctx.chatId);
        if (!s || !ADMIN_FLOWS.includes(s.flow)) return false;
        await adminFlowStep(ctx, s, d);
      })
  );
}

const STATUS_MESSAGES: Record<AdminOrderAction, string> = {
  approve: '✅ سفارش شما با کد رهگیری <b>{t}</b> تایید شد.',
  reject: '❌ سفارش شما با کد رهگیری <b>{t}</b> رد شد. برای پیگیری با پشتیبانی در تماس باشید.',
  send: '📤 سفارش شما با کد رهگیری <b>{t}</b> ارسال شد.',
};

function notifyBuyer(ctx: BotContext, buyerChatId: number, trackId: string, action: AdminOrderAction) {
  return ctx.sendTo(buyerChatId, { text: STATUS_MESSAGES[action].replace('{t}', trackId) }).catch((err) => console.error('notify buyer', err));
}

async function closeDialogFor(adminChatId: number, d: Deps) {
  const s = await d.sessions.get<{ buyerChatId?: number }>(adminChatId);
  if (s?.flow === FLOW.dialog && s.data.buyerChatId) await d.dialogs.close(s.data.buyerChatId);
}

/**
 * Reads a product image: an uploaded photo is kept as its Telegram file_id (Telegram stores the
 * file, so no R2 is needed); otherwise the text must be an http(s) link.
 */
function readImage(ctx: BotContext): ProductImage | null {
  if (ctx.imageFileId) return { image_file_id: ctx.imageFileId, image_url: '' };
  try {
    const url = new URL(ctx.text ?? '');
    return url.protocol === 'https:' || url.protocol === 'http:' ? { image_url: url.toString(), image_file_id: '' } : null;
  } catch {
    return null;
  }
}

const BAD_IMAGE = '❌ تصویر دریافت نشد.\nیک <b>عکس</b> بفرستید (یا یک لینک که با https:// شروع شود).';

async function adminFlowStep(ctx: BotContext, s: Session<Data>, d: Deps): Promise<void> {
  const text = ctx.text ?? '';
  const next = (step: string, data: Data, message: string) =>
    d.sessions.set(ctx.chatId, s.flow, step, data).then(() => ctx.reply(v.prompt(message)));
  const finish = (message: string) => d.sessions.clear(ctx.chatId).then(() => ctx.reply(v.done(message)));
  const needText = () => ctx.reply(v.prompt('⚠️ لطفاً یک متن ارسال کنید.'));

  switch (s.flow) {
    case FLOW.setting: {
      if (!text) return needText();
      await d.settings.set(s.data.key as SettingKey, text);
      await d.sessions.clear(ctx.chatId);
      await ctx.reply({ text: '✅ تنظیمات با موفقیت به‌روزرسانی شد.' });
      return ctx.reply(v.settingsMenu());
    }

    case FLOW.faq: {
      if (!text) return needText();
      if (s.step === 'question') return next('answer', { question: text }, '<b>مرحله ۲:</b>\n\nحالا «پاسخ» این سوال را وارد کنید:');
      await d.faqs.create(String(s.data.question), text);
      return finish('✅ سوال جدید با موفقیت اضافه شد.');
    }

    case FLOW.category: {
      if (!text) return needText();
      if (s.step === 'name') return next('icon', { name: text }, '<b>مرحله ۲:</b>\n\nیک آیکون (ایموجی) برای دسته‌بندی بفرستید (مثال: ✨)');
      await d.categories.create(String(s.data.name), text);
      return finish(`✅ دسته‌بندی '<b>${e(String(s.data.name))}</b>' اضافه شد.`);
    }

    case FLOW.product:
      return addProductStep(ctx, s, d, text, next);

    case FLOW.edit: {
      const field = s.step as EditableProductField;
      const productId = Number(s.data.productId);
      if (field === 'image_url') {
        const image = readImage(ctx);
        if (!image) return ctx.reply(v.prompt(BAD_IMAGE));
        await d.products.setImage(productId, image);
      } else {
        const value = field === 'price' || field === 'inventory' ? parseAmount(text) : text || null;
        if (value === null) return ctx.reply(v.prompt('❌ مقدار نامعتبر است. دوباره ارسال کنید.'));
        await d.products.update(productId, field, value);
      }
      await d.sessions.clear(ctx.chatId);
      await ctx.reply({ text: `✅ مقدار <b>${field}</b> محصول #${productId} بروزرسانی شد.` });
      const p = (await d.products.find(productId))!;
      return ctx.reply(v.productInfo(p, p.category_id ? await d.categories.find(p.category_id) : null));
    }

    case FLOW.dialog: {
      const buyer = Number(s.data.buyerChatId);
      const photo = ctx.update.message?.photo?.at(-1)?.file_id;
      const header = '📣 <b>پیام از پشتیبانی:</b>\n\n';
      if (photo) await ctx.sendTo(buyer, { photo, text: header + e(ctx.caption) });
      else if (text) await ctx.sendTo(buyer, { text: header + e(text) });
      else return ctx.reply(v.prompt('⚠️ فقط متن یا عکس را بفرستید.'));
      return ctx.reply({ ...v.dialogOpened(buyer), text: '✅ پیام برای خریدار ارسال شد.' });
    }
  }
}

type Next = (step: string, data: Data, message: string) => Promise<void>;

/** title → description → price → author → inventory → image → (category button) */
async function addProductStep(ctx: BotContext, s: Session<Data>, d: Deps, text: string, next: Next): Promise<void> {
  const data = s.data;
  switch (s.step) {
    case 'title':
      if (!text) break;
      return next('description', { ...data, title: text }, '<b>مرحله ۲:</b>\n\nتوضیحات محصول را وارد کنید:');
    case 'description':
      if (!text) break;
      return next('price', { ...data, description: text }, '<b>مرحله ۳:</b>\n\nقیمت محصول را به تومان (فقط عدد) وارد کنید:');
    case 'price': {
      const price = parseAmount(text);
      if (price === null) return ctx.reply(v.prompt('❌ لطفاً قیمت را فقط به صورت عدد وارد کنید.'));
      return next('author', { ...data, price }, `<b>مرحله ۴:</b>\n\n(${money(price)} تومان ثبت شد)\nنام نویسنده/مدرس را وارد کنید:`);
    }
    case 'author':
      if (!text) break;
      return next('inventory', { ...data, author: text }, '<b>مرحله ۵:</b>\n\nتعداد موجودی محصول را وارد کنید (فقط عدد):');
    case 'inventory': {
      const inventory = parseAmount(text);
      if (inventory === null) return ctx.reply(v.prompt('❌ لطفاً موجودی را فقط به صورت عدد وارد کنید.'));
      return next('image', { ...data, inventory }, '<b>مرحله ۶:</b>\n\n🖼 عکس محصول را بفرستید (یا لینک تصویر).\nبرای رد شدن <code>-</code> بفرستید.');
    }
    case 'image': {
      const image = text === '-' ? { image_url: '', image_file_id: '' } : readImage(ctx);
      if (!image) return ctx.reply(v.prompt(BAD_IMAGE));
      const cats = await d.categories.list(true);
      if (!cats.length) {
        await d.sessions.clear(ctx.chatId);
        return ctx.reply(v.done('❌ هیچ دسته‌بندی فعالی وجود ندارد. ابتدا یک دسته‌بندی ایجاد کنید.'));
      }
      await d.sessions.set(ctx.chatId, s.flow, 'category', { ...data, ...image });
      return ctx.reply(
        v.categoryPicker(cats, '<b>مرحله نهایی (۷):</b>\n\nدسته‌بندی این محصول را انتخاب کنید:', (c) => A.newProductCategory(c.id), [
          button('لغو عملیات ❌', A.cancel),
        ]),
      );
    }
    case 'category':
      return ctx.reply({ text: '👆 لطفاً دسته‌بندی را از دکمه‌های بالا انتخاب کنید.' });
  }
  await ctx.reply(v.prompt('⚠️ لطفاً یک متن ارسال کنید.'));
}
