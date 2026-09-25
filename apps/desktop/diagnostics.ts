import fs from 'node:fs';
import path from 'node:path';
export function createDiagnostics(folder: string, maxBytes = 5 * 1024 * 1024) {
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'performance.jsonl');
  let queue = Promise.resolve();
  return {
    folder,
    log(event: string, fields: Record<string, unknown> = {}) {
      const line = JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n';
      queue = queue.then(async () => {
        const size = await fs.promises.stat(file).then(s => s.size, () => 0);
        if (size >= maxBytes) {
          await fs.promises.rm(file + '.1', { force: true });
          await fs.promises.rename(file, file + '.1');
        }
        await fs.promises.appendFile(file, line);
      }).catch(error => { console.error('Performance log unavailable:', error.code); });
    },
    flush: () => queue,
  };
}
