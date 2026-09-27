/**
 * What a customer is asked for at checkout. Each seller chooses in the admin settings: a shop that
 * sells courses may need only a name, one that delivers needs all three.
 */
export const CHECKOUT_FIELDS = ['name', 'address', 'phone'] as const;
export type CheckoutField = (typeof CHECKOUT_FIELDS)[number];

/** Stored as "name,address,phone"; never set = all three (the old behaviour). */
export function parseCheckoutFields(raw: string | null): CheckoutField[] {
  if (raw === null) return [...CHECKOUT_FIELDS];
  const chosen = raw.split(',');
  return CHECKOUT_FIELDS.filter((f) => chosen.includes(f));
}

export const toggleCheckoutField = (fields: CheckoutField[], field: CheckoutField): string =>
  CHECKOUT_FIELDS.filter((f) => (f === field ? !fields.includes(f) : fields.includes(f))).join(',');
