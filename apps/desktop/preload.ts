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
