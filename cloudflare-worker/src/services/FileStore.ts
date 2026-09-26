import type { TelegramClient } from '../telegram/TelegramClient';

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * R2-backed replacement for the local uploads/ directory. Files are served back by the Worker
 * at /files/<key>, which gives product images the public URL the old $BASE_PUBLIC_URL provided.
 */
export class FileStore {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly tg: TelegramClient,
    private readonly publicOrigin: string,
  ) {}

  /** Copies a Telegram file into R2 and returns its key. */
  async saveTelegramFile(fileId: string, folder: 'receipts' | 'products'): Promise<string> {
    const { body, path } = await this.tg.downloadFile(fileId);
    const ext = (path.split('.').pop() ?? 'jpg').toLowerCase();
    const key = `${folder}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
    await this.bucket.put(key, body, { httpMetadata: { contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream' } });
    return key;
  }

  publicUrl(key: string): string {
    return `${this.publicOrigin}/files/${key}`;
  }

  /** Handles GET /files/<key>. Only product images are public; receipts stay private. */
  async serve(key: string): Promise<Response> {
    if (!key.startsWith('products/')) return new Response('Not found', { status: 404 });
    const obj = await this.bucket.get(key);
    if (!obj) return new Response('Not found', { status: 404 });
    const headers = new Headers({ 'cache-control': 'public, max-age=86400' });
    obj.writeHttpMetadata(headers);
    return new Response(obj.body, { headers });
  }
}
