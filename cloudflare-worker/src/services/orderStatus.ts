import type { Order, OrderStatus } from '../db/models';

export type AdminOrderAction = 'approve' | 'reject' | 'send';

export interface Transition {
  status: OrderStatus;
  stock: 'take' | 'return' | 'keep';
}

const TARGET: Record<AdminOrderAction, OrderStatus> = { approve: 'approved', reject: 'rejected', send: 'sending' };

/** Which admin actions are valid from each status – also drives which buttons are shown. */
export const ALLOWED_ACTIONS: Record<OrderStatus, AdminOrderAction[]> = {
  pending: [],
  payed: ['approve', 'reject'],
  approved: ['send', 'reject'],
  rejected: ['approve'],
  sending: [],
  cancel: [],
};

/**
 * Pure decision: what an admin action does to an order. Stock leaves the warehouse on approval
 * and comes back if an approved order is rejected, so approve → reject → approve never
 * double-counts (the PHP version decremented on every approval).
 */
export function planTransition(order: Pick<Order, 'status' | 'stock_taken'>, action: AdminOrderAction): Transition | null {
  if (!ALLOWED_ACTIONS[order.status].includes(action)) return null;
  const status = TARGET[action];
  if (status === 'approved' && !order.stock_taken) return { status, stock: 'take' };
  if (status === 'rejected' && order.stock_taken) return { status, stock: 'return' };
  return { status, stock: 'keep' };
}

export const STATUS_FA: Record<OrderStatus, string> = {
  pending: 'در انتظار پرداخت',
  payed: '✅ پرداخت شده - در انتظار تایید',
  approved: '✔️ تایید شده',
  rejected: '❌ رد شده',
  cancel: '🚫 لغو شده',
  sending: '📤 ارسال شده',
};
