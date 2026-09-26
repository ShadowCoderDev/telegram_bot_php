import { TelegramApiError, type TelegramClient } from './TelegramClient';
import type { Update, View } from './types';

const PHOTO_CAPTION_LIMIT = 1024;

/**
 * Everything a handler needs to know about the current update, plus helpers to respond.
 * Replaces the PHP globals ($chat_id, $text, $mesasge_id, $resultTelegram ...).
 */
export class BotContext {
  readonly chatId: number;
  readonly firstName: string;
  readonly text: string | undefined;
  readonly callbackData: string | undefined;
  /** message_id of the message whose button was pressed (only for callbacks). */
  readonly callbackMessageId: number | undefined;
  readonly isAdmin: boolean;

  constructor(
    readonly update: Update,
    readonly tg: TelegramClient,
    adminIds: readonly number[] = [],
  ) {
    const cb = update.callback_query;
    const msg = update.message ?? cb?.message;
    const from = cb?.from ?? update.message?.from;
    this.chatId = msg?.chat.id ?? from?.id ?? 0;
    this.firstName = from?.first_name ?? '';
    this.text = update.message?.text?.trim();
    this.callbackData = cb?.data;
    this.callbackMessageId = cb?.message?.message_id;
    this.isAdmin = adminIds.includes(this.chatId);
  }

  get isCallback(): boolean {
    return this.update.callback_query !== undefined;
  }

  get caption(): string | undefined {
    return this.update.message?.caption;
  }

  /** file_id of an image sent as photo or as an image document; mirrors extractImageFileIdFromMessage(). */
  get imageFileId(): string | undefined {
    const msg = this.update.message;
    if (!msg) return undefined;
    if (msg.photo?.length) return msg.photo[msg.photo.length - 1]!.file_id;
    if (msg.document?.mime_type?.startsWith('image/')) return msg.document.file_id;
    return undefined;
  }

  /** Always sends a new message. */
  reply(view: View): Promise<void> {
    return this.sendTo(this.chatId, view);
  }

  /**
   * Edits the pressed message in place when possible (smooth inline navigation), otherwise sends a new one.
   * Photos can't be edited into text, so those are replaced.
   */
  async render(view: View): Promise<void> {
    const messageId = this.callbackMessageId;
    if (messageId === undefined || view.photo || view.keyboard && 'keyboard' in view.keyboard) {
      return this.reply(view);
    }
    try {
      await this.tg.editMessageText(this.chatId, messageId, view.text, view.keyboard);
    } catch (err) {
      if (!(err instanceof TelegramApiError)) throw err;
      // "message is not modified" is harmless; anything else (e.g. the message is a photo) → send fresh.
      if (err.description.includes('message is not modified')) return;
      await this.tg.deleteMessage(this.chatId, messageId).catch(() => {});
      await this.reply(view);
    }
  }

  /** Sends to any chat (admin notifications, buyer dialog). */
  async sendTo(chatId: number, view: View): Promise<void> {
    if (!view.photo) {
      await this.tg.sendMessage(chatId, view.text, view.keyboard);
    } else if (view.text.length <= PHOTO_CAPTION_LIMIT) {
      await this.tg.sendPhoto(chatId, view.photo, view.text, view.keyboard);
    } else {
      // Captions are capped at 1024 chars: send the photo bare, then the text with the buttons.
      await this.tg.sendPhoto(chatId, view.photo);
      await this.tg.sendMessage(chatId, view.text, view.keyboard);
    }
  }
}
