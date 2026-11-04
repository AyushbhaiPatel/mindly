import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The production bundle must run under the daemon's CSP:
// default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'.
// No inline scripts, no CDNs, no web fonts.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
  server: {
    host: '127.0.0.1',
    port: 5178,
  },
});
