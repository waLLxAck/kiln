import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowUp, Check, Circle, Download, FolderPlus, Minus, Undo2 } from 'lucide-react';
import type { Item } from '../../../packages/protocol/schema';
import type { McpCopy, McpReceipt, McpScan, McpScanEntry, McpStatus } from '../../../packages/deployment/mcp';
import { mcpClientLabel, mcpClients, mcpCommandLine, nativeText, parseMcp, serialiseMcp, type McpClient, type McpServer } from '../../../packages/domain/mcp-format';
import { api } from './api';
import { InlineError, Modal } from './components';
import { LoadError, useLoad, Waiting } from './Loading';
import './mcp.css';

/**
 * MCP servers on the item page and in Settings: the definition as a property table, the installs matrix (one switch per client
 * and location), the dialog behind each switch, and the import of servers found in client configs. The rules live in
 * packages/deployment/mcp.ts; this file only shows them.
 */
const short: Record<McpClient, string> = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot', vscode: 'VS Code', cursor: 'Cursor' };
const transportLabel = { stdio: 'stdio · a local command', http: 'Streamable HTTP', sse: 'SSE' } as const;
const where = (copy: Pick<McpCopy, 'client' | 'scope' | 'project'>) => `${mcpClientLabel[copy.client]} · ${copy.scope === 'personal' ? 'personal' : baseName(copy.project)}`;
const baseName = (folder: string) => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder;

