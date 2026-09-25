import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/** Where the site is served from. GitHub Pages serves it at /kiln/, so its workflow builds with BASE_PATH=/kiln/. */
const base = `/${(process.env.BASE_PATH ?? '/').replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
const page = (file: string) => fileURLToPath(new URL(file, import.meta.url));

export default defineConfig({
  base,
  build: {
    outDir: '../../dist/marketing',
    emptyOutDir: true,
    rollupOptions: { input: { home: page('./index.html'), support: page('./support/index.html') } },
  },
  server: { port: 5174, strictPort: true },
});
