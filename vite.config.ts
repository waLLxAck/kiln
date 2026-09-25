import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { desktopDefines } from './apps/desktop/build-flags';
export default defineConfig({
  root: 'apps/desktop', base: './', plugins: [react()],
  // Build-time feature switches (Machines is "Coming soon" in public builds); see apps/desktop/build-flags.ts.
  define: desktopDefines(),
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, strictPort: true }
});
