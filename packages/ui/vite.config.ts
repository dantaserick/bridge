import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const CORE_HTTP = 'http://127.0.0.1:4560';
const CORE_WS = 'ws://127.0.0.1:4560';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: CORE_HTTP, changeOrigin: true },
      // `/hooks` NÃO passa por aqui de propósito: só o shim local bate nessa
      // rota, e o core recusa qualquer request de hook com header `Origin`.
      // Um proxy no dev server só serviria pra um browser tentar usá-la.
      '/ws': { target: CORE_WS, ws: true },
    },
  },
});
