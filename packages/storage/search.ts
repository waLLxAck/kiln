import { DatabaseSync } from 'node:sqlite';
import type { Item, Revision } from '../protocol/schema';

/** The columns plain search has always matched; `description` is only searched when a query asks for ranked results. */
const PLAIN_COLUMNS = '{title tags collection content}';
/** bm25 weights per column (id, title, tags, collection, content, description): a title hit outranks a tag, a description, then body text. */
const WEIGHTS = '0, 10, 6, 2, 1, 4';

export class SearchIndex {
  private db: DatabaseSync;
  private revisions = new Map<string, string>();
  private initial = true;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    // The index lives in `entries` since the description column was added. Builds before that kept a five-column `items` table;
    // the first rebuild of every run starts from empty anyway, so dropping it loses nothing, and an older build opening this
    // file recreates its own `items` table instead of failing on a column it does not know.
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; DROP TABLE IF EXISTS items; CREATE VIRTUAL TABLE IF NOT EXISTS entries USING fts5(id UNINDEXED,title,tags,collection,content,description);');
  }
  /** `load` is called only for items whose revision the index has not stored yet, so an unchanged library costs no file reads. */
  rebuild(items: { item: Item; load: () => Revision }[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.initial) this.db.exec('DELETE FROM entries');
      const put = this.db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?)');
      const remove = this.db.prepare('DELETE FROM entries WHERE id = ?');
      const present = new Set(items.map(({ item }) => item.id));
      for (const id of this.revisions.keys()) if (!present.has(id)) { remove.run(id); this.revisions.delete(id); }
      for (const { item, load } of items) {
        // The description lives on the item, so a new description re-indexes the item even when its revision is unchanged.
        const key = `${item.revision}\0${item.description ?? ''}`;
        if (this.revisions.get(item.id) === key) continue;
        let revision: Revision; try { revision = load(); } catch { continue; }
        remove.run(item.id); put.run(item.id, item.title, item.tags.join(' '), item.collection, revision.content, item.description ?? '');
        this.revisions.set(item.id, key);
      }
      this.db.exec('COMMIT');
      this.initial = false;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Each word is a prefix, all must match. `ranked` also searches descriptions and orders by weighted relevance. */
  search(query: string, ranked = false): string[] {
    const tokens = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
    if (!tokens.length) return [];
    const phrase = tokens.map(t => `"${t.replaceAll('"', '""')}"*`).join(' AND ');
    if (ranked) return (this.db.prepare(`SELECT id FROM entries WHERE entries MATCH ? ORDER BY bm25(entries, ${WEIGHTS})`).all(phrase) as { id: string }[]).map(row => row.id);
    return (this.db.prepare('SELECT id FROM entries WHERE entries MATCH ? ORDER BY rank').all(`${PLAIN_COLUMNS} : (${phrase})`) as { id: string }[]).map(row => row.id);
  }
  close() { this.db.close(); }
}
