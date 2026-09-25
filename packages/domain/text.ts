/** Pure helpers safe for both the renderer bundle and Node code; keep this file free of imports. */

/** Files Kiln shows as text (previews, diffs); everything else is treated as binary and shown by size. */
export const isTextFile = (name: string) => /\.(md|txt|json|ya?ml|js|ts|tsx|py|sh|ps1|cmd|bat|toml|csv|xml|html|css)$/i.test(name);

/** Distinct `{{name}}` placeholders in a prompt, in first-seen order. */
export const variablesIn = (content: string) => [...new Set([...content.matchAll(/\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g)].map(m => m[1]))];
