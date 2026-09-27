import { Notification, type BrowserWindow } from 'electron';
import { runNotice, type RunFinished } from '../../packages/agent/run-notice';

/** Shown notifications stay referenced until clicked or dismissed, so their click handler is not garbage collected first. */
const shown = new Set<Notification>();

/**
 * runNotifications: a desktop notification when an agent run ends while Kiln is not in front (hidden in the tray, minimised or
 * behind another window). In front, the in-app toast is enough. Clicking it brings Kiln back and opens the run's result.
 */
export async function notifyRunFinished(event: RunFinished, options: { window: () => BrowserWindow | undefined; enabled: () => Promise<boolean>; open: (event: RunFinished) => Promise<void>; log: (event: string, fields?: Record<string, unknown>) => void }) {
  const notice = runNotice(event);
  if (!notice || !(await options.enabled())) return;
  const window = options.window();
  if (!window || window.isDestroyed() || (window.isVisible() && !window.isMinimized() && window.isFocused())) return;
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: notice.title, body: notice.body });
  shown.add(notification);
  notification.on('click', () => { shown.delete(notification); void options.open(event).catch(error => options.log('run.notification.openFailed', { message: error instanceof Error ? error.message : String(error) })); });
  notification.on('close', () => shown.delete(notification));
  notification.show();
  options.log('run.notified', { kind: event.kind, status: event.status });
}

/**
 * Script for the main window that opens a finished run: the runs list (src/Runs.tsx) opens the item on the tab that holds the
 * result and cancels the event; without it (flag just turned off, or setup is showing) the item opens the ordinary way.
 */
export function openRunScript(event: RunFinished) {
  const detail = JSON.stringify({ id: event.id, itemId: event.itemId, kind: event.kind });
  return `if (window.dispatchEvent(new CustomEvent('kiln:open-run', { cancelable: true, detail: ${detail} }))) location.hash = ${JSON.stringify('item=' + encodeURIComponent(event.itemId) + '&open=' + Date.now())}; true`;
}
