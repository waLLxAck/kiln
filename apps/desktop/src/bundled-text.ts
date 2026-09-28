/** Pure helpers for editing a revision's bundled files as text. Files are stored as base64. */

/** Larger files are listed but not opened in the editor. */
export const EDITABLE_TEXT_LIMIT = 512 * 1024;
/** Extensions expected to be text. Detection is by content: any file opens when its bytes are UTF-8 without NUL bytes. */
export const textExtension = (name: string) => /\.(md|markdown|txt|json|jsonc|ya?ml|toml|sh|bash|zsh|ps1|psm1|py|js|mjs|cjs|jsx|ts|tsx|html?|css|xml|csv|tsv|ini|cfg|conf)$/i.test(name);

export function base64Bytes(value: string) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
export function bytesBase64(bytes: Uint8Array) {
  let binary = '';
  // Chunked so large files do not overflow the argument limit of String.fromCharCode.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * The file's text when it can be edited and written back unchanged: valid UTF-8 with no NUL bytes, no larger than the
 * limit. A byte-order mark stays in the text (as U+FEFF) so saving keeps it. Anything else is binary and left untouched.
 */
export function editableText(base64: string): string | null {
  if (base64.length > 4 * Math.ceil(EDITABLE_TEXT_LIMIT / 3)) return null;
  let bytes: Uint8Array;
  try { bytes = base64Bytes(base64); } catch { return null; }
  if (bytes.length > EDITABLE_TEXT_LIMIT || bytes.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
}
export const encodeText = (text: string) => bytesBase64(new TextEncoder().encode(text));

/**
 * The bundled files to save: the revision's files with edited text files re-encoded. A file whose text is unchanged, or
 * which is not editable text, keeps its stored bytes exactly; new files (not in the revision) are added.
 */
export function mergeTextEdits(files: Record<string, string>, edits: Record<string, string>): Record<string, string> {
  const merged = { ...files };
  for (const [name, text] of Object.entries(edits)) {
    if (!Object.hasOwn(files, name)) { merged[name] = encodeText(text); continue; }
    const original = editableText(files[name]);
    if (original !== null && original !== text) merged[name] = encodeText(text);
  }
  return merged;
}

/** Why a new bundled file path cannot be used, or null. `safe` is the storage path rule (safeRelativePath). */
export function newFileProblem(path: string, existing: string[], safe: (value: string) => boolean): string | null {
  if (!path) return 'Enter a relative path, for example references/notes.md.';
  if (!safe(path)) return 'Use a relative path with / between folders, without .., drive letters or characters Windows rejects.';
  if (['skill.md', 'content.md'].includes(path.toLowerCase())) return 'The main content file cannot be replaced by a bundled file.';
  if (existing.some(name => name.toLowerCase() === path.toLowerCase())) return 'A bundled file with this name already exists (names are compared ignoring case).';
  return null;
}
