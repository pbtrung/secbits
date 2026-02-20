import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [wasm(), react()],
  publicDir: mode === 'test' ? false : 'public',
  optimizeDeps: {
    exclude: ['brotli-wasm'],
  },
  build: {
    rollupOptions: {
      external: ['/leancrypto/leancrypto.js'],
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: [
      'src/**/*.test.{js,ts}',
      'public/leancrypto/leancrypto.test.js',
    ],
    alias: {
      '/leancrypto/leancrypto.js': path.resolve(__dirname, 'public/leancrypto/leancrypto.js'),
    },
    server: {
      deps: {
        external: [/leancrypto/],
      },
    },
  },
}));
