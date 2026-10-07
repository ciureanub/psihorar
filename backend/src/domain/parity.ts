export type Parity = 'odd' | 'even';

export const DEFAULT_TIMEZONE = 'Europe/Bucharest';
export const SEMESTER_WEEKS = 20;

const DAY_MS = 86_400_000;

/** Calendar date ("YYYY-MM-DD") of an instant in the given timezone. */
export function localDateISO(instant: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Day index since epoch for a plain calendar date. Timezone-free. */
function dayNumber(dateISO: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO);
  if (!m) throw new Error(`Invalid ISO date: ${dateISO}`);
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
}

function fromDayNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** Monday of the week that contains the given calendar date. */
export function mondayOf(dateISO: string): string {
  const n = dayNumber(dateISO);
  // 1970-01-01 was a Thursday: (n + 3) % 7 gives 0 for Monday.
  const offset = (((n + 3) % 7) + 7) % 7;
  return fromDayNumber(n - offset);
}

/**
 * Semester week number of a calendar date. Week 1 is the week of
 * semesterStart. Dates before the semester give 0 or negative numbers.
 */
export function weekNumber(dateISO: string, semesterStartISO: string): number {
  const diff = dayNumber(mondayOf(dateISO)) - dayNumber(mondayOf(semesterStartISO));
  return Math.floor(diff / 7) + 1;
}

/** Week 1 is odd. */
export function parityOfWeek(week: number): Parity {
  return Math.abs(week) % 2 === 1 ? 'odd' : 'even';
}

export function parityOn(dateISO: string, semesterStartISO: string): Parity {
  return parityOfWeek(weekNumber(dateISO, semesterStartISO));
}

/** Last calendar day (Sunday) of a semester of `weeks` weeks. */
export function semesterEnd(semesterStartISO: string, weeks: number = SEMESTER_WEEKS): string {
  return fromDayNumber(dayNumber(mondayOf(semesterStartISO)) + weeks * 7 - 1);
}
