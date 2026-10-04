import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from './api';
import { memo, useState } from 'react';

type Node = { type: string; value?: string; children?: Node[]; data?: Record<string, unknown> };
/**
 * Marks {{variables}} in prose as `.variable-token` spans. Code spans and blocks are left alone: a template in a code
 * sample is an example, not something Kiln fills in.
 */
function remarkVariables() {
  const walk = (node: Node) => {
    if (!node.children) return;
    node.children = node.children.flatMap(child => {
      if (child.type !== 'text' || !child.value?.includes('{{')) { walk(child); return [child]; }
      return child.value.split(/(\{\{\s*[A-Za-z_][\w.-]*\s*\}\})/).filter(Boolean).map(part => /^\{\{[\s\S]*\}\}$/.test(part)
        ? { type: 'text', value: part.replace(/^\{\{\s*|\s*\}\}$/g, ''), data: { hName: 'span', hProperties: { className: ['variable-token'], title: 'Filled in when you copy or test it' } } }
        : { type: 'text', value: part });
    });
  };
  return (tree: Node) => walk(tree);
}

/** Rendered Markdown. Memoised on its text: parsing is the costly part, and the item page renders on every poll. */
export const Markdown = memo(function Markdown({ children, variables = false }: { children: string; /** Highlights {{variables}}. */ variables?: boolean }) {
  const [error, setError] = useState('');
  return <div className="markdown-content"><ReactMarkdown remarkPlugins={variables ? [remarkGfm, remarkVariables] : [remarkGfm]} components={{
    a: ({ href, children }) => /^https?:\/\//i.test(href ?? '')
      ? <a href={href} onClick={event => { event.preventDefault(); setError(''); void api('desktop.openContentUrl', { url: href }).catch(error => setError(String(error))); }}>{children}</a>
      : <span>{children}</span>,
    img: ({ alt }) => <span className="muted">{alt ? `[Image: ${alt}]` : '[Image]'}</span>,
  }}>{children}</ReactMarkdown>{error && <p role="alert" className="error-box">{error}</p>}</div>;
});
