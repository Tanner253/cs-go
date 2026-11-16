import { defineConfig } from 'vitest/config';

// 5173 is commonly in use by other projects on this machine, so default elsewhere.
const port = Number(process.env.PORT) || 5180;

export default defineConfig({
  server: { port, strictPort: true, host: true, watch: { ignored: ['**/_reference/**'] } },
  preview: { port, strictPort: true, host: true },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 900 },
  // _reference/ holds third-party repos for reading only: never scan, bundle or test them.
  optimizeDeps: { entries: ['index.html'] },
  // The network test drives a real server on wall-clock time: run test files one at a time.
  test: { include: ['tests/**/*.test.ts'], exclude: ['_reference/**', 'node_modules/**'], fileParallelism: false },
});
