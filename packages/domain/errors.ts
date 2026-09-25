export class WorkbenchError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'WorkbenchError'; }
}
export function invariant(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new WorkbenchError(code, message);
}
