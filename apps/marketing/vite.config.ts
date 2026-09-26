import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { fallbackRelease, latestRelease } from './latest-release.mjs';

/** Where the site is served from. GitHub Pages serves it at /kiln/, so its workflow builds with BASE_PATH=/kiln/. */
const base = `/${(process.env.BASE_PATH ?? '/').replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
const page = (file: string) => fileURLToPath(new URL(file, import.meta.url));

export default defineConfig(async () => {
  // The download links come from the newest published release. CI must not publish a site without them; a local build falls back
  // to the latest-release page so it still works offline.
  const release = await latestRelease().catch((error: unknown) => {
    if (process.env.CI) throw error;
    console.warn(`Using the latest-release page for downloads: ${error instanceof Error ? error.message : error}`);
    return fallbackRelease();
  });
  return {
    base,
    define: { __KILN_RELEASE__: JSON.stringify(release) },
    build: {
      outDir: '../../dist/marketing',
      emptyOutDir: true,
      rollupOptions: { input: { home: page('./index.html'), support: page('./support/index.html') } },
    },
    server: { port: 5174, strictPort: true },
  };
});
