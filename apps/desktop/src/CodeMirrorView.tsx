import { useEffect, useRef } from 'react';
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, HighlightStyle, indentOnInput, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { yaml, yamlFrontmatter } from '@codemirror/lang-yaml';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { python } from '@codemirror/legacy-modes/mode/python';
import { javascript, json as jsonWithComments, typescript } from '@codemirror/legacy-modes/mode/javascript';
import { lineSeparatorFor, type CodeLanguage } from './code-language';
import type { CodeEditorProps, EditorDiagnostic } from './CodeEditor';

function languageSupport(language: CodeLanguage = 'plain'): Extension {
  switch (language) {
    case 'markdown': return [yamlFrontmatter({ content: markdown() }), EditorView.lineWrapping];
    case 'json': return json();
    // Lezer's JSON grammar rejects comments; the classic JavaScript mode in JSON mode reads them, as VS Code does.
    case 'jsonc': return StreamLanguage.define(jsonWithComments);
    case 'yaml': return yaml();
    case 'toml': return StreamLanguage.define(toml);
    case 'shell': return StreamLanguage.define(shell);
    case 'powershell': return StreamLanguage.define(powerShell);
    case 'python': return StreamLanguage.define(python);
    case 'javascript': return StreamLanguage.define(javascript);
    case 'typescript': return StreamLanguage.define(typescript);
    default: return EditorView.lineWrapping;
  }
}

// CodeMirror's default token styles, recoloured with Kiln's theme variables (see "Code editor" in styles.css) so they follow light and dark.
const palette: Record<string, string> = { '#404740': 'var(--muted)', '#708': 'var(--code-keyword)', '#219': 'var(--code-atom)', '#164': 'var(--code-number)', '#a11': 'var(--code-string)', '#e40': 'var(--code-escape)', '#00f': 'var(--code-definition)', '#30a': 'var(--code-definition)', '#085': 'var(--code-type)', '#167': 'var(--code-type)', '#256': 'var(--code-atom)', '#00c': 'var(--code-property)', '#940': 'var(--code-comment)', '#f00': 'var(--bad)' };
const kilnHighlight = HighlightStyle.define(defaultHighlightStyle.specs.map(spec => {
  const { color, ...rest } = spec;
  // Headings stay bold without the default underline.
  if (rest.fontWeight === 'bold' && rest.textDecoration === 'underline') return { ...rest, textDecoration: 'none', color: 'var(--code-heading)' };
  return color ? { ...rest, color: palette[String(color)] ?? 'inherit' } : rest;
}));
const kilnTheme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'var(--subtle)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', fontSize: '12px' },
  '&.cm-focused': { outline: 'none', borderColor: 'var(--accent)', boxShadow: '0 0 0 3px var(--accent-tint)', backgroundColor: 'var(--panel)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.7' },
  '.cm-content': { caretColor: 'var(--text)', padding: '10px 0' },
  '.cm-line': { padding: '0 14px 0 6px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--accent-tint-2)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--faint)', border: 'none', borderRight: '1px solid var(--line)' },
  '.cm-activeLine': { backgroundColor: 'var(--accent-tint)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--accent-tint)', color: 'var(--text-2)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--accent-tint-2)', outline: '1px solid var(--ring)' },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--bad-bg)' },
  '.cm-searchMatch': { backgroundColor: 'var(--warn-bg)', outline: '1px solid var(--warn-line)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent-tint-2)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--accent-tint)' },
  '.cm-specialChar': { color: 'var(--bad)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)', borderRadius: 'var(--r-md) var(--r-md) 0 0' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-panel.cm-search': { padding: '6px 34px 6px 8px', fontFamily: 'var(--font)', fontSize: '12px' },
  '.cm-panel.cm-search label': { display: 'inline-flex', alignItems: 'center', gap: '3px', color: 'var(--text-2)', fontSize: '12px' },
  '.cm-panel.cm-search [name=close]': { color: 'var(--muted)', fontSize: '16px', top: '4px', right: '8px' },
  '.cm-textfield': { backgroundColor: 'var(--subtle)', color: 'var(--text)', border: '1px solid var(--line-strong)', borderRadius: 'var(--r-sm)', padding: '3px 7px', margin: '0', fontSize: '12px' },
  '.cm-textfield:focus': { outline: 'none', borderColor: 'var(--accent)', boxShadow: '0 0 0 2px var(--ring)' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--subtle-2)', color: 'var(--text)', border: '1px solid var(--line-strong)', borderRadius: 'var(--r-sm)', padding: '2px 9px', margin: '0', fontSize: '12px' },
  '.cm-button:active': { backgroundImage: 'none', backgroundColor: 'var(--line)' },
  '.cm-kiln-problem': { backgroundColor: 'var(--warn-bg)', boxShadow: 'inset 3px 0 0 var(--warn)' },
});

