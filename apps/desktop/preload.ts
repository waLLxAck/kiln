import { contextBridge, ipcRenderer } from 'electron';
import type { RpcResponse } from '../../packages/protocol/schema';
contextBridge.exposeInMainWorld('kiln', {
  platform: process.platform,
  call: async (method: string, args: unknown = {}) => {
    const result: RpcResponse = await ipcRenderer.invoke('kiln:call', method, args);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.data;
  },
});
// Quick search's requests to the main window (`desktop.command`, validated in main.ts) arrive as a DOM event; see src/commands.ts.
ipcRenderer.on('kiln:command', (_event, detail: unknown) => window.dispatchEvent(new CustomEvent('kiln:command', { detail })));
