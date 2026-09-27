/**
 * Experimental features: changes that ship switched off and are turned on one at a time in Settings → Experimental features,
 * so each can be tried on a real library before it becomes the default. A flag that graduates is removed from this list
 * together with the code paths it guarded. Flags live in the machine-private settings.json, never in the library.
 */
export const experiments = [
  { id: 'installUpdates', title: 'Update installed copies', description: 'Installed copies that are behind the approved version show "Update available", and one button approves and updates every copy.' },
  { id: 'keepOutsideEdits', title: 'Keep changes made outside Kiln', description: 'When a Kiln-installed skill was edited in its folder, "Keep these changes" saves that copy as a new draft of the same item.' },
  { id: 'codeEditor', title: 'Code editor', description: 'A real editor for items and config files: highlighting, line numbers, find, Ctrl+S, live SKILL.md checks and editable bundled text files.' },
  { id: 'autoSync', title: 'Background sync with GitHub', description: 'Checks GitHub every few minutes, shows what is new in the top bar with one-click Pull, and lets Merge run while you have drafts.' },
  { id: 'trialLoop', title: 'Improve and re-test from experiments', description: 'Experiment results offer "Improve with agent" and "Re-test current revision", group by revision, and get longer time limits.' },
  { id: 'runNotifications', title: 'Run notifications and runs list', description: 'A desktop notification and a toast when an agent run finishes, and a list of every active run in the top bar.' },
  { id: 'betterSearch', title: 'Steadier, ranked search', description: 'Search keeps results on screen while typing, ranks by relevance, and quick search confirms the copy and hides when you click away.' },
  { id: 'chatHistory', title: 'Docked chat with history', description: 'Ask the agent opens beside the item, keeps each item\'s conversation, renders Markdown and shows changes the agent made.' },
  { id: 'keyboardUndo', title: 'Keyboard navigation and undo', description: 'Enter, Home, End, Page keys and Shift+arrows in the list, a ? shortcut sheet, Ctrl+Z for trash, moves and status, and dragging items onto collections.' },
  { id: 'projectInstalls', title: 'Install into project folders', description: 'Install a skill into any project folder from its Installs tab, without enrolling the project from the command line first.' },
] as const;

export type ExperimentId = typeof experiments[number]['id'];
export type ExperimentFlags = Partial<Record<ExperimentId, boolean>>;
export const experimentIds = experiments.map(e => e.id) as ExperimentId[];

/**
 * `KILN_EXPERIMENTS` turns flags on for a whole process ("all", or a comma-separated list of ids), for tests and trying
 * everything at once. It only adds to what Settings has turned on.
 */
export function environmentExperiments(value = typeof process === 'undefined' ? undefined : process.env.KILN_EXPERIMENTS): ExperimentFlags {
  if (!value) return {};
  const wanted = value.trim() === 'all' ? experimentIds : value.split(',').map(v => v.trim()).filter((v): v is ExperimentId => (experimentIds as string[]).includes(v));
  return Object.fromEntries(wanted.map(id => [id, true]));
}

/** Whether an experiment is on in these settings. Unknown or missing flags are off. */
export function experimentOn(settings: { experiments?: ExperimentFlags } | null | undefined, id: ExperimentId): boolean {
  return settings?.experiments?.[id] === true;
}
