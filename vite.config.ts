import { configDefaults, defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * dev-only 建置信標端點：`/__build-id` 每次請求現算 git HEAD（不能用 define 常數——
 * 那在 config 載入時就凍結，dev server 跨 commit 續跑時會回報舊 hash，信標自己變 stale）。
 * dirty 判定只看已追蹤檔（untracked 探針/筆記不該讓信標長期掛 `*`）。
 */
function devBuildBeacon(): Plugin {
  return {
    name: 'dev-build-beacon',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__build-id', (_req, res) => {
        let hash = 'no-git';
        try {
          const opts = { cwd: __dirname, encoding: 'utf8' as const };
          hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], opts).trim();
          const dirty = execFileSync(
            'git',
            ['status', '--porcelain', '--untracked-files=no'],
            opts,
          ).trim();
          if (dirty) hash += '*';
        } catch {
          hash = 'no-git';
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ hash }));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), devBuildBeacon()],
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
