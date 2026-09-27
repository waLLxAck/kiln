import { ArrowRight } from 'lucide-react';
import type { Item } from '../../../packages/protocol/schema';
import { KindIcon } from './components';

const kindPlural: Record<string, string> = { prompt: 'Prompts', skill: 'Skills', agent: 'Agents', instruction: 'Instructions', link: 'Links', insight: 'Insights', technique: 'Techniques', tool: 'Tools', resource: 'Resources', image: 'Images', file: 'Files', reference: 'References', source: 'Sources' };
/** Items made from a source, each with where it is filed now; `grouped` puts them under their kind. */
export function MadeList({ items, onSelect, grouped = false }: { items: Item[]; onSelect: (id: string) => void; grouped?: boolean }) {
  const row = (i: Item) => <button key={i.id} type="button" className="made-row" onClick={() => onSelect(i.id)}><KindIcon kind={i.kind} size={14} /><span>{i.title}</span><small>{i.collection.replaceAll('/', ' / ') || 'Unfiled'}</small><ArrowRight size={12} /></button>;
  if (!grouped) return <div className="made-list">{items.map(row)}</div>;
  const kinds = [...new Set(items.map(i => i.kind))];
  return <>{kinds.map(kind => <section key={kind} className="made-group"><h4>{kindPlural[kind] ?? kind} <small>{items.filter(i => i.kind === kind).length}</small></h4><div className="made-list">{items.filter(i => i.kind === kind).map(row)}</div></section>)}</>;
}
