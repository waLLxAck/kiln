/**
 * Dates as the app shows them. The formatters are made once: building one per call (what `toLocaleString` with options does)
 * was most of the library list's render time, at three dates per row.
 */
const parts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
const thisYear = new Intl.DateTimeFormat(undefined, parts), otherYear = new Intl.DateTimeFormat(undefined, { ...parts, year: 'numeric' });
/** "6 Sept, 16:40" for this year; older dates add the year so "6 Sept" from three years ago is not mistaken for last week. */
export function date(value: string) {
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return 'Invalid Date';
  return (when.getFullYear() !== new Date().getFullYear() ? otherYear : thisYear).format(when);
}
