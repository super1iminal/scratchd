import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Polling: the native watcher on Windows sometimes misses edits and serves stale modules.
  server: { proxy: { '/api': 'http://localhost:3000' }, watch: { usePolling: true, interval: 300 } },
});
