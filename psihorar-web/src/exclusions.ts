import type { SessionType } from './parser.js';

/**
 * Sessions removed from the timetable for everyone. They are skipped when the
 * faculty workbook is read and purged from stored data at start-up.
 * Optional disciplines that students may want are not listed here: they are
 * switched on or off per student (see optionals.ts).
 */
export const EXCLUDED_SESSIONS: { name: string; type: SessionType }[] = [];

/** Case-insensitive, and blind to diacritics (the workbook mixes "ş" and "ș"). */
function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function isExcluded(session: { name: string; type: SessionType }): boolean {
  const key = `${session.type}|${normalize(session.name)}`;
  return EXCLUDED_SESSIONS.some((e) => `${e.type}|${normalize(e.name)}` === key);
}
