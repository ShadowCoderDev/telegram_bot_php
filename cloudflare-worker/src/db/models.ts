export type Toggle = 'enable' | 'disable';
export type OrderStatus = 'pending' | 'payed' | 'approved' | 'rejected' | 'cancel' | 'sending';

export interface UserRow {
  id: number;
  chat_id: number;
  name: string;
  status: Toggle;
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
  image_url: string;
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
}

export interface OrderDetails {
  order_id: number;
  first_name: string;
  last_name: string;
  address: string;
  phone_number: string;
  receipt_file_id: string | null;
  receipt_r2_key: string | null;
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