/** Problems from the caller, drawn as highlighted lines with the messages as a tooltip. */
const setProblems = StateEffect.define<EditorDiagnostic[]>();
const problemLines = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(lines, tr) {
    lines = lines.map(tr.changes);
    for (const effect of tr.effects) if (effect.is(setProblems)) {
      const builder = new RangeSetBuilder<Decoration>();
      const numbers = [...new Set(effect.value.map(p => p.line ?? 0).filter(n => n >= 1 && n <= tr.state.doc.lines))].sort((a, b) => a - b);
      for (const n of numbers) { const line = tr.state.doc.line(n); builder.add(line.from, line.from, Decoration.line({ class: 'cm-kiln-problem', attributes: { title: effect.value.filter(p => p.line === n).map(p => p.message).join('\n') } })); }
      lines = builder.finish();
    }
    return lines;
  },
  provide: field => EditorView.decorations.from(field),
});

/** The CodeMirror editor behind `CodeEditor`; loaded on demand. */
export default function CodeMirrorView({ value, onChange, language, ariaLabel, readOnly = false, onSave, diagnostics, diagnosticsTitle, autoFocus = false }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null);
  const last = useRef(value), separator = useRef(lineSeparatorFor(value));
  const change = useRef(onChange), save = useRef(onSave);
  change.current = onChange; save.current = onSave;
  const compartments = useRef({ language: new Compartment(), readOnly: new Compartment(), label: new Compartment() }).current;
  const createState = (text: string) => {
    const sep = separator.current = lineSeparatorFor(text);
    return EditorState.create({ doc: text, extensions: [
      lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(), indentOnInput(), bracketMatching(), highlightActiveLine(), highlightSelectionMatches(), search({ top: true }),
      syntaxHighlighting(kilnHighlight), kilnTheme, problemLines,
      // Keep the file's own line breaks so text read back is byte for byte what was loaded; pasted text follows them too.
      ...(sep ? [EditorState.lineSeparator.of(sep), EditorView.clipboardInputFilter.of(pasted => pasted.replace(/\r\n?|\n/g, sep))] : []),
      keymap.of([
        { key: 'Mod-s', run: () => { if (!save.current) return false; save.current(); return true; } },
        { key: 'Mod-h', scope: 'editor search-panel', preventDefault: true, run: target => { openSearchPanel(target); setTimeout(() => target.dom.querySelector<HTMLInputElement>('.cm-search input[name=replace]')?.focus()); return true; } },
        ...searchKeymap, ...historyKeymap, ...defaultKeymap,
      ]),
      compartments.language.of(languageSupport(language)), compartments.readOnly.of(EditorState.readOnly.of(readOnly)), compartments.label.of(EditorView.contentAttributes.of({ 'aria-label': ariaLabel })),
      EditorView.updateListener.of(update => { if (!update.docChanged) return; const text = update.state.sliceDoc(); if (text === last.current) return; last.current = text; change.current?.(text); }),
    ] });
  };
  useEffect(() => {
    const editor = new EditorView({ state: createState(value), parent: host.current! });
    view.current = editor;
    // Find, replace, undo and save belong to the editor: the app's Ctrl+F (the query bar), Ctrl+Z (its undo stack) and outer
    // Ctrl+S handlers must not also run. Without onSave, Ctrl+S goes on to the surrounding view, which saves.
    const keep = (event: KeyboardEvent) => { if (!(event.ctrlKey || event.metaKey) || event.altKey) return; const key = event.key.toLowerCase(); if (['f', 'h', 'z', 'y'].includes(key) || (key === 's' && save.current)) event.stopPropagation(); };
    editor.dom.addEventListener('keydown', keep);
    if (autoFocus) editor.focus();
    return () => { editor.dom.removeEventListener('keydown', keep); editor.destroy(); view.current = null; };
  }, []);
  useEffect(() => {
    const editor = view.current; if (!editor || value === last.current) return;
    last.current = value;
    if (lineSeparatorFor(value) !== separator.current) editor.setState(createState(value));
    else editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);
  useEffect(() => { view.current?.dispatch({ effects: [compartments.language.reconfigure(languageSupport(language)), compartments.readOnly.reconfigure(EditorState.readOnly.of(readOnly)), compartments.label.reconfigure(EditorView.contentAttributes.of({ 'aria-label': ariaLabel }))] }); }, [language, readOnly, ariaLabel]);
  useEffect(() => { view.current?.dispatch({ effects: setProblems.of(diagnostics ?? []) }); }, [diagnostics]);
  const jump = (line: number) => { const editor = view.current; if (!editor) return; const target = editor.state.doc.line(Math.min(line, editor.state.doc.lines)); editor.dispatch({ selection: { anchor: target.from }, scrollIntoView: true }); editor.focus(); };
  return <>
    <div className="code-editor-view" ref={host} />
    {diagnostics && diagnostics.length > 0 && <div className="code-diagnostics" role="status"><b>{diagnosticsTitle ?? 'Problems'}</b><ul>{diagnostics.map((d, i) => <li key={`${i}:${d.message}`}>{d.line ? <button type="button" className="text-button" onClick={() => jump(d.line!)} title="Go to this line">Line {d.line}</button> : null}<span>{d.message}</span></li>)}</ul></div>}
  </>;
}
