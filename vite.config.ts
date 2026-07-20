import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  build: {
    rollupOptions: {
      output: {
        // @vercel/analytics 的套件 entry 是 index.mjs，動態 import 產生的 chunk 預設也叫
        // index-*.js，會與主 bundle 撞名（主 bundle 靠「恰一支 index-*.js」被識別）。
        // 明確命名為 analytics chunk：主 bundle 維持唯一可識別，analytics 亦不佔主 bundle 預算。
        manualChunks(id) {
          if (id.includes('@vercel/analytics')) return 'analytics';
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    exclude: ['e2e/**', ...configDefaults.exclude],
  },
});
