import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:18031', ws: true },
      '/api': 'http://127.0.0.1:18031',
    },
  },
  build: {
    target: 'es2022',
    manifest: true,
    rollupOptions: {
      // Deux entrées : le shell (index.html) et le monde, chargé dynamiquement par URL
      // => une modif du monde ne change que son fichier, le shell reste en place (hot-swap).
      input: { index: 'index.html', world: 'src/client/world/world.ts' },
      preserveEntrySignatures: 'exports-only',
      output: { manualChunks: { three: ['three'] } },
    },
  },
});
