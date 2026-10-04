import { DatabaseSync } from 'node:sqlite';
import type { Item, Revision } from '../protocol/schema';

/** The columns plain search has always matched; `description` is only searched when a query asks for ranked results. */
const PLAIN_COLUMNS = '{title tags collection content}';
/** bm25 weights per column (id, title, tags, collection, content, description): a title hit outranks a tag, a description, then body text. */
const WEIGHTS = '0, 10, 6, 2, 1, 4';

export class SearchIndex {
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    // The index lives in `entries` since the description column was added. Builds before that kept a five-column `items` table;
    // dropping it loses nothing, and an older build opening this file recreates its own `items` table instead of failing on a
    // column it does not know.
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; DROP TABLE IF EXISTS items; CREATE VIRTUAL TABLE IF NOT EXISTS entries USING fts5(id UNINDEXED,title,tags,collection,content,description);');
    // `indexed` names the revision and description each row was built from, so a restart re-indexes only what changed. Rows from
    // before it existed start over once, as does a file whose two tables disagree. An older build refills `entries` without touching
    // this table; whatever it left is put right item by item, because every row whose key is missing or different is rebuilt.
    const kept = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'indexed'").get();
    this.db.exec('CREATE TABLE IF NOT EXISTS indexed(id TEXT PRIMARY KEY, key TEXT NOT NULL)');
    const count = (table: string) => (this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    if (!kept || count('entries') !== count('indexed')) this.db.exec('BEGIN IMMEDIATE; DELETE FROM entries; DELETE FROM indexed; COMMIT');
  }
  /**
   * `load` is called only for items whose revision the index has not stored yet, so an unchanged library costs no file reads,
   * also after a restart. Other processes on the same library share the file; what is stored is re-read each time.
   */
  rebuild(items: { item: Item; load: () => Revision }[]) {
    // The description and the collection live on the item, so either changing re-indexes the item even when its revision is unchanged.
    const key = (item: Item) => `${item.revision}\0${item.description ?? ''}\0${item.collection}`;
    const stored = () => new Map((this.db.prepare('SELECT id, key FROM indexed').all() as { id: string; key: string }[]).map(row => [row.id, row.key]));
    const present = new Set(items.map(({ item }) => item.id));
    const stale = (keys: Map<string, string>) => [...keys.keys()].some(id => !present.has(id)) || items.some(({ item }) => keys.get(item.id) !== key(item));
    if (!stale(stored())) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const keys = stored();
      const put = this.db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?)');
      const remove = this.db.prepare('DELETE FROM entries WHERE id = ?');
      const record = this.db.prepare('INSERT OR REPLACE INTO indexed VALUES(?,?)');
      const forget = this.db.prepare('DELETE FROM indexed WHERE id = ?');
      for (const id of keys.keys()) if (!present.has(id)) { remove.run(id); forget.run(id); }
      for (const { item, load } of items) {
        if (keys.get(item.id) === key(item)) continue;
        let revision: Revision; try { revision = load(); } catch { continue; }
        remove.run(item.id); put.run(item.id, item.title, item.tags.join(' '), item.collection, revision.content, item.description ?? '');
        record.run(item.id, key(item));
      }
      this.db.exec('COMMIT');
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
