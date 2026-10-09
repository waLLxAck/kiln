import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { attachmentMaterial } from '../packages/agent/attachments';
import { AgentService } from '../packages/agent/service';
import { Workbench } from '../packages/domain/workbench';

/** A small original PDF, with real offsets, usable by the same parser as an imported book. */
function pdfFile(texts: string[]) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${texts.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${texts.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  texts.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 50 700 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let document = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => { const offset = Buffer.byteLength(document); document += `${i + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(document).toString('base64');
}
const signal = () => new AbortController().signal;

test('PDF and text attachments are available without file tools, in page order', async () => {
  const material = await attachmentMaterial({ 'book.PDF': pdfFile(['Chapter One: decide', 'Chapter Two: apply']), 'notes.md': Buffer.from('Compare both chapters').toString('base64'), 'session.jsonl': Buffer.from('Private session').toString('base64') }, signal());
  assert.match(material, /book.PDF.*2 pages/);
  assert.match(material, /\[Page 1\]\nChapter One: decide[\s\S]*\[Page 2\]\nChapter Two: apply/);
  assert.match(material, /Compare both chapters/);
  assert.doesNotMatch(material, /Private session/);
});

test('unreadable and scanned PDFs fail with recovery steps', async () => {
  await assert.rejects(attachmentMaterial({ 'broken.pdf': Buffer.from('not a PDF').toString('base64') }, signal()), /Could not read PDF.*unlocked PDF/);
  await assert.rejects(attachmentMaterial({ 'scan.pdf': pdfFile(['']) }, signal()), /no selectable text.*OCR/);
});

test('large attachments fail instead of silently truncating; cancelled extraction stops', async () => {
  await assert.rejects(attachmentMaterial({ 'large.txt': Buffer.from('x'.repeat(500_001)).toString('base64') }, signal()), /Split them into smaller documents/);
  const controller = new AbortController();
  const extraction = attachmentMaterial({ 'book.pdf': pdfFile(['One', 'Two']) }, controller.signal, () => controller.abort());
  await assert.rejects(extraction, { name: 'AbortError' });
  await assert.rejects(attachmentMaterial({ 'long.pdf': pdfFile(Array(1001).fill('Page')) }, signal()), /more than 1000 pages/);
});

test('PDF capture passes book text directly to the runner and keeps original bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-pdf-'));
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  try {
    let prompt = '';
    const files = { 'book.pdf': pdfFile(['Chapter One: decide', 'Chapter Two: apply']) };
    const service = new AgentService(wb, () => {}, async input => { prompt = input.prompt; return { summary: 'A book', collection: 'Books', takeaway: 'Decide then apply', skipped: '', entries: [] }; }, async () => []);
    const captured = service.capture({ text: 'Build chapter prompts', files });
    for (let i = 0; i < 500 && service.running; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(service.running, 0);
    assert.equal(service.list()[0].status, 'completed');
    assert.match(prompt, /<source_material>[\s\S]*Chapter One: decide[\s\S]*Chapter Two: apply[\s\S]*<\/source_material>/);
    assert.deepEqual(wb.getRevision(captured.item.id).files, files);
    const original = wb.getRevision(captured.item.id);
    const entry = wb.createFrom({ id: captured.item.id, revision: original.hash, item: { title: 'Chapter prompt', kind: 'prompt', content: 'Apply the chapter' } });
    let chatPrompt = '';
    const chat = new AgentService(wb, () => {}, async input => { chatPrompt = input.prompt; return 'Discussed the book'; }, async () => []);
    for (const itemId of [captured.item.id, entry.id]) {
      const turn = chat.chat({ itemId, message: 'Explain chapter two' });
      for (let i = 0; i < 500 && chat.running; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(chat.job({ id: turn.id }).status, 'completed');
      assert.match(chatPrompt, /<source_material>[\s\S]*Chapter Two: apply[\s\S]*<\/source_material>/);
    }
    let called = false;
    const failed = new AgentService(wb, () => {}, async () => { called = true; return {}; }, async () => []);
    const invalid = failed.capture({ text: 'Read book', files: { 'scan.pdf': pdfFile(['']) } });
    for (let i = 0; i < 500 && failed.running; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(failed.running, 0);
    assert.equal(called, false);
    assert.equal(failed.list()[0].status, 'failed');
    assert.match(failed.list()[0].error!, /OCR/);
    assert.equal(wb.getRevision(invalid.item.id).files['scan.pdf'], pdfFile(['']));
  } finally { wb.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('PDF extraction works in the CommonJS bundle shipped by desktop and CLI', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-pdf-bundle-'));
  try {
    const output = path.join(root, 'attachments.cjs');
    await build({ entryPoints: ['packages/agent/attachments.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: output, logLevel: 'silent' });
    const bundled = createRequire(import.meta.url)(output);
    const material = await bundled.attachmentMaterial({ 'book.pdf': pdfFile(['Bundled PDF text']) }, signal());
    assert.match(material, /Bundled PDF text/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
