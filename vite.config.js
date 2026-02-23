import fs from 'fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function excludeLeancryptoDevFiles() {
  let outDir;
  return {
    name: 'exclude-leancrypto-devfiles',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const dir = path.resolve(__dirname, outDir, 'leancrypto');
      if (!fs.existsSync(dir)) return;
      for (const file of fs.readdirSync(dir)) {
        if (file.endsWith('.md') || file.endsWith('.test.js')) {
          fs.rmSync(path.join(dir, file));
        }
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [wasm(), react(), excludeLeancryptoDevFiles()],
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
    ],
    alias: {
      '/leancrypto/leancrypto.js': path.resolve(__dirname, 'public/leancrypto/leancrypto.js'),
      'brotli-wasm': path.resolve(__dirname, 'node_modules/brotli-wasm/index.node.js'),
    },
    server: {
      deps: {
        external: [/leancrypto/],
      },
    },
  },
}));
