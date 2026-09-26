/// <reference types="vite/client" />
/** The newest published release, filled in at build time by vite.config.ts. `version` is empty when GitHub could not be reached. */
declare const __KILN_RELEASE__: { version: string; page: string; assets: Record<'windows' | 'mac-arm64' | 'mac-x64' | 'appimage' | 'deb' | 'targz', string> };
