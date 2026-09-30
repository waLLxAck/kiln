import { lazy, Suspense } from 'react';
import type { CodeLanguage } from './code-language';

/** A problem shown under the editor and marked on its line (1-based) when it has one. */
export type EditorDiagnostic = { message: string; line?: number };
export type CodeEditorProps = {
  value: string; onChange?: (value: string) => void; language?: CodeLanguage; ariaLabel: string; readOnly?: boolean;
  /** Ctrl/Cmd+S inside the editor. Without it the key goes on to the surrounding view. */ onSave?: () => void;
  diagnostics?: EditorDiagnostic[]; /** Heading for the diagnostics list. */ diagnosticsTitle?: string; className?: string;
  /** Puts the cursor in the editor as soon as it is shown, e.g. for a file just added. */ autoFocus?: boolean;
  /** Moves the cursor to this 1-based line and scrolls it into view, each time `at` changes (a score's line link). */ goto?: { line: number; at: number };
};
// CodeMirror is loaded only when an editor is first shown, so the app starts without it. The placeholder has no label, so
// anything looking for the editor by its label waits for the real one.
const View = lazy(() => import('./CodeMirrorView'));

/**
 * The code editor: CodeMirror with line numbers, find and replace (Ctrl/Cmd+F, Ctrl/Cmd+H),
 * undo history, bracket matching and highlighting for Markdown with frontmatter, JSON, YAML, TOML, shell and PowerShell
 * files. Inside it, Ctrl/Cmd+F finds in the editor rather than opening the app's query bar.
 */
export function CodeEditor(props: CodeEditorProps) {
  return <div className={`code-editor ${props.className ?? ''}`}>
    <Suspense fallback={<pre className="code-editor-loading" aria-busy="true">{props.value}</pre>}><View {...props} /></Suspense>
  </div>;
}
