import type { SessionType } from './parser.js';

/**
 * Sessions removed from the timetable on request. They are skipped when the
 * faculty workbook is read, so a later import does not bring them back.
 * To restore one, delete its line here.
 */
export const EXCLUDED_SESSIONS: { name: string; type: SessionType }[] = [
  { name: 'Autocunoaștere și mindset pentru un parcurs academic de succes', type: 'seminar' },
  { name: 'Autocunoaștere și mindset pentru un parcurs academic de succes', type: 'curs' },
  { name: 'Comunicare, fake news şi rezilienţă la dezinformare', type: 'seminar' },
];

/** Case-insensitive, and blind to diacritics (the workbook mixes "ş" and "ș"). */
function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

const EXCLUDED_KEYS = new Set(EXCLUDED_SESSIONS.map((e) => `${e.type}|${normalize(e.name)}`));

export function isExcluded(session: { name: string; type: SessionType }): boolean {
  return EXCLUDED_KEYS.has(`${session.type}|${normalize(session.name)}`);
}
