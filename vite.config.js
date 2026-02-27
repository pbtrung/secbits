import fs from 'fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LEANCRYPTO_SERVE = ['leancrypto.js', 'leancrypto.wasm'];

function leancryptoPlugin() {
  let outDir;
  return {
    name: 'leancrypto',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    // Dev: serve leancrypto/ at /leancrypto/*
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const prefix = '/leancrypto/';
        if (!req.url?.startsWith(prefix)) return next();
        const file = req.url.slice(prefix.length).split('?')[0];
        if (!LEANCRYPTO_SERVE.includes(file)) return next();
        const filePath = path.resolve(__dirname, 'leancrypto', file);
        if (!fs.existsSync(filePath)) return next();
        const mime = file.endsWith('.wasm') ? 'application/wasm' : 'application/javascript';
        res.setHeader('Content-Type', mime);
        fs.createReadStream(filePath).pipe(res);
      });
    },
    // Build: copy leancrypto.js + leancrypto.wasm to dist/leancrypto/
    closeBundle() {
      if (!outDir) return;
      const destDir = path.resolve(__dirname, outDir, 'leancrypto');
      fs.mkdirSync(destDir, { recursive: true });
      for (const file of LEANCRYPTO_SERVE) {
        fs.copyFileSync(
          path.resolve(__dirname, 'leancrypto', file),
          path.join(destDir, file),
        );
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [wasm(), react(), leancryptoPlugin()],
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
      '/leancrypto/leancrypto.js': path.resolve(__dirname, 'leancrypto/leancrypto.js'),
      'brotli-wasm': path.resolve(__dirname, 'node_modules/brotli-wasm/index.node.js'),
    },
    server: {
      deps: {
        external: [/leancrypto/],
      },
    },
  },
}));
