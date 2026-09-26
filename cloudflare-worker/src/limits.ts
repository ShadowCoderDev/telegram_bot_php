/**
 * Input limits. Keeping every user-typed value short guarantees the screens built from it (order
 * cards, admin alerts) stay within Telegram's message limits and can't be used to flood the admin.
 */
export const LIMITS = {
  name: 60,
  addressMin: 10,
  address: 300,
  /** One message relayed between a customer and the admin. */
  dialog: 3000,
  productTitle: 100,
  productDescription: 1500,
  author: 60,
  categoryName: 40,
  categoryIcon: 8,
  faqQuestion: 200,
  faqAnswer: 2000,
  setting: 1000,
  search: 64,
  maxPrice: 10_000_000_000,
  maxInventory: 100_000,
} as const;

/** Paid orders a customer may have waiting for review at once – stops fake-receipt spam. */
export const MAX_AWAITING_REVIEW = 3;

/** Length in characters as a person counts them (emoji = 1). */
export const charCount = (s: string): number => [...s].length;

/**
 * Per-shop caps for sellers on the platform. They keep one shop from using up the shared free-plan
 * database budget; the platform owner's own shop (plan "owner") has no caps.
 */
export const PLAN_LIMITS = {
  products: 300,
  categories: 30,
  faqs: 50,
  /** Admins added with /claim, besides the shop owner. */
  extraAdmins: 3,
} as const;

const UNLIMITED = { products: Infinity, categories: Infinity, faqs: Infinity, extraAdmins: 20 } as const;

export const planLimits = (plan: string): { products: number; categories: number; faqs: number; extraAdmins: number } =>
  plan === 'owner' ? UNLIMITED : PLAN_LIMITS;
