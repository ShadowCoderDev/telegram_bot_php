#!/usr/bin/env node
/**
 * One-command, idempotent deploy: `npm run deploy`
 *
 *   1. Cloudflare login (browser locally, CLOUDFLARE_API_TOKEN in CI)
 *   2. D1 database: found by name or created           → no database_id to copy around
 *   3. R2 bucket: created if possible, skipped if R2 isn't enabled on the account
 *   4. D1 migrations applied
 *   5. Worker deployed together with its secrets (BOT_TOKEN, WEBHOOK_SECRET)
 *   6. Telegram webhook pointed at the Worker
 *
 * Safe to run again at any time; every step checks what already exists.
 *
 * Without BOT_TOKEN and without a terminal (e.g. Cloudflare Workers Builds after the "Deploy to
 * Cloudflare" button) it only deploys the code: the Worker creates its tables itself and registers
 * the webhook when its URL is opened.
 *
 * Inputs (env vars; asked interactively when missing and a terminal is attached):
 *   PLATFORM_BOT_TOKEN  SaaS: the shop-builder bot    MASTER_KEY  SaaS: 32+ chars, never change it
 *   PLATFORM_ADMIN_IDS  optional: platform admins (or /claim <MASTER_KEY> in the platform bot)
 *   BOT_TOKEN        optional: your own shop's bot (at least one of the two tokens is required)
 *   WEBHOOK_SECRET   optional  generated when absent (the webhook is re-registered with it every run)
 *   ADMIN_CHAT_IDS   optional  overrides the value in wrangler.jsonc (sellers can also use /claim)
 *   WORKER_NAME      optional  deploy under another name (several sellers in one Cloudflare account)
 *   WORKER_URL       optional  public URL when not using *.workers.dev (custom domain)
 *   SKIP_R2=1        optional  don't use R2 even if it is available
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

process.chdir(new URL('..', import.meta.url).pathname);

const WRANGLER = process.env.WRANGLER_BIN ?? 'node_modules/.bin/wrangler';
const TELEGRAM = process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org';
const GENERATED_CONFIG = 'wrangler.deploy.json';
const interactive = process.stdin.isTTY && !process.env.CI;

const step = (n, msg) => console.log(`\n\x1b[1m[${n}/6] ${msg}\x1b[0m`);
const ok = (msg) => console.log(`  ✔ ${msg}`);
const warn = (msg) => console.log(`  ⚠ ${msg}`);
const fail = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};

/** Runs wrangler non-interactively. `out` is stdout+stderr for messages, `stdout` alone for JSON. */
function wrangler(args, { inherit = false } = {}) {
  const r = spawnSync(WRANGLER, args, {
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
    env: { ...process.env, CI: inherit ? process.env.CI : 'true', WRANGLER_SEND_METRICS: 'false' },
  });
  return { ok: r.status === 0, stdout: r.stdout ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
function wranglerOrDie(args, what) {
  const r = wrangler(args);
  if (!r.ok) fail(`${what} failed:\n${r.out}`);
  return r;
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function telegram(token, method, params = {}) {
  const res = await fetch(`${TELEGRAM}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json();
}

/** wrangler.jsonc only has whole-line // comments, so dropping those lines is enough to parse it. */
const readConfig = () => JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''));

async function main() {
  const config = readConfig();
  if (process.env.WORKER_NAME) {
    config.name = process.env.WORKER_NAME;
    config.d1_databases = config.d1_databases?.map((db) => ({ ...db, database_name: `${process.env.WORKER_NAME}-db` }));
  }
  if (!process.env.BOT_TOKEN && !process.env.PLATFORM_BOT_TOKEN && !interactive) {
    console.log('No bot token in a non-interactive build: deploying code only.');
    const r = wrangler(['deploy'], { inherit: true });
    if (!r.ok) fail('wrangler deploy failed');
    console.log('\n✅ Deployed. Open the Worker URL once to finish setup (webhook + admin instructions).');
    return;
  }
  const d1 = config.d1_databases?.[0];
  const r2 = config.r2_buckets?.[0];
  if (!d1) fail('wrangler.jsonc has no d1_databases entry');

  /* ---------- 1. auth + inputs ---------- */
  step(1, 'Cloudflare account & bot tokens');
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    if (/not authenticated/i.test(wrangler(['whoami']).out)) {
      if (!interactive) fail('Set CLOUDFLARE_API_TOKEN (see README) or run this in a terminal to log in.');
      console.log('  Opening the browser to log in to Cloudflare…');
      if (!wrangler(['login'], { inherit: true }).ok) fail('wrangler login failed');
    }
  }
  const who = wrangler(['whoami']);
  if (!who.ok || /not authenticated/i.test(who.out)) fail(`Cloudflare authentication failed:\n${who.out}`);
  ok('logged in to Cloudflare');

  // Two bots can run in one deployment; at least one is required:
  //   the SaaS platform bot (PLATFORM_BOT_TOKEN + MASTER_KEY) and/or your own shop (BOT_TOKEN + WEBHOOK_SECRET).
  const secrets = {};
  const input = async (name, question) => process.env[name]?.trim() || (interactive ? await ask(question) : '');

  const platformToken = await input('PLATFORM_BOT_TOKEN', '  Platform bot token (the shop-builder bot; Enter to skip): ');
  if (platformToken) {
    const me = await telegram(platformToken, 'getMe');
    if (!me.ok) fail(`Telegram rejected PLATFORM_BOT_TOKEN: ${me.description}`);
    ok(`platform bot @${me.result.username}`);
    secrets.PLATFORM_BOT_TOKEN = platformToken;
    let masterKey = process.env.MASTER_KEY?.trim();
    if (!masterKey && interactive) {
      masterKey = randomBytes(32).toString('hex');
      warn(`Generated MASTER_KEY – store it safely and NEVER change it (sellers' tokens are encrypted with it):\n    ${masterKey}`);
    }
    if (masterKey) {
      if (masterKey.length < 32) fail('MASTER_KEY must be at least 32 characters');
      secrets.MASTER_KEY = masterKey;
    } else {
      // Secrets are additive: a MASTER_KEY uploaded by an earlier deploy stays in place.
      warn('MASTER_KEY not provided – keeping the one already on the Worker (set it once, never change it).');
    }
  }

  const botToken = await input('BOT_TOKEN', '  Your own shop bot token (Enter to skip): ');
  if (botToken) {
    const me = await telegram(botToken, 'getMe');
    if (!me.ok) fail(`Telegram rejected BOT_TOKEN: ${me.description}`);
    ok(`own shop bot @${me.result.username}`);
    const webhookSecret = process.env.WEBHOOK_SECRET?.trim() || randomBytes(32).toString('hex');
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret)) fail('WEBHOOK_SECRET must be 16+ characters of A-Z a-z 0-9 _ -');
    if (!process.env.WEBHOOK_SECRET) {
      // Never print secrets into CI logs; a generated one changes every run anyway.
      if (interactive) warn(`Generated WEBHOOK_SECRET – keep it, it is the /claim code of your shop: ${webhookSecret}`);
      else warn('WEBHOOK_SECRET is not set: a new one is generated each deploy, so /claim needs ADMIN_CHAT_IDS or a fixed secret.');
    }
    Object.assign(secrets, { BOT_TOKEN: botToken, WEBHOOK_SECRET: webhookSecret });
  }
  if (!platformToken && !botToken) fail('Set PLATFORM_BOT_TOKEN (SaaS platform) and/or BOT_TOKEN (your own shop).');

  const adminIds = process.env.ADMIN_CHAT_IDS?.trim() || config.vars?.ADMIN_CHAT_IDS || '';
  const platformAdminIds = process.env.PLATFORM_ADMIN_IDS?.trim() || config.vars?.PLATFORM_ADMIN_IDS || '';
  if (platformToken) {
    if (platformAdminIds) ok(`platform admins: ${platformAdminIds}`);
    else warn('PLATFORM_ADMIN_IDS is empty – send `/claim <MASTER_KEY>` to the platform bot to become its admin.');
  }

  /* ---------- 2. D1 ---------- */
  step(2, `D1 database "${d1.database_name}"`);
  const findDb = () =>
    JSON.parse(wranglerOrDie(['d1', 'list', '--json'], 'listing D1 databases').stdout).find(
      (db) => db.name === d1.database_name,
    );
  let db = findDb();
  if (db) ok(`exists (${db.uuid})`);
  else {
    wranglerOrDie(['d1', 'create', d1.database_name], 'creating the D1 database');
    db = findDb();
    if (!db) fail('D1 database was created but could not be found');
    ok(`created (${db.uuid})`);
  }

  /* ---------- 3. R2 ---------- */
  step(3, 'R2 bucket (optional)');
  let useR2 = Boolean(r2) && !process.env.SKIP_R2;
  if (useR2) {
    const r = wrangler(['r2', 'bucket', 'create', r2.bucket_name]);
    if (r.ok) ok(`created "${r2.bucket_name}"`);
    else if (/already exists|already own/i.test(r.out)) ok(`exists "${r2.bucket_name}"`);
    else if (/enable R2|10042|payment/i.test(r.out)) {
      useR2 = false;
      warn('R2 is not enabled on this Cloudflare account – continuing without it.');
      warn('Everything still works: receipts and product photos are kept as Telegram file ids. R2 only archives receipts.');
    } else fail(`creating the R2 bucket failed:\n${r.out}`);
  } else ok('skipped');

  // Deploy from a generated config so wrangler.jsonc never needs hand-edited ids.
  const deployConfig = {
    ...config,
    d1_databases: [{ ...d1, database_id: db.uuid }],
    vars: { ...config.vars, ADMIN_CHAT_IDS: adminIds, PLATFORM_ADMIN_IDS: platformAdminIds },
  };
  delete deployConfig.$schema;
  if (!useR2) delete deployConfig.r2_buckets;
  writeFileSync(GENERATED_CONFIG, JSON.stringify(deployConfig, null, 2));

  /* ---------- 4. migrations ---------- */
  step(4, 'Database migrations');
  const migrated = wranglerOrDie(['d1', 'migrations', 'apply', d1.database_name, '--remote', '-c', GENERATED_CONFIG], 'applying migrations');
  ok(/No migrations to apply/i.test(migrated.out) ? 'already up to date' : 'applied');

  /* ---------- 5. deploy ---------- */
  step(5, `Deploying Worker "${config.name}"`);
  const secretsDir = mkdtempSync(join(tmpdir(), 'bot-secrets-'));
  const secretsFile = join(secretsDir, 'secrets.json');
  let deployOut;
  try {
    writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
    deployOut = wranglerOrDie(['deploy', '-c', GENERATED_CONFIG, '--secrets-file', secretsFile], 'wrangler deploy').out;
  } finally {
    rmSync(secretsDir, { recursive: true, force: true });
  }
  const url = (process.env.WORKER_URL || deployOut.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0] || '').replace(/\/$/, '');
  if (!url) {
    fail(
      'Deployed, but no *.workers.dev URL was reported. Open Workers & Pages in the Cloudflare dashboard once to ' +
        'register your workers.dev subdomain (or set WORKER_URL to a custom domain), then run this again.',
    );
  }
  ok(url);

  /* ---------- 6. webhooks ---------- */
  // Opening the Worker's status page connects every configured bot's webhook (src/setup.ts).
  step(6, 'Telegram webhooks');
  let status;
  for (let i = 0; i < 10 && !status?.ok; i++) {
    status = await fetch(url).then(async (r) => ({ ok: r.ok, body: await r.text() }), () => undefined);
    if (!status?.ok) await new Promise((r) => setTimeout(r, 3000));
  }
  if (status?.ok) ok('bots connected');
  else warn(`Setup is not complete yet – open ${url} in a browser to see what is missing.`);

  console.log(`\n✅ Done. Status page: ${url}`);
}

main().catch((err) => fail(err?.stack ?? String(err)));
