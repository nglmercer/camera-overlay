import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'web',
  server: {
    proxy: {
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
      '/settings': 'http://localhost:8080',
      '/cameras': 'http://localhost:8080',
      '/status': 'http://localhost:8080',
      '/start': 'http://localhost:8080',
      '/stop': 'http://localhost:8080',
    },
  },
  build: {
    outDir: '../static',
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'web/index.html'),
        config: resolve(__dirname, 'web/config.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
