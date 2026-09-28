import { Fragment } from 'react';
import { platform } from './api';
import { Modal } from './components';

const mod = platform === 'darwin' ? 'Cmd' : 'Ctrl';
/** An Electron accelerator ("CommandOrControl+Shift+Space") as this platform names its keys. */
const accelerator = (value: string) => value.replace(/\b(CommandOrControl|CmdOrCtrl)\b/g, mod).replace(/\bCommand\b/g, 'Cmd').replace(/\bControl\b/g, 'Ctrl').split('+');
type Row = [keys: string[][], what: string];
/** One chord per inner list; alternatives are separate lists ("Home" or "End"). `Mod` becomes Ctrl or Cmd. */
const groups = (quickSearch: string): { title: string; rows: Row[] }[] => [
  { title: 'Anywhere in the window', rows: [
    [[['Mod', 'K']], 'Quick search the library and run commands'],
    [[accelerator(quickSearch)], 'Quick search from any app (set in Settings)'],
    [[['Mod', 'N']], 'Capture something new'],
    [[['Mod', 'F']], 'Search the library'],
    [[['Mod', 'V']], 'Paste text, links or files to capture them (outside a text field); dropping files does the same'],
    [[['Mod', 'Z']], 'Undo the last library action: trash, restore, status or archive, favourite, or move (up to 20)'],
    [[['?']], 'Show these shortcuts'],
    [[['Esc']], 'Close the open item, then clear a multi-selection; also closes menus, dialogs and the chat'],
  ] },
  { title: 'Library table (a row has focus)', rows: [
    [[['↑'], ['↓']], 'Previous or next item'],
    [[['Home'], ['End']], 'First or last item'],
    [[['Page Up'], ['Page Down']], 'A screenful up or down'],
    [[['Shift', '↑'], ['Shift', '↓'], ['Shift', 'Home'], ['Shift', 'End']], 'Extend the selection from the open item, like Shift-click (the Page keys too)'],
    [[['Mod', 'A']], 'Select every item shown'],
    [[['Enter']], 'Open the item and move to its main action; with several picked, move to the bulk actions'],
    [[['a–z']], 'Jump to the next title starting with the letters you type; a letter that is a shortcut below runs the shortcut instead'],
    [[['Shift', 'a–z']], 'Start jumping by title even with a shortcut letter; while you keep typing (under a second apart) letters extend the title'],
    [[['Mod', 'click'], ['Shift', 'click']], 'Pick several items, or a range'],
    [[['drag']], 'Drag rows up or down, or by their icon, onto a collection or Unfiled in the sidebar to move them; a picked row takes the whole selection'],
    [[['swipe']], 'Swipe a row sideways to archive it'],
    [[['Shift', 'F10']], 'On a column heading: Move left, Move right, Reset columns (drag a heading sideways to move it too)'],
  ] },
  { title: 'Item actions (on the focused row or the selection, and in its right-click menu)', rows: [
    [[['O']], 'Open'], [[['C']], 'Copy'], [[['F']], 'Add to or remove from favourites'], [[['E']], 'Open or reveal the stored file or link'],
    [[['W']], 'Show what was made from a source'], [[['S']], 'Open its source'],
    [[['1'], ['2'], ['4']], 'Status: draft, testing, rejected'], [[['A']], 'Archive'],
    [[['L']], 'Remove local copies…'], [[['M']], 'Move to collection…'], [[['D']], 'Move to trash (in Trash: delete permanently…)'], [[['R']], 'Restore from trash'],
  ] },
  { title: 'An open item', rows: [
    [[['Alt', '↑'], ['Alt', '↓']], 'Previous or next item in the list'],
    [[['Esc']], 'Back to the list, with the row still highlighted'],
  ] },
  { title: 'Menus', rows: [
    [[['↑'], ['↓'], ['Home'], ['End']], 'Move between entries'],
    [[['Enter'], ['Space']], 'Run the entry'],
    [[['letter']], 'Run the entry with that shortcut'],
    [[['Esc'], ['Tab']], 'Close and go back to where you were'],
  ] },
  { title: 'Query bar', rows: [
    [[['↑'], ['↓']], 'Choose a suggestion; ↓ with none open goes to the list'],
    [[['Enter'], ['Tab']], 'Add the suggestion as a filter'],
    [[['Backspace']], 'In an empty bar, remove the last filter'],
    [[['Esc']], 'Close the suggestions, then clear the text'],
  ] },
  { title: 'Collections in the sidebar', rows: [
    [[['O']], 'Show in library (right-click menu)'], [[['N']], 'New subfolder'], [[['R'], ['F2']], 'Rename in place'], [[['D']], 'Delete collection…'],
    [[['Enter']], 'Save a new name'], [[['Esc']], 'Keep the old name'], [[['drag']], 'Drag a collection onto another to nest it, or between rows to reorder'],
  ] },
  { title: 'Dialogs and editors', rows: [
    [[['Mod', 'Enter']], 'Save a capture, copy with variables filled in, or send a chat message'],
    [[['Mod', 'S']], 'Save a config file, or save an item edit as a new revision'],
    [[['Mod', 'F'], ['Mod', 'H']], 'Find or replace inside the code editor'],
    [[['Mod', 'Z']], 'Inside a text field or the editor, undo typing there instead'],
    [[['Esc']], 'Close the dialog'],
    [[['←'], ['→'], ['Home'], ['End']], 'Resize a focused divider'],
  ] },
  { title: 'Quick search window', rows: [
    [[['↑'], ['↓']], 'Choose a result'], [[['Enter']], 'Copy it (the top match if you have not chosen one)'], [[['Mod', 'Enter']], 'Open it in Kiln'],
    [[['Shift', 'Enter']], 'Test it'], [[['Tab']], 'More actions for it'], [[['>']], 'List only the commands'], [[['Esc']], 'Hide quick search'],
  ] },
];

/** Every shortcut on one sheet, opened with ? when no field has focus. */
export function ShortcutSheet({ quickSearch, onClose }: { quickSearch: string; onClose: () => void }) {
  return <Modal title="Keyboard shortcuts" subtitle={`Press ? outside a text field to see this again. ${mod} is ${platform === 'darwin' ? 'the Command key' : 'the Control key'}.`} onClose={onClose} wide>
    <div className="shortcut-sheet">{groups(quickSearch).map(group => <section key={group.title} aria-label={group.title}><h3>{group.title}</h3><dl>{group.rows.map(([keys, what]) => <Fragment key={what}><dt>{keys.map((chord, i) => <Fragment key={i}>{i > 0 && <span className="shortcut-or">/</span>}{chord.map((key, n) => <Fragment key={n}>{n > 0 && '+'}<kbd>{key === 'Mod' ? mod : key}</kbd></Fragment>)}</Fragment>)}</dt><dd>{what}</dd></Fragment>)}</dl></section>)}</div>
  </Modal>;
}
