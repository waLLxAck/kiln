import { useEffect, useState } from 'react';
import { FileDiff, FolderOpen } from 'lucide-react';
import type { ComparedFile, Comparison } from '../../../packages/deployment/service';
import { api } from './api';
import { InlineError, Modal } from './components';
import { LineDiff } from './Diff';

const statusLabel: Record<ComparedFile['status'], string> = { same: 'identical', changed: 'changed', only_library: 'only in the approved version', only_installed: 'only in the installed copy' };
const kb = (n: number | null) => n === null ? '' : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
function FileView({ file }: { file: ComparedFile }) {
  if (!file.text) return <p className="muted small">Binary file. Approved version {kb(file.librarySize) || 'absent'} · installed copy {kb(file.installedSize) || 'absent'}.</p>;
  if (file.status === 'changed') return <LineDiff before={file.installed ?? ''} after={file.library ?? ''} names={{ before: 'the installed copy', after: 'the approved version' }} className="compare-diff" />;
  if (file.status === 'only_library') return <div className="diff compare-diff"><pre className="added">{file.library}</pre></div>;
  if (file.status === 'only_installed') return <div className="diff compare-diff"><pre className="removed">{file.installed}</pre></div>;
  return <div className="diff compare-diff"><pre>{file.library}</pre></div>;
}
/** Summary, file list and per-file diff for one skill folder against the library. Loads on mount; read-only. */
export function FolderComparison({ itemId, targetId }: { itemId: string; targetId: string }) {
  const [data, setData] = useState<Comparison | null>(null), [error, setError] = useState(''), [open, setOpen] = useState<string | null>(null);
  useEffect(() => { setData(null); setOpen(null); void api<Comparison>('deploy.compare', { itemId, targetId }).then(result => { setData(result); setOpen(result.files.find(f => f.status !== 'same')?.path ?? null); }).catch(e => setError(e instanceof Error ? e.message : String(e))); }, [itemId, targetId]);
  if (error) return <InlineError error={error} />;
  if (!data) return <p className="muted">Reading both versions…</p>;
  const differing = data.files.filter(f => f.status !== 'same');
  const count = (status: ComparedFile['status']) => data.files.filter(f => f.status === status).length;
  return <div className="compare">
    <div className="compare-summary">{differing.length === 0 ? <b>Every file is identical to the approved version.</b> : <><b>{differing.length} of {data.files.length} file{data.files.length === 1 ? '' : 's'} differ.</b>{count('changed') > 0 && <span>{count('changed')} changed</span>}{count('only_library') > 0 && <span>{count('only_library')} only in the approved version</span>}{count('only_installed') > 0 &&<span>{count('only_installed')} only in folder</span>}</>}</div>
    {!data.exists && <p className="notice warning">The folder could not be read, so every file shows as only in the approved version.</p>}
    <div className="compare-legend"><span className="removed">Only in the installed copy</span><span className="added">Only in the approved version</span><span>Replacing with the approved version removes red lines and adds green ones.</span></div>
    <ul className="compare-files">{data.files.map(file => <li key={file.path} className={file.status}><button className={`compare-file ${open === file.path ? 'open' : ''}`} onClick={() => setOpen(open === file.path ? null : file.path)}><FileDiff size={13} /><code>{file.path}</code><span className={`badge ${file.status === 'same' ? 'current' : file.status === 'changed' ? 'review' : file.status === 'only_library' ? 'create' : 'drifted'}`}>{statusLabel[file.status]}</span></button>{open === file.path && <FileView file={file} />}</li>)}</ul>
  </div>;
}
export function CompareDialog({ itemId, targetId, title, destination, onClose }: { itemId: string; targetId: string; title: string; destination: string; onClose: () => void }) {
  return <Modal title="Approved version vs installed copy" subtitle={title} onClose={onClose} wide>
    <code className="path-text">{destination}</code>
    <FolderComparison itemId={itemId} targetId={targetId} />
    <div className="modal-actions"><button className="button" onClick={() => void api('desktop.revealPath', { path: destination })}><FolderOpen size={14} />Open folder</button><button className="button primary" onClick={onClose}>Close</button></div>
  </Modal>;
}
