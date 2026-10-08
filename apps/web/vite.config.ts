import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const server = process.env.CAPITAL_SERVER ?? 'http://localhost:8787';

const proxy = { '/api': server, '/ws': { target: server.replace('http', 'ws'), ws: true } };

export default defineConfig({
  base: process.env.CAPITAL_BASE ?? '/',
  plugins: [
    react(),
    VitePWA({
      // 'prompt': a new build never replaces the engine mid-match; the app applies it from Home only.
      registerType: 'prompt',
      includeAssets: ['icons/icon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Capital', short_name: 'Capital', description: 'A witty financial board game of valuation, leverage and deals.',
        theme_color: '#0f1724', background_color: '#0f1724', display: 'standalone', orientation: 'any', start_url: '.',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: { globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'], navigateFallbackDenylist: [/^\/api\//, /^\/ws/] },
    }),
  ],
  server: { host: true, proxy },
  preview: { host: true, proxy },
  build: { target: 'es2022', sourcemap: false },
});
