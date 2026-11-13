import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.PW_DEV_API_PORT || '18787';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/ui',
    emptyOutDir: true
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false
      }
    }
  }
});
