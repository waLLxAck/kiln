import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from './api';
import { useState } from 'react';

export function Markdown({ children }: { children: string }) {
  const [error, setError] = useState('');
  return <div className="markdown-content"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => /^https?:\/\//i.test(href ?? '')
      ? <a href={href} onClick={event => { event.preventDefault(); setError(''); void api('desktop.openContentUrl', { url: href }).catch(error => setError(String(error))); }}>{children}</a>
      : <span>{children}</span>,
    img: ({ alt }) => <span className="muted">{alt ? `[Image: ${alt}]` : '[Image]'}</span>,
  }}>{children}</ReactMarkdown>{error && <p role="alert" className="error-box">{error}</p>}</div>;
}
