import { getDocumentProxy } from 'unpdf';

const MAX_PAGES = 1000, MAX_TEXT = 500_000;
const TEXT_FILE = /\.(txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|toml|xml|html?|log)$/i;

/** Prepare readable attachments inside Kiln, without relying on the agent's file tools or external PDF utilities. */
export async function attachmentMaterial(files: Record<string, string>, signal: AbortSignal, onStatus: (phase: string) => void = () => {}) {
  const sections: string[] = [];
  let length = 0;
  const append = (text: string) => {
    length += text.length;
    if (length > MAX_TEXT) throw new Error('Attached documents contain too much text for one analysis. Split them into smaller documents and analyze them separately.');
    sections.push(text);
  };
  for (const [name, encoded] of Object.entries(files)) {
    if (name === 'session.jsonl') continue;
    signal.throwIfAborted();
    const bytes = Buffer.from(encoded, 'base64');
    if (/\.pdf$/i.test(name)) {
      onStatus(`Reading PDF: ${name}`);
      const pdf = await getDocumentProxy(new Uint8Array(bytes), { disableFontFace: true, maxImageSize: 16_000_000 }).catch(() => {
        throw new Error(`Could not read PDF ${JSON.stringify(name)}. Check that it opens correctly and export an unlocked PDF with selectable text, then retry.`);
      });
      try {
        if (pdf.numPages > MAX_PAGES) throw new Error(`PDF ${JSON.stringify(name)} has more than ${MAX_PAGES} pages. Split it into smaller documents and retry.`);
        append(`\nAttached PDF: ${JSON.stringify(name)} (${pdf.numPages} pages)\n`);
        let readable = false;
        for (let number = 1; number <= pdf.numPages; number++) {
          signal.throwIfAborted();
          const page = await pdf.getPage(number);
          try {
            const content = await page.getTextContent();
            const text = content.items.filter(item => 'str' in item).map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
            readable ||= Boolean(text);
            append(`\n[Page ${number}]\n${text || '[No extractable text on this page]'}\n`);
          } finally { page.cleanup(); }
          // Let queued requests and cancellation run while processing a long book.
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        if (!readable) throw new Error(`PDF ${JSON.stringify(name)} has no selectable text. Run OCR or upload a text version, then retry analysis.`);
      } finally { await pdf.loadingTask.destroy(); }
    } else if (TEXT_FILE.test(name)) {
      const text = bytes.toString('utf8');
      if (!text.includes('\0')) append(`\nAttached text file: ${JSON.stringify(name)}\n${text}\n`);
    }
  }
  signal.throwIfAborted();
  return sections.join('');
}
