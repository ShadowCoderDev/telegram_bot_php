import type { Deps } from '../deps';
import { flip, type Session } from '../db/models';
import { EDITABLE_PRODUCT_FIELDS, SETTING_KEYS, type EditableProductField, type ProductDraft, type ProductImage, type SettingKey } from '../db/repositories';
import type { AdminOrderAction } from '../services/orderStatus';
import type { BotContext } from '../telegram/BotContext';
import { backRow, button } from '../telegram/keyboard';
import type { Router } from '../telegram/Router';
import type { View } from '../telegram/types';
import { escapeHtml as e, money } from '../utils/format';
import { parseAmount, tehranDayAndMonthStart } from '../utils/persian';
import * as v from '../views/admin';
import { CB } from '../views/callbacks';
import { fa, heading, hint, progress, quote, sections } from '../views/common';
import { LIMITS, charCount } from '../limits';

const A = CB.admin;

/** Admin multi-step flows, stored in the shared `sessions` table. */
const FLOW = {
  setting: 'edit_setting',
  faq: 'add_faq',
  category: 'add_category',
  product: 'add_product',
  edit: 'edit_product',
  dialog: 'dialog',
  findCustomer: 'find_customer',
} as const;
const ADMIN_FLOWS: readonly string[] = Object.values(FLOW);

type Data = Record<string, unknown>;

