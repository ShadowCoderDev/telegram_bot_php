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
