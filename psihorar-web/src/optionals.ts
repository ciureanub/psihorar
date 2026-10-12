/**
 * Optional disciplines that students switch on or off in the timetable.
 * Hiding one removes both its curs and its seminar, in every week.
 * `defaultOn` is what a student sees before touching the switches.
 */
export interface OptionalDiscipline {
  year: string;
  code: string;
  name: string;
  defaultOn: boolean;
}

export const OPTIONALS: OptionalDiscipline[] = [
  { year: 'An I', code: 'AMPAC', name: 'Autocunoaștere și mindset pentru un parcurs academic de succes', defaultOn: false },
  { year: 'An I', code: 'TAA', name: 'Tehnici şi abilităţi academice', defaultOn: true },
  { year: 'An I', code: 'CAP', name: 'Comunicarea aplicată pentru psihologi', defaultOn: true },
  { year: 'An I', code: 'CFRD', name: 'Comunicare, fake news şi rezilienţă la dezinformare', defaultOn: false },
];

/** Case-insensitive, and blind to diacritics (the workbook mixes "ş" and "ș"). */
export function normalizeName(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Acronym of the optional discipline a session belongs to, or null. */
export function optionalCode(yearName: string, sessionName: string): string | null {
  const key = normalizeName(sessionName);
  return OPTIONALS.find((o) => o.year === yearName && normalizeName(o.name) === key)?.code ?? null;
}

/** "AMPAC,CFRD" -> Set{"AMPAC","CFRD"}; unknown codes are ignored. */
export function parseHidden(value: string | undefined): Set<string> {
  const known = new Set(OPTIONALS.map((o) => o.code));
  return new Set((value ?? '').split(',').map((c) => c.trim().toUpperCase()).filter((c) => known.has(c)));
}