const PRODUCT_STEPS = 7;
const PRODUCT_STEP = (n: number, body: string) => v.formStep('افزودن محصول', n, PRODUCT_STEPS, body);
const CATEGORY_STEP = (n: number, body: string) => v.formStep('افزودن دسته‌بندی', n, 2, body);
const FAQ_STEP = (n: number, body: string) => v.formStep('افزودن سوال متداول', n, 2, body);

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
  const showProducts = async (ctx: BotContext, page: number) => {
    const total = await d.products.count();
    const p = clampPage(page, total);
    await ctx.render(v.productsList(await d.products.listPage(v.PAGE_SIZE, p * v.PAGE_SIZE), p, total));
  };
  const showOrders = async (ctx: BotContext, page: number) => {
    const total = await d.orders.countPlaced();
    const p = clampPage(page, total);
    await ctx.render(v.ordersList(await d.orders.placedPage(v.PAGE_SIZE, p * v.PAGE_SIZE), p, total));
  };
  const showCustomers = async (ctx: BotContext, page: number) => {
    const total = await d.users.count();
    const p = clampPage(page, total);
    await ctx.render(v.customersList(await d.users.customersPage(v.PAGE_SIZE, p * v.PAGE_SIZE), p, total));
  };
  const showCustomer = async (ctx: BotContext, userId: number, page: number) => {
    const c = await d.users.customer(userId);
    if (!c) return ctx.render(v.done('❌ مشتری یافت نشد.'));
    const p = clampPage(page, c.orders_count);
    const [contact, orders] = await Promise.all([d.users.lastContact(userId), d.orders.placedPage(v.PAGE_SIZE, p * v.PAGE_SIZE, userId)]);
    await ctx.render(v.customerView(c, contact, orders, p, d.adminIds.includes(c.chat_id)));
  };
  const openDialog = async (ctx: BotContext, buyerChatId: number, orderId: number, name: string) => {
    await d.dialogs.open({ buyer_chat_id: buyerChatId, admin_chat_id: ctx.chatId, order_id: orderId });
    await d.sessions.set(ctx.chatId, FLOW.dialog, 'await', { buyerChatId, orderId });
    await ctx.reply(v.dialogOpened(buyerChatId, name));
  };
  const start = async (ctx: BotContext, flow: string, step: string, data: Data, message: string | View) => {
    await d.sessions.set(ctx.chatId, flow, step, data);
    await ctx.reply(typeof message === 'string' ? v.prompt(message) : message);
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
      .callback(A.addFaq, (ctx) => start(ctx, FLOW.faq, 'question', {}, FAQ_STEP(1, '❓ متن کامل <b>سوال</b> را بفرستید:')))
      .callback(/^a:faq:toggle:(\d+)$/, async (ctx, [id]) => {
        const faq = await d.faqs.find(Number(id));
        if (faq) await d.faqs.setStatus(faq.id, flip(faq.status));
        await ctx.render(v.faqsManage(await d.faqs.list(false)));
      })

      /* ----- categories ----- */
      .callback(A.categories, async (ctx) => ctx.render(v.categoriesManage(await d.categories.list(false))))
      .callback(A.addCategory, (ctx) => start(ctx, FLOW.category, 'name', {}, CATEGORY_STEP(1, '📂 <b>نام</b> دسته‌بندی را بفرستید:')))
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
        await ctx.reply({ text: '✅ دسته‌بندی حذف شد.' });
        await ctx.render(v.categoryDeleteList(await d.categories.list(false)));
      })

      /* ----- products ----- */
      .callback(A.products, (ctx) => showProducts(ctx, 0))
      .callback(/^a:prods:(\d+)$/, (ctx, [page]) => showProducts(ctx, Number(page)))
      .callback(A.addProduct, (ctx) => start(ctx, FLOW.product, 'title', {}, PRODUCT_STEP(1, '📘 <b>نام</b> محصول را بفرستید:')))
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
        await ctx.render(v.done(sections(heading('✅', 'محصول اضافه شد'), quote(`📘 <b>${e(draft.title)}</b>  ${hint(`#${id}`)}`))));
      })

      /* ----- orders ----- */
      .callback(A.orders, (ctx) => showOrders(ctx, 0))
      .callback(/^a:orders:(\d+)$/, (ctx, [page]) => showOrders(ctx, Number(page)))
      .callback(/^a:order:(\d+)$/, (ctx, [id]) => showOrder(ctx, Number(id)))
      .callback(/^a:order:(approve|reject|send):(\d+)$/, async (ctx, [action, id]) => {
        const result = await d.orderService.apply(Number(id), action as AdminOrderAction);
        if (result.ok) {
          await ctx.render(v.orderView(result.order));
          await notifyBuyer(ctx, result.order.order.user_chat_id, result.order.order.track_id, action as AdminOrderAction);
          return;
        }
        if (result.reason === 'already_changed') {
          // A double click or another admin got there first; show the order as it is now.
          await ctx.reply({ text: 'ℹ️ این سفارش همین حالا تغییر کرده بود؛ وضعیت فعلی:' });
          return showOrder(ctx, Number(id));
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

      /* ----- customers ----- */
      .callback(A.customers, (ctx) => showCustomers(ctx, 0))
      .callback(A.findCustomer, (ctx) => start(ctx, FLOW.findCustomer, 'query', {}, v.CUSTOMER_SEARCH_PROMPT))
      .callback(/^a:users:(\d+)$/, (ctx, [page]) => showCustomers(ctx, Number(page)))
      .callback(/^a:user:(\d+)$/, (ctx, [id]) => showCustomer(ctx, Number(id), 0))
      .callback(/^a:user:(\d+):(\d+)$/, (ctx, [id, page]) => showCustomer(ctx, Number(id), Number(page)))
      .callback(/^a:user:block:(\d+)$/, async (ctx, [id]) => {
        const user = await d.users.find(Number(id));
        if (!user) return ctx.render(v.done('❌ مشتری یافت نشد.'));
        if (d.adminIds.includes(user.chat_id)) return ctx.reply({ text: '⚠️ ادمین را نمی‌توان مسدود کرد.' });
        const status = flip(user.status);
        await d.users.setStatus(user.id, status);
        // A blocked customer loses any open conversation with the admin.
        if (status === 'disable') await d.dialogs.close(user.chat_id);
        await ctx.reply({ text: status === 'disable' ? `🚫 ${e(user.name)} مسدود شد.` : `✅ ${e(user.name)} از حالت مسدود خارج شد.` });
        await showCustomer(ctx, user.id, 0);
      })
      .callback(/^a:user:msg:(\d+)$/, async (ctx, [id]) => {
        const user = await d.users.find(Number(id));
        if (!user) return ctx.render(v.done('❌ مشتری یافت نشد.'));
        await openDialog(ctx, user.chat_id, 0, user.name);
      })

      /* ----- admin ↔ buyer dialog ----- */
      .callback(/^a:dialog:(\d+)$/, async (ctx, [id]) => {
        const order = await d.orders.find(Number(id));
        if (!order) return ctx.reply({ text: '❌ سفارش یافت نشد.' });
        const buyer = await d.users.find(order.user_id);
        await openDialog(ctx, order.user_chat_id, order.id, buyer?.name ?? '');
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

const clampPage = (page: number, total: number) => Math.max(0, Math.min(page, v.pageCount(total) - 1));
const tooLongText = (max: number) => `⚠️ متن طولانی است؛ حداکثر ${fa(max)} کاراکتر بفرستید.`;

/** Validates an edited product field; returns the problem to show, or null. */
function fieldProblem(field: EditableProductField, value: string | number): string | null {
  const max = { title: LIMITS.productTitle, description: LIMITS.productDescription, author: LIMITS.author } as Record<string, number>;
  if (typeof value === 'string' && max[field] && charCount(value) > max[field]!) return tooLongText(max[field]!);
  if (field === 'price' && Number(value) > LIMITS.maxPrice) return '⚠️ این قیمت بیش از حد بزرگ است.';
  if (field === 'inventory' && Number(value) > LIMITS.maxInventory) return `⚠️ موجودی حداکثر ${fa(LIMITS.maxInventory)} است.`;
  return null;
}

const BAD_IMAGE = '❌ تصویر دریافت نشد.\nیک <b>عکس</b> بفرستید (یا یک لینک که با https:// شروع شود).';

async function adminFlowStep(ctx: BotContext, s: Session<Data>, d: Deps): Promise<void> {
  const text = ctx.text ?? '';
  const next = (step: string, data: Data, message: string | View) =>
    d.sessions.set(ctx.chatId, s.flow, step, data).then(() => ctx.reply(typeof message === 'string' ? v.prompt(message) : message));
  const finish = (message: string) => d.sessions.clear(ctx.chatId).then(() => ctx.reply(v.done(message)));
  const needText = () => ctx.reply(v.prompt('⚠️ لطفاً یک متن ارسال کنید.'));
  const tooLong = async (max: number) => {
    if (charCount(text) <= max) return false;
    await ctx.reply(v.prompt(tooLongText(max)));
    return true;
  };

  switch (s.flow) {
    case FLOW.findCustomer: {
      if (!text) return needText();
      if (await tooLong(LIMITS.search)) return;
      await d.sessions.clear(ctx.chatId);
      return ctx.reply(v.customerSearchResults(text, await d.users.searchCustomers(text)));
    }

    case FLOW.setting: {
      if (!text) return needText();
      if (await tooLong(LIMITS.setting)) return;
      await d.settings.set(s.data.key as SettingKey, text);
      await d.sessions.clear(ctx.chatId);
      await ctx.reply({ text: '✅ تنظیمات با موفقیت به‌روزرسانی شد.' });
      return ctx.reply(v.settingsMenu());
    }

    case FLOW.faq: {
      if (!text) return needText();
      if (await tooLong(s.step === 'question' ? LIMITS.faqQuestion : LIMITS.faqAnswer)) return;
      if (s.step === 'question') return next('answer', { question: text }, FAQ_STEP(2, '✅ حالا <b>پاسخ</b> این سوال را بفرستید:'));
      await d.faqs.create(String(s.data.question), text);
      return finish(sections(heading('✅', 'سوال جدید اضافه شد'), quote(e(String(s.data.question)))));
    }

    case FLOW.category: {
      if (!text) return needText();
      if (await tooLong(s.step === 'name' ? LIMITS.categoryName : LIMITS.categoryIcon)) return;
      if (s.step === 'name') return next('icon', { name: text }, CATEGORY_STEP(2, `🎨 یک <b>ایموجی</b> برای دسته‌بندی بفرستید.\n${hint('مثال: 📚  🎧  ✨')}`));
      await d.categories.create(String(s.data.name), text);
      return finish(sections(heading('✅', 'دسته‌بندی اضافه شد'), quote(`${e(text)} <b>${e(String(s.data.name))}</b>`)));
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
        const problem = fieldProblem(field, value);
        if (problem) return ctx.reply(v.prompt(problem));
        await d.products.update(productId, field, value);
      }
      await d.sessions.clear(ctx.chatId);
      await ctx.reply({ text: `✅ ${v.PRODUCT_FIELD_LABELS[field].button} به‌روزرسانی شد.` });
      const p = (await d.products.find(productId))!;
      return ctx.reply(v.productInfo(p, p.category_id ? await d.categories.find(p.category_id) : null));
    }

    case FLOW.dialog: {
      const buyer = Number(s.data.buyerChatId);
      if (charCount(text || ctx.caption || '') > LIMITS.dialog) return ctx.reply(v.prompt(tooLongText(LIMITS.dialog)));
      const photo = ctx.update.message?.photo?.at(-1)?.file_id;
      const header = '📣 <b>پیام از پشتیبانی:</b>\n\n';
      if (photo) await ctx.sendTo(buyer, { photo, text: header + e(ctx.caption) });
      else if (text) await ctx.sendTo(buyer, { text: header + e(text) });
      else return ctx.reply(v.prompt('⚠️ فقط متن یا عکس را بفرستید.'));
      return ctx.reply({ ...v.dialogOpened(buyer, ''), text: '✅ پیام برای خریدار ارسال شد.' });
    }
  }
}

type Next = (step: string, data: Data, message: string | View) => Promise<void>;

/** title → description → price → author → inventory → image → (category button) */
async function addProductStep(ctx: BotContext, s: Session<Data>, d: Deps, text: string, next: Next): Promise<void> {
  const data = s.data;
  switch (s.step) {
    case 'title':
      if (!text) break;
      if (charCount(text) > LIMITS.productTitle) return ctx.reply(v.prompt(tooLongText(LIMITS.productTitle)));
      return next('description', { ...data, title: text }, PRODUCT_STEP(2, '💬 <b>توضیحات</b> محصول را بفرستید:'));
    case 'description':
      if (!text) break;
      if (charCount(text) > LIMITS.productDescription) return ctx.reply(v.prompt(tooLongText(LIMITS.productDescription)));
      return next('price', { ...data, description: text }, PRODUCT_STEP(3, `💰 <b>قیمت</b> را به تومان بفرستید.\n${hint('فقط عدد؛ مثال: 780000')}`));
    case 'price': {
      const price = parseAmount(text);
      if (price === null) return ctx.reply(v.prompt('❌ لطفاً قیمت را فقط به صورت عدد وارد کنید.'));
      if (fieldProblem('price', price)) return ctx.reply(v.prompt(fieldProblem('price', price)!));
      return next('author', { ...data, price }, PRODUCT_STEP(4, `${hint(`✔️ قیمت: ${money(price)} تومان`)}\n\n✍️ نام <b>نویسنده/مدرس</b> را بفرستید:`));
    }
    case 'author':
      if (!text) break;
      if (charCount(text) > LIMITS.author) return ctx.reply(v.prompt(tooLongText(LIMITS.author)));
      return next('inventory', { ...data, author: text }, PRODUCT_STEP(5, `🏷 <b>موجودی</b> انبار را بفرستید.\n${hint('فقط عدد؛ مثال: 20')}`));
    case 'inventory': {
      const inventory = parseAmount(text);
      if (inventory === null) return ctx.reply(v.prompt('❌ لطفاً موجودی را فقط به صورت عدد وارد کنید.'));
      if (fieldProblem('inventory', inventory)) return ctx.reply(v.prompt(fieldProblem('inventory', inventory)!));
      return next('image', { ...data, inventory }, PRODUCT_STEP(6, `🖼 <b>عکس</b> محصول را بفرستید (یا لینک تصویر).\n${hint('برای رد شدن - بفرستید.')}`));
    }
    case 'image': {
      const image = text === '-' ? { image_url: '', image_file_id: '' } : readImage(ctx);
      if (!image) return ctx.reply(v.prompt(BAD_IMAGE));
      const cats = await d.categories.list(true);
      if (!cats.length) {
        await d.sessions.clear(ctx.chatId);
        return ctx.reply(v.done(sections(heading('⚠️', 'دسته‌بندی فعالی وجود ندارد'), hint('اول یک دسته‌بندی بسازید، بعد محصول اضافه کنید.'))));
      }
      await d.sessions.set(ctx.chatId, s.flow, 'category', { ...data, ...image });
      return ctx.reply(
        v.categoryPicker(cats, sections(`${heading('📝', 'افزودن محصول')}\n${progress(7, PRODUCT_STEPS)}`, '📂 <b>دسته‌بندی</b> این محصول را انتخاب کنید:'), (c) => A.newProductCategory(c.id), [
          button('لغو عملیات ❌', A.cancel),
        ]),
      );
    }
    case 'category':
      return ctx.reply({ text: '👆 لطفاً دسته‌بندی را از دکمه‌های بالا انتخاب کنید.' });
  }
  await ctx.reply(v.prompt('⚠️ لطفاً یک متن ارسال کنید.'));
}
