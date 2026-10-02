// Renders promo.json to MP4: node render.mjs [vertical|landscape|all] [--still t]  (frames are stepped, so output is exact)
import { chromium } from 'playwright-core';
import ffmpeg from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const spec = JSON.parse(readFileSync('promo.json', 'utf8'));
const arg = process.argv[2] ?? 'all';
const stillAt = process.argv.includes('--still') ? Number(process.argv[process.argv.indexOf('--still') + 1]) : null;
const formats = spec.meta.formats.filter((f) => arg === 'all' || f.name === arg);
mkdirSync('out', { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--force-device-scale-factor=1'] });
for (const fmt of formats) {
  const page = await browser.newPage({ viewport: { width: fmt.width, height: fmt.height } });
  await page.goto('file://' + resolve('player.html'));
  await page.evaluate(() => document.fonts.ready);
  const total = await page.evaluate(([s, f]) => window.init(s, f), [spec, fmt]);
  if (stillAt !== null) {
    await page.evaluate((t) => window.renderAt(t), stillAt);
    await page.screenshot({ path: `out/still-${fmt.name}.png` });
    console.log('still', fmt.name, stillAt);
    continue;
  }
  const frames = Math.round(total * fmt.fps);
  const file = `out/xigen-promo-${fmt.name}.mp4`;
  const ff = spawn(ffmpeg, ['-y', '-f', 'image2pipe', '-framerate', String(fmt.fps), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', '-movflags', '+faststart', file], { stdio: ['pipe', 'ignore', 'inherit'] });
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => window.renderAt(t), i / fmt.fps);
    const buf = await page.screenshot({ type: 'jpeg', quality: 93 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 150 === 0) console.log(fmt.name, `${i}/${frames}`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  console.log('wrote', file);
}
await browser.close();
