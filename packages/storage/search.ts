import { DatabaseSync } from 'node:sqlite';
import type { Item, Revision } from '../protocol/schema';

export class SearchIndex {
  private db: DatabaseSync;
  private revisions = new Map<string, string>();
  private initial = true;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE VIRTUAL TABLE IF NOT EXISTS items USING fts5(id UNINDEXED,title,tags,collection,content);');
  }
  /** `load` is called only for items whose revision the index has not stored yet, so an unchanged library costs no file reads. */
  rebuild(items: { item: Item; load: () => Revision }[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.initial) this.db.exec('DELETE FROM items');
      const put = this.db.prepare('INSERT INTO items VALUES(?,?,?,?,?)');
      const remove = this.db.prepare('DELETE FROM items WHERE id = ?');
      const present = new Set(items.map(({ item }) => item.id));
      for (const id of this.revisions.keys()) if (!present.has(id)) { remove.run(id); this.revisions.delete(id); }
      for (const { item, load } of items) {
        if (this.revisions.get(item.id) === item.revision) continue;
        let revision: Revision; try { revision = load(); } catch { continue; }
        remove.run(item.id); put.run(item.id, item.title, item.tags.join(' '), item.collection, revision.content);
        this.revisions.set(item.id, item.revision);
      }
      this.db.exec('COMMIT');
      this.initial = false;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  search(query: string): string[] {
    const tokens = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
    if (!tokens.length) return [];
    const phrase = tokens.map(t => `"${t.replaceAll('"', '""')}"*`).join(' AND ');
    return (this.db.prepare('SELECT id FROM items WHERE items MATCH ? ORDER BY rank').all(phrase) as { id: string }[]).map(row => row.id);
  }
  close() { this.db.close(); }
}
