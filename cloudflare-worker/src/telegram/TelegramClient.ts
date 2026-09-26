import type { ReplyMarkup } from './types';

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
  ) {
    super(`Telegram ${method} failed (${code}): ${description}`);
  }
}

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

type Params = Record<string, unknown>;

/**
 * Thin, typed wrapper over the Bot API using fetch – the Worker replacement for Telegram.php + cURL.
 */
export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly apiBase = 'https://api.telegram.org',
  ) {}

  async call<T = unknown>(method: string, params: Params = {}): Promise<T> {
    const res = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const body = (await res.json()) as ApiResponse<T>;
    if (!body.ok) throw new TelegramApiError(method, body.error_code ?? res.status, body.description ?? 'unknown');
    return body.result as T;
  }

  sendMessage(chatId: number, text: string, markup?: ReplyMarkup) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: markup,
      link_preview_options: { is_disabled: false, prefer_large_media: true, show_above_text: true },
    });
  }

  editMessageText(chatId: number, messageId: number, text: string, markup?: ReplyMarkup) {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: markup,
      link_preview_options: { is_disabled: false, prefer_large_media: true, show_above_text: true },
    });
  }

  /** `photo` may be a file_id or an https URL – no multipart upload needed. */
  sendPhoto(chatId: number, photo: string, caption?: string, markup?: ReplyMarkup) {
    return this.call('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', reply_markup: markup });
  }

  deleteMessage(chatId: number, messageId: number) {
    return this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  answerCallbackQuery(id: string, text?: string) {
    return this.call('answerCallbackQuery', { callback_query_id: id, text });
  }

  setWebhook(url: string, secretToken: string) {
    return this.call('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    });
  }

  /** Downloads a file sent to the bot. Returns the bytes and the path Telegram stored it under. */
  async downloadFile(fileId: string): Promise<{ body: ArrayBuffer; path: string }> {
    const file = await this.call<{ file_path?: string }>('getFile', { file_id: fileId });
    if (!file.file_path) throw new Error('Telegram returned no file_path');
    const res = await fetch(`${this.apiBase}/file/bot${this.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`File download failed: ${res.status}`);
    return { body: await res.arrayBuffer(), path: file.file_path };
  }
}
