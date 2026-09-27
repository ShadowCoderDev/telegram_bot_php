/**
 * Test harness: the real Worker under `wrangler dev` (local D1) plus a fake Telegram Bot API that
 * serves any number of bots. Every webhook call returns what it cost in D1 (x-d1-* headers).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Call {
  token: string;
  method: string;
  params: Record<string, any>;
}

export interface Cost {
  status: number;
  queries: number;
  read: number;
  written: number;
}

export interface Harness {
  calls: Call[];
  port: number;
  post(path: string, secret: string, update: object): Promise<Cost>;
  sql(command: string): void;
  /** Runs a query on the local D1 and returns its rows. */
  query<T = Record<string, unknown>>(command: string): T[];
  /** Stops the Worker, runs `work` (e.g. bulk SQL, which a running local Worker doesn't survive), starts it again. */
  offline(work: () => void): Promise<void>;
  stop(): void;
}

let updateId = 0;
let messageId = 1000;

/**
 * fetch, sent once more if a kept-alive connection turns out to be closed: while a synchronous step
 * (`wrangler d1 execute`) blocks the event loop, the local server may close an idle connection
 * without the client noticing. The request never left, and a repeated update is skipped by the
 * Worker's redelivery check anyway.
 */
export async function send(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      // The pool may hold several such connections; each failed try discards one.
      if (attempt >= 4 || !String((err as Error).cause).includes('other side closed')) throw err;
    }
  }
}

export const msg = (chat: number, text: string) => ({
  message: { message_id: ++messageId, from: { id: chat, first_name: `U${chat}` }, chat: { id: chat, type: 'private' }, text },
});
export const press = (chat: number, data: string) => ({
  callback_query: { id: `cb${++messageId}`, from: { id: chat, first_name: `U${chat}` }, data, message: { message_id: 50, chat: { id: chat, type: 'private' } } },
});
export const photo = (chat: number, fileId: string) => ({
  message: {
    message_id: ++messageId, from: { id: chat, first_name: `U${chat}` }, chat: { id: chat, type: 'private' },
    photo: [{ file_id: fileId, file_unique_id: `u-${fileId}`, width: 9, height: 9 }],
  },
});

/** getMe answers for any token "<id>:<secret>"; ids starting 999999 are rejected as invalid. */
function fakeTelegram(calls: Call[]): Server {
  return createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url?.startsWith('/file/')) return res.end(Buffer.from([0xff, 0xd8, 0xff]));
      const [, botPart, method] = req.url!.split('/');
      const token = botPart!.slice(3);
      calls.push({ token, method: method!, params: body ? JSON.parse(body) : {} });
      let result: unknown = { message_id: ++messageId };
      if (method === 'getMe') {
        if (token.startsWith('999999')) return res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }));
        const id = Number(token.split(':')[0]);
        result = { id, is_bot: true, username: `bot${id}` };
      }
      if (method === 'getFile') result = { file_path: 'photos/x.jpg' };
      if (['setWebhook', 'deleteWebhook', 'deleteMessage', 'answerCallbackQuery'].includes(method!)) result = true;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
}

export async function startWorker(opts: { port: number; inspectorPort: number; persist: string; vars: Record<string, string>; testScheduled?: boolean }): Promise<Harness> {
  const calls: Call[] = [];
  const telegram = fakeTelegram(calls);
  await new Promise<void>((r) => telegram.listen(0, '127.0.0.1', r));
  const tgPort = (telegram.address() as AddressInfo).port;

  rmSync(opts.persist, { recursive: true, force: true });
  mkdirSync(opts.persist, { recursive: true });
  const log = openSync(`${opts.persist}/wrangler.log`, 'a'); // the Worker's console output, for debugging
  const vars = { ...opts.vars, TELEGRAM_API_BASE: `http://127.0.0.1:${tgPort}` };
  const base = `http://127.0.0.1:${opts.port}`;

  async function launch(): Promise<ChildProcess> {
    const child = spawn(
      'npx',
      [
        'wrangler', 'dev', '--port', String(opts.port), '--ip', '127.0.0.1', '--inspector-port', String(opts.inspectorPort),
        '--persist-to', opts.persist, ...(opts.testScheduled ? ['--test-scheduled'] : []),
        ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`]),
      ],
      { stdio: ['ignore', log, log], detached: true },
    );
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${base}/`)).ok) return child;
      } catch {}
      if (i > 120) throw new Error('wrangler dev did not start');
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  async function kill(child: ChildProcess) {
    if (!child.pid) return;
    const exited = new Promise((r) => child.once('exit', r));
    process.kill(-child.pid, 'SIGTERM');
    await exited;
  }
  const d1 = (args: string[]) => execFileSync('npx', ['wrangler', 'd1', 'execute', 'shop', '--local', '--persist-to', opts.persist, ...args]);

  let worker = await launch();
  return {
    calls,
    port: opts.port,
    async post(path, secret, update) {
      const res = await send(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
        body: JSON.stringify({ update_id: ++updateId, ...update }),
      });
      const n = (h: string) => Number(res.headers.get(h) ?? 0);
      return { status: res.status, queries: n('x-d1-queries'), read: n('x-d1-rows-read'), written: n('x-d1-rows-written') };
    },
    sql(command) {
      d1(['--command', command]);
    },
    query<T>(command: string): T[] {
      return JSON.parse(d1(['--json', '--command', command]).toString())[0].results as T[];
    },
    async offline(work) {
      await kill(worker);
      work();
      worker = await launch();
    },
    stop() {
      if (worker.pid) process.kill(-worker.pid, 'SIGTERM');
      telegram.close();
    },
  };
}
