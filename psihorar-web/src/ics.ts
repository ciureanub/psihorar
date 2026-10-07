import { mondayOf, semesterEnd } from './parity.js';
import type { Config, Session } from './store.js';

const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Bucharest',
  'BEGIN:STANDARD',
  'DTSTART:19701025T040000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'TZOFFSETFROM:+0300',
  'TZOFFSETTO:+0200',
  'TZNAME:EET',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:19700329T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0300',
  'TZNAME:EEST',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
];

const TYPE_LABEL = { curs: 'Curs', seminar: 'Seminar', practica: 'Practică' } as const;

function addDays(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** RFC 5545 line folding at 75 octets. */
function fold(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > (out.length ? 74 : 75)) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

/**
 * Calendar subscription for one group. Weekly sessions repeat every week,
 * odd/even sessions every 2 weeks, all until the end of the semester.
 */
export function buildCalendar(
  config: Config,
  group: { id: string; name: string; yearName: string },
  sessions: Session[],
  now: Date = new Date(),
): string {
  const monday = mondayOf(config.semesterStart);
  const end = semesterEnd(config.semesterStart, config.semesterWeeks);
  const compact = (dateISO: string, hhmm: string) =>
    `${dateISO.replace(/-/g, '')}T${hhmm.replace(':', '')}00`;
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  // 21:59:59 UTC is the end of the local day in winter time (and past it in summer time).
  const until = `${end.replace(/-/g, '')}T215959Z`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PsihORAR//Orar//RO',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(`PsihORAR ${group.yearName} ${group.name}`)}`,
    'X-WR-TIMEZONE:Europe/Bucharest',
    ...VTIMEZONE,
  ];
  for (const s of sessions) {
    const first = addDays(monday, s.weekday - 1 + (s.weekParity === 'even' ? 7 : 0));
    if (first > end) continue;
    const interval = s.weekParity === 'all' ? 1 : 2;
    const parity =
      s.weekParity === 'all' ? 'săptămânal' : s.weekParity === 'odd' ? 'săptămâni impare' : 'săptămâni pare';
    const title = `${s.name}${s.isOptional ? ' (Opt.)' : ''} · ${TYPE_LABEL[s.type]}`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${s.id}@psihorar`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Europe/Bucharest:${compact(first, s.startTime)}`,
      `DTEND;TZID=Europe/Bucharest:${compact(first, s.endTime)}`,
      `RRULE:FREQ=WEEKLY;INTERVAL=${interval};UNTIL=${until}`,
      `SUMMARY:${escapeText(title)}`,
      `LOCATION:${escapeText(s.room)}`,
      `DESCRIPTION:${escapeText(`Profesor coordonator: ${s.professor}\nSala: ${s.room}\n${parity}`)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
