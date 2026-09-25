/** Pure helpers shared by the renderer and the agent service; no Node imports so the browser bundle can use them. */
const YOUTUBE = /^(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i;
/** The 11-character video id when `text` is a single YouTube link, else null. */
export function youtubeId(text: string): string | null { const match = text.trim().match(YOUTUBE); return match ? match[1] : null; }
/** Seconds as m:ss, or h:mm:ss past an hour. */
export const timestamp = (seconds: number) => { const s = Math.max(0, Math.floor(seconds)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`; };
