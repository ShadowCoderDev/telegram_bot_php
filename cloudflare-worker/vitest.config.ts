import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Load migrations/*.sql as text, like the "Text" rule in wrangler.jsonc does for the Worker bundle.
  plugins: [{ name: 'sql-as-text', transform: (code, id) => (id.endsWith('.sql') ? `export default ${JSON.stringify(code)};` : undefined) }],
  test: { include: ['test/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 120_000 },
});