/** Text with its `${VAR}` references shown as tokens: they are read from the environment on each machine. */
function Value({ text }: { text: string }) {
  const parts = text.split(/(\$\{[A-Za-z_][A-Za-z0-9_]*\})/);
  return <>{parts.map((part, i) => /^\$\{/.test(part) ? <span key={i} className="variable-token" title="Read from this environment variable on each machine">{part.slice(2, -1)}</span> : part ? <span key={i}>{part}</span> : null)}</>;
}
/** The definition as a table instead of JSON. Fields the header already shows (the title, the description) are left out. */
export function McpDefinition({ content, title, description }: { content: string; title: string; description: string }) {
  const { server } = parseMcp(content);
  if (!server) return <pre className="item-raw">{content}</pre>;
  const pairs = (record?: Record<string, string>) => record && Object.keys(record).length ? <div className="mcp-pairs">{Object.entries(record).map(([key, value]) => <Fragment key={key}><code>{key}</code><span><Value text={value} /></span></Fragment>)}</div> : null;
  return <table className="item-props mcp-def"><tbody>
    {server.name !== title && <tr><th className="plain">Server name</th><td><code>{server.name}</code></td></tr>}
    <tr><th className="plain">Transport</th><td>{transportLabel[server.transport]}</td></tr>
    <tr><th className="plain">{server.transport === 'stdio' ? 'Runs' : 'URL'}</th><td><code className="mcp-command">{mcpCommandLine(server)}</code></td></tr>
    {server.env && <tr><th className="plain">Environment</th><td>{pairs(server.env)}</td></tr>}
    {server.headers && <tr><th className="plain">Headers</th><td>{pairs(server.headers)}</td></tr>}
    {server.description && server.description !== description && <tr><th className="plain">Description</th><td>{server.description}</td></tr>}
  </tbody></table>;
}

type Cell = 'off' | 'on' | 'outdated' | 'drifted' | 'found' | 'differs' | 'unsupported' | 'unreadable';
const cellOf = (copy: McpCopy): Cell => copy.unsupported ? 'unsupported' : copy.state === 'unreadable' ? 'unreadable' : copy.state === 'absent' ? 'off' : copy.state === 'installed' ? (copy.outdated ? 'outdated' : 'on') : copy.state === 'drifted' ? 'drifted' : copy.matches ? 'found' : 'differs';
const cellHint: Record<Cell, string> = {
  off: 'Not in this config. Click to install.', on: 'Installed by Kiln, unchanged since. Click to remove.', outdated: 'Installed by Kiln; a newer revision is approved. Click to update.',
  drifted: 'Installed by Kiln, then edited in the file. Click to compare.', found: 'The same server is there, but Kiln did not write it. Click to let Kiln manage it.',
  differs: 'A different server with this name is there. Click to compare.', unsupported: '', unreadable: '',
};
const glyph: Record<Cell, ReactNode> = { off: <Download size={12} />, on: <Check size={12} strokeWidth={3} />, outdated: <ArrowUp size={12} strokeWidth={3} />, drifted: '!', found: <Circle size={7} fill="currentColor" />, differs: '≠', unsupported: <Minus size={12} />, unreadable: '?' };

/**
 * The Installs section of an MCP server: a matrix of clients by location (personal, then projects that hold it or that you add
 * here), each cell one switch that opens what it would do. `children` renders the rail section around it with the count.
 */
export function McpInstalls({ item, valid, approved, perform, refresh, children }: { item: Item; /** The revision passes its content checks. */ valid: boolean; approved: boolean; perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; refresh: () => Promise<void>; children: (count: string, tone: 'bad' | 'accent' | undefined, body: ReactNode) => ReactNode }) {
  const [status, setStatus] = useState<McpStatus | null>(null), [error, setError] = useState(''), [open, setOpen] = useState<McpCopy | null>(null), [extra, setExtra] = useState('');
  const [since, setSince] = useState<number | null>(null);
  const load = useCallback(() => { if (!valid) { setStatus(null); return; } setSince(Date.now()); api<McpStatus>('mcp.status', { itemId: item.id, ...(extra ? { project: extra } : {}) }).then(value => { setStatus(value); setError(''); }).catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setSince(null)); }, [item.id, item.revision, valid, extra]);
  useEffect(load, [load]);
  const copies = status?.copies ?? [];
  const drifted = copies.filter(c => c.state === 'drifted').length, outdated = copies.filter(c => c.outdated).length, installed = copies.filter(c => c.state === 'installed').length;
  const count = [drifted && `${drifted} changed`, outdated && `${outdated} update${outdated === 1 ? '' : 's'} available`].filter(Boolean).join(' · ') || `${installed} installed`;
  const current = copies.filter(c => !c.renamed), renamed = copies.filter(c => c.renamed);
  const rows = [{ key: '', label: 'Personal', title: 'Your personal config of each client' }, ...(status?.projects ?? []).filter(p => p.root === extra || current.some(c => c.project === p.root && c.state !== 'absent')).map(p => ({ key: p.root, label: p.name, title: p.root }))];
  const addable = (status?.projects ?? []).filter(p => !rows.some(r => r.key === p.root));
  const choose = async (value: string) => {
    if (value !== '*') { setExtra(value); return; }
    const root = await api<string | null>('desktop.chooseDirectory').catch(() => null); if (root) setExtra(root);
  };
  const body = !valid ? <p className="rail-note">Fix the definition first; only a valid server can be installed.</p> : <>
    {error ? <LoadError error={error} onRetry={load} /> : !status && <Waiting since={since} label="Reading client configs" />}
    {status && <table className="mcp-matrix" aria-label="Installed for"><thead><tr><th />{mcpClients.map(client => <th key={client} scope="col" title={mcpClientLabel[client]}>{short[client]}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={row.key}><th scope="row" title={row.title}>{row.label}</th>{mcpClients.map(client => {
        const copy = current.find(c => c.client === client && c.project === row.key);
        if (!copy) return <td key={client} />;
        const cell = cellOf(copy), hint = cell === 'unsupported' ? copy.unsupported! : cell === 'unreadable' ? copy.error ?? 'This file could not be read.' : cellHint[cell];
        return <td key={client}><button type="button" className={`mcp-cell ${cell}`} aria-label={`${where(copy)}: ${cell === 'off' ? 'not installed' : cell}`} title={`${hint}\n${copy.file}`} disabled={cell === 'unsupported' || cell === 'unreadable' || Boolean(item.deletedAt)} onClick={() => setOpen(copy)}>{glyph[cell]}</button></td>;
      })}</tr>)}</tbody></table>}
    {renamed.map(copy => <div className="rail-item" key={`${copy.file}-${copy.name}`}><span className="rail-glyph warn">≠</span><div className="rail-text"><span className="rail-name">Earlier name “{copy.name}”</span><span className="rail-sub" title={copy.file}>{where(copy)}</span></div><button className="rail-mini" onClick={() => setOpen(copy)}>Remove…</button></div>)}
    {status && !item.deletedAt && <label className="mcp-add"><FolderPlus size={12} aria-hidden="true" /><select aria-label="Show a project" value="" onChange={e => void choose(e.target.value)}><option value="" disabled>Add a project…</option>{addable.map(p => <option key={p.root} value={p.root}>{p.name}</option>)}<option value="*">Choose a folder…</option></select></label>}
  </>;
  return <>
    {children(count, drifted ? 'bad' : outdated ? 'accent' : undefined, body)}
    {open && <McpInstallDialog item={item} copy={open} approved={approved} onClose={() => setOpen(null)} onDone={message => { setOpen(null); load(); void perform(refresh, message); }} />}
  </>;
}

