/** Visitors who ask for reduced motion get every end state at once: no flights, no staggered pen strokes, no replayed delays. */
export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Pause between animation beats; resolves immediately for reduced motion. */
export const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, prefersReducedMotion() ? 0 : ms));

/** Re-trigger a CSS animation class on an element that may already have it. */
export function restart(el: Element | null | undefined, className: string) {
  if (!el) return;
  el.classList.remove(className);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(className);
}
