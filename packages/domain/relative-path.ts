/** Pure path rules shared by storage and the renderer; keep this file free of imports. */

/**
 * Whether a bundled file path is safe to write on every platform: relative, `/`-separated, no `.` or `..` segments,
 * no characters or device names Windows rejects, and no segment ending in a dot or space.
 */
export const safeRelativePath = (value: string) =>
  value.length > 0 && value.length < 240 && !/[\\:*?"<>|\x00-\x1f]/.test(value) && !value.startsWith('/')
  && value.split('/').every(p => p && p !== '.' && p !== '..' && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(p));