type Preview = { file: string; name: string; exists: boolean; hash: string | null; current: unknown; proposed: unknown; receipt: McpReceipt | null; unsupported?: string };
/** What a cell does, shown before it does it: the entry in the file beside the entry Kiln writes, then one action per outcome. */
export function McpInstallDialog({ item, copy, approved, onClose, onDone }: { item: Item; copy: McpCopy; approved: boolean; onClose: () => void; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const args = { itemId: item.id, client: copy.client, ...(copy.project ? { project: copy.project } : {}), ...(copy.renamed ? { name: copy.name } : {}) };
  const reading = useLoad(() => api<Preview>('mcp.preview', args), [item.id, copy.client, copy.project, copy.name]), preview = reading.data;
  const cell = cellOf(copy), label = where(copy);
  const run = async (method: string, extra: Record<string, unknown>, message: string) => {
    setBusy(true); setError('');
    try { await api(method, { ...args, ...extra, expect: preview?.hash ?? null, confirm: true }); onDone(message); } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  const install = (replace = false) => run('mcp.install', { replace }, `“${copy.name}” installed for ${label}. Start a new session to use it.`);
  const remove = (force = false) => run('mcp.remove', { force }, `“${copy.name}” removed from ${label}. The rest of the file is unchanged.`);
  const receipt = preview?.receipt?.status === 'applied' && preview.receipt.previousHash !== preview.receipt.hash ? preview.receipt : null;
  const undo = () => { if (!receipt) return; setBusy(true); void api('mcp.rollback', { receiptId: receipt.id, confirm: true }).then(() => onDone(`Undid the last install of “${copy.name}” for ${label}.`)).catch(e => { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }); };
  const titles: Record<Cell, string> = { off: `Install for ${label}`, on: `Remove from ${label}`, outdated: `Update available in ${label}`, drifted: `Edited entry in ${label}`, found: `Existing entry in ${label}`, differs: `Different server in ${label}`, unsupported: label, unreadable: label };
  const entry = (value: unknown) => <pre className="mcp-entry">{nativeText(copy.client, copy.name, value)}</pre>;
  return <Modal title={copy.renamed ? `Earlier name in ${label}` : titles[cell]} subtitle={item.title} onClose={onClose} wide={Boolean(preview?.current && preview.proposed)}>
    <code className="path-text">{copy.file}</code>
    {copy.renamed ? <p>Kiln installed this server under its earlier name “{copy.name}”. Remove that entry; install the current name from its own switch.</p>
      : cell === 'off' ? <p>Kiln adds this one entry to the file{preview && !preview.exists ? ', creating it' : ''}. Nothing else in the file changes, and the previous file is kept in Config files versions.{!approved && ' Installing approves exactly this revision and pushes it to your Kiln repo on GitHub.'}</p>
      : cell === 'on' ? <p>Only the “{copy.name}” entry is removed. The library keeps the item, and you can install it again.</p>
      : cell === 'outdated' ? <p>Kiln wrote this entry and it is unchanged, but a newer revision is approved. Updating rewrites only this entry.</p>
      : cell === 'found' ? <p>This entry describes the same server, but Kiln did not write it. Letting Kiln manage it records ownership without rewriting the file.</p>
      : cell === 'drifted' ? <p>Kiln installed this entry and it was edited in the file afterwards. Reinstalling writes the library version; the edited entry is kept in the receipt, the file in Config files versions.</p>
      : <p>The file already has a different server called “{copy.name}”. Import it from Settings to keep it in the library, or replace it with the library version (the old entry is kept so it can be put back).</p>}
    {preview && (preview.current !== null && preview.proposed !== null && cell !== 'on' && cell !== 'found' ? <div className="mcp-compare"><div><h4>In the file</h4>{entry(preview.current)}</div><div><h4>Kiln writes</h4>{entry(preview.proposed)}</div></div>
      : preview.current !== null ? entry(preview.current) : preview.proposed !== null && entry(preview.proposed))}
    {!preview && (reading.error ? <LoadError error={reading.error} onRetry={reading.retry} /> : <Waiting since={reading.since} label="Reading the config file" />)}
    <InlineError error={error || preview?.unsupported || ''} />
    <div className="modal-actions">
      {receipt && <button className="button" disabled={busy} title={receipt.previous === null ? 'Remove the entry this install added' : 'Put back the entry this install replaced'} onClick={undo}><Undo2 size={14} />Undo last install</button>}
      <button className="button" onClick={onClose}>Cancel</button>
      {copy.renamed ? <button className="button primary" disabled={busy} onClick={() => void remove(true)}>Remove</button>
        : cell === 'off' ? <button className="button primary" disabled={busy || !preview || Boolean(preview.unsupported)} onClick={() => void install()}>Install</button>
        : cell === 'on' ? <button className="button primary" disabled={busy} onClick={() => void remove()}>Remove</button>
        : cell === 'outdated' ? <><button className="button danger-text" disabled={busy} onClick={() => void remove()}>Remove</button><button className="button primary" disabled={busy} onClick={() => void install()}>Update</button></>
        : cell === 'found' ? <><button className="button danger-text" disabled={busy} onClick={() => void remove()}>Remove</button><button className="button primary" disabled={busy} onClick={() => void install()}>Let Kiln manage it</button></>
        : <><button className="button danger-text" disabled={busy} onClick={() => void remove(true)}>Remove anyway</button><button className="button primary" disabled={busy} onClick={() => void install(true)}>{cell === 'drifted' ? 'Reinstall library version' : 'Replace with library version'}</button></>}
    </div>
  </Modal>;
}

const scopeWord = (found: McpScanEntry['found'][number]) => found.scope === 'personal' ? 'personal' : found.scope === 'local' ? `${baseName(found.project)} (local, in ~/.claude.json)` : baseName(found.project);
const summary = (server: McpServer) => `${server.transport} · ${mcpCommandLine(server)}`;
/**
 * Find MCP servers not in the library: each distinct server found in any client config, once, with where it was found. Ticked
 * servers are imported as drafts; the configs are not touched. Servers the library already holds are counted, not listed.
 */
export function McpImportDialog({ onClose, onDone }: { onClose: () => void; /** `id`: a server added by hand, to open. */ onDone: (message: string, id?: string) => void }) {
  const [error, setError] = useState(''), [picked, setPicked] = useState<Set<string>>(new Set()), [shown, setShown] = useState(''), [busy, setBusy] = useState(false);
  const scanning = useLoad(async () => { const result = await api<McpScan>('mcp.scan'); setPicked(new Set(result.servers.filter(s => !s.itemId).map(s => s.key))); return result; }, []), scan = scanning.data;
  const fresh = scan?.servers.filter(s => !s.itemId) ?? [], known = (scan?.servers.length ?? 0) - fresh.length, broken = scan?.files.filter(f => f.error) ?? [];
  const toggle = (key: string) => setPicked(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const importPicked = async () => {
    setBusy(true); setError('');
    try { const result = await api<{ created: unknown[] }>('mcp.import', { keys: [...picked] }); onDone(`${result.created.length} MCP server${result.created.length === 1 ? '' : 's'} imported as drafts into “MCP servers”.`); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  // A server that is in no config yet starts as a draft to fill in.
  const addByHand = async () => {
    setBusy(true);
    try { const item = await api<{ id: string }>('items.create', { title: 'new-server', kind: 'mcp', content: serialiseMcp({ name: 'new-server', transport: 'stdio', command: 'npx', args: ['-y', 'package-name'] }), collection: 'MCP servers', tags: [], files: {} }); onDone('New MCP server draft: edit its definition, then approve it.', item.id); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  return <Modal title="Find MCP servers not in the library" subtitle="Claude Code, Codex, Copilot CLI, VS Code and Cursor configs, personal and in your projects" onClose={onClose} wide>
    <InlineError error={error} />
    {!scan ? scanning.error ? <LoadError error={scanning.error} onRetry={scanning.retry} /> : <Waiting since={scanning.since} label="Reading configs">Reading configs…</Waiting> : !fresh.length ? <p className="empty-inline">No new MCP servers found{known ? `; ${known} already in the library` : ''}.</p> : <div className="mcp-found" role="list">
      {fresh.map(entry => <div key={entry.key} role="listitem" className={`mcp-found-row ${shown === entry.key ? 'open' : ''}`}>
        <input type="checkbox" aria-label={`Import ${entry.name}`} checked={picked.has(entry.key)} onChange={() => toggle(entry.key)} />
        <button type="button" className="mcp-found-name" aria-expanded={shown === entry.key} onClick={() => setShown(shown === entry.key ? '' : entry.key)}><b>{entry.name}</b><span className="muted" title={summary(entry.server)}>{summary(entry.server)}</span></button>
        <span className="mcp-found-count" title={entry.found.map(f => `${mcpClientLabel[f.client]} · ${scopeWord(f)}`).join('\n')}>{entry.found.length === 1 ? `${short[entry.found[0].client]} · ${scopeWord(entry.found[0])}` : `${entry.found.length} places`}</span>
        {shown === entry.key && <div className="mcp-found-more">
          {entry.found.map(f => <div key={`${f.file}-${f.scope}-${f.project}`}><span>{mcpClientLabel[f.client]} · {scopeWord(f)}</span><code className="path-text">{f.file}</code></div>)}
          {entry.replaced.length > 0 && <p className="notice">Literal secrets become references: {entry.replaced.join(', ')}. Set those variables on each machine.</p>}
          {entry.dropped.length > 0 && <p className="muted small">Not kept (client-specific): {entry.dropped.join(', ')}.</p>}
        </div>}
      </div>)}
    </div>}
    {broken.length > 0 && <details className="small"><summary>{broken.length} config{broken.length === 1 ? '' : 's'} could not be read</summary>{broken.map(f => <p key={f.file} className="muted">{f.error}</p>)}</details>}
    <div className="modal-actions"><button className="text-button" disabled={busy} title="Start a definition for a server that is in no config yet" onClick={() => void addByHand()}>New server by hand…</button><span className="muted">{known > 0 && fresh.length > 0 ? `${known} already in the library` : ''}</span><button className="button" onClick={onClose}>{fresh.length ? 'Cancel' : 'Close'}</button>{fresh.length > 0 && <button className="button primary" disabled={busy || !picked.size} onClick={() => void importPicked()}>Import {picked.size || ''}</button>}</div>
  </Modal>;
}
