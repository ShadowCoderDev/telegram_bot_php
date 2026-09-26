export type Toggle = 'enable' | 'disable';
export type OrderStatus = 'pending' | 'payed' | 'approved' | 'rejected' | 'cancel' | 'sending';

export interface UserRow {
  id: number;
  chat_id: number;
  name: string;
  username: string;
  /** 'disable' = blocked by an admin. */
  status: Toggle;
  created_at: number;
}

/** A customer row with purchase statistics, for the admin's customer list. */
export interface CustomerSummary extends UserRow {
  orders_count: number;
  /** Sum of approved and sent orders. */
  total_spent: number;
  /** Orders paid but not yet reviewed by an admin. */
  awaiting_review: number;
  last_activity: number;
}

export interface Category {
  id: number;
  name: string;
  icon: string;
  status: Toggle;
}

export interface Product {
  id: number;
  category_id: number | null;
  title: string;
  description: string;
  price: number;
  author: string;
  /** Link given by the admin (shown as a link preview). */
  image_url: string;
  /** Photo uploaded by the admin, stored by Telegram. Takes precedence over image_url. */
  image_file_id: string;
  inventory: number;
  status: Toggle;
}

export interface Order {
  id: number;
  user_id: number;
  user_chat_id: number;
  track_id: string;
  status: OrderStatus;
  stock_taken: number;
  time: number;
}

/** A cart/order line joined with its product. Price/title come from the snapshot once paid. */
export interface OrderLine {
  item_id: number;
  product_id: number;
  quantity: number;
  title: string;
  price: number;
  inventory: number;
  /** 1 when the product is still for sale (product and its category enabled). */
  available: number;
}

export interface OrderDetails {
  order_id: number;
  first_name: string;
  last_name: string;
  address: string;
  phone_number: string;
  receipt_file_id: string | null;
  receipt_r2_key: string | null;
  /** Telegram file_unique_id of the receipt photo; one receipt can back only one order. */
  receipt_unique_id: string | null;
}

export interface Faq {
  id: number;
  question: string;
  answer: string;
  status: Toggle;
}

export interface Session<D = Record<string, unknown>> {
  chat_id: number;
  flow: string;
  step: string;
  data: D;
}

export interface Dialog {
  buyer_chat_id: number;
  admin_chat_id: number;
  order_id: number;
}

export const flip = (s: Toggle): Toggle => (s === 'enable' ? 'disable' : 'enable');
