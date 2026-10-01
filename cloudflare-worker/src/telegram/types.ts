// Only the slice of the Bot API this bot touches.

export interface User {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface PhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
}

export interface Document {
  file_id: string;
  file_unique_id: string;
  mime_type?: string;
  file_name?: string;
}

export interface Message {
  message_id: number;
  from?: User;
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  photo?: PhotoSize[];
  document?: Document;
}

export interface CallbackQuery {
  id: string;
  from: User;
  message?: Message;
  data?: string;
}

/** Someone typing "@bot something" in any chat. */
export interface InlineQuery {
  id: string;
  from: User;
  query: string;
  offset: string;
}

export interface Update {
  update_id: number;
  message?: Message;
  callback_query?: CallbackQuery;
  inline_query?: InlineQuery;
}

/** Button colour (Bot API 9.4+); older apps ignore it and show the default style. */
export type ButtonStyle = 'primary' | 'success' | 'danger';

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
  style?: ButtonStyle;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface ReplyKeyboardMarkup {
  keyboard: { text: string }[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  is_persistent?: boolean;
}

export type ReplyMarkup = InlineKeyboardMarkup | ReplyKeyboardMarkup;

/** What every screen of the bot boils down to. Views are pure functions returning this. */
export interface View {
  text: string;
  keyboard?: ReplyMarkup;
  /** When set, the view is shown as a photo with `text` as caption. */
  photo?: string;
}
