import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electron from 'electron';
import os from 'node:os';
import path from 'node:path';
await import('./build.mjs');
const server = await createServer();
await server.listen();
const child = spawn(electron, ['.'], { stdio: 'inherit', // Own desktop profile, so the dev instance can run beside the installed Kiln (Electron allows one instance per profile). The library is still the one selected in ~/.kiln.
  env: { ...process.env, KILN_DEV_URL: 'http://127.0.0.1:5173', KILN_DESKTOP_DATA: process.env.KILN_DESKTOP_DATA ?? path.join(os.tmpdir(), 'kiln-dev-profile') } });
child.on('exit', async code => { await server.close(); process.exit(code ?? 0); });
process.on('SIGINT', () => child.kill());
