import type { ButtonStyle, InlineKeyboardButton, InlineKeyboardMarkup, ReplyKeyboardMarkup } from './types';

// Pure builders – no I/O, trivially testable.

/** `style` colours the button: primary = blue, success = green, danger = red. */
export const button = (text: string, data: string, style?: ButtonStyle): InlineKeyboardButton => {
  // Telegram rejects callback_data over 64 bytes; fail loudly in dev instead of silently in prod.
  if (new TextEncoder().encode(data).length > 64) throw new Error(`callback_data too long: ${data}`);
  return style ? { text, callback_data: data, style } : { text, callback_data: data };
};

export const inline = (...rows: InlineKeyboardButton[][]): InlineKeyboardMarkup => ({ inline_keyboard: rows });

export const replyKeyboard = (rows: string[][]): ReplyKeyboardMarkup => ({
  keyboard: rows.map((row) => row.map((text) => ({ text }))),
  resize_keyboard: true,
  is_persistent: true,
});

export const backRow = (data: string, label = 'بازگشت 🔙'): InlineKeyboardButton[] => [button(label, data)];
