import ExcelJS from 'exceljs';
import { isExcluded } from './exclusions.js';

export type SessionType = 'curs' | 'seminar' | 'practica';
export type WeekParity = 'all' | 'odd' | 'even';

export interface ParsedSession {
  weekday: number; // 1 = Monday ... 5 = Friday
  startTime: string; // "HH:mm"
  endTime: string;
  name: string;
  type: SessionType;
  professor: string;
  room: string;
  weekParity: WeekParity;
  isOptional: boolean;
}

export interface ParsedGroup {
  name: string;
  sessions: ParsedSession[];
}

export interface ParsedYear {
  name: string;
  sourceSheet: string;
  groups: ParsedGroup[];
}

export interface ImportError {
  sheet: string;
  cell: string;
  text: string;
  reason: string;
}

export interface ParsedWorkbook {
  years: ParsedYear[];
  errors: ImportError[];
}

export interface ParsedCell {
  name: string;
  type: SessionType;
  professor: string;
  room: string;
  isOptional: boolean;
  /** Set when the cell carries its own time range (practică), overriding the row slot. */
  startTime?: string;
  endTime?: string;
}

const WEEKDAYS: Record<string, number> = {
  LUNI: 1,
  MARTI: 2,
  MIERCURI: 3,
  JOI: 4,
  VINERI: 5,
};

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** "Grupa Vii" -> "Grupa VII". Returns null when the text is not a group header. */
export function normalizeGroupName(text: string): string | null {
  const m = /^\s*grupa\s+([ivxlc]+|\d+)\s*$/i.exec(text);
  if (!m || !m[1]) return null;
  const raw = m[1].toUpperCase();
  if (/^\d+$/.test(raw)) {
    const roman = ROMAN[Number(raw)];
    return roman ? `Grupa ${roman}` : `Grupa ${raw}`;
  }
  return `Grupa ${raw}`;
}

/**
 * Parses "Name (Op), C|S, Professor, Room".
 * The name may contain commas, so the split happens on the ", C," / ", S,"
 * token. Everything after the professor is the room (rooms may contain commas).
 */
export function parseCell(text: string): ParsedCell | { error: string } {
  const clean = text.replace(/\s+/g, ' ').trim();
  const m = /^(.+?)\s*,\s*([CS])\s*,\s*(.+)$/.exec(clean);
  if (!m || !m[1] || !m[2] || !m[3]) {
    return parsePractice(clean) ?? { error: 'Missing ", C," or ", S," type token' };
  }
  const optionalRe = /\(\s*op\.?\s*\)/i;
  const isOptional = optionalRe.test(m[1]);
  const name = m[1].replace(optionalRe, '').replace(/\s+/g, ' ').trim();
  if (!name) return { error: 'Empty session name' };

  const rest = m[3];
  const comma = rest.indexOf(',');
  const professor = (comma === -1 ? rest : rest.slice(0, comma)).trim();
  const room = comma === -1 ? '' : rest.slice(comma + 1).trim();
  if (!professor) return { error: 'Missing professor' };
  if (!room) return { error: 'Missing room' };

  return { name, type: m[2] === 'C' ? 'curs' : 'seminar', professor, room, isOptional };
}

/**
 * Practice sessions use another layout:
 * "Practică pedagogică (sem I) 10:00-13:00, PPED_I, Professor, Room".
 * No C/S token, a discipline code instead, and the real time range in the name.
 */
function parsePractice(clean: string): ParsedCell | { error: string } | null {
  if (!/^practic[aă](?=\s)/i.test(clean)) return null;
  const parts = clean.split(',').map((p) => p.trim());
  if (parts.length < 4 || !/^[A-Z]+_[A-Z0-9]+$/.test(parts[1] ?? '')) return null;
  const time = /\(?\s*(\d{1,2})[:.](\d{2})\s*-\s*(\d{1,2})[:.](\d{2})\s*\)?/.exec(parts[0] ?? '');
  if (!time) return { error: 'Practice session without a time range' };
  const pad = (h: string | undefined) => (h ?? '').padStart(2, '0');
  const name = (parts[0] ?? '')
    .replace(time[0], ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s-]+$/, '')
    .trim();
  const professor = parts[2] ?? '';
  const room = parts.slice(3).join(', ');
  if (!name || !professor || !room) return { error: 'Incomplete practice session' };
  return {
    name,
    type: 'practica',
    professor,
    room,
    isOptional: false,
    startTime: `${pad(time[1])}:${time[2]}`,
    endTime: `${pad(time[3])}:${time[4]}`,
  };
}

function parseSlot(text: string): { start: string; end: string } | null {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*-\s*(\d{1,2})[:.](\d{2})\s*$/.exec(text);
  if (!m) return null;
  const pad = (h: string | undefined) => (h ?? '').padStart(2, '0');
  return { start: `${pad(m[1])}:${m[2]}`, end: `${pad(m[3])}:${m[4]}` };
}

function parseParity(text: string): 'odd' | 'even' | null {
  const t = text.replace(/\s+/g, '').toLowerCase();
  if (t === 's.i.' || t === 's.i' || t === 'si') return 'odd';
  if (t === 's.p.' || t === 's.p' || t === 'sp') return 'even';
  return null;
}

function colLetter(col: number): string {
  let s = '';
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

function colNumber(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('text' in value) return String(value.text);
    if ('result' in value) return String(value.result ?? '');
    return '';
  }
  return String(value);
}

function romanFromSheetName(sheetName: string): string | null {
  const m = /(\d+)\s*$/.exec(sheetName);
  return m && m[1] ? ROMAN[Number(m[1])] ?? null : null;
}

function yearName(ws: ExcelJS.Worksheet): string {
  const cols = Math.max(ws.actualColumnCount, ws.columnCount);
  for (let r = 1; r <= 3; r++) {
    for (let c = 1; c <= cols; c++) {
      const m = /\ban(?:ul)?\s+([ivx]+)\s*$/i.exec(cellText(ws.getCell(r, c).value).trim());
      if (m && m[1]) return `An ${m[1].toUpperCase()}`;
    }
  }
  const roman = romanFromSheetName(ws.name);
  return roman ? `An ${roman}` : ws.name;
}

interface Merge {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

function readMerges(ws: ExcelJS.Worksheet): Merge[] {
  const raw = ((ws as unknown as { model: { merges?: string[] } }).model.merges ?? []) as string[];
  const out: Merge[] = [];
  for (const range of raw) {
    const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
    if (!m || !m[1] || !m[2] || !m[3] || !m[4]) continue;
    out.push({
      left: colNumber(m[1]),
      top: Number(m[2]),
      right: colNumber(m[3]),
      bottom: Number(m[4]),
    });
  }
  return out;
}

function parseSheet(ws: ExcelJS.Worksheet, errors: ImportError[]): ParsedYear | null {
  const sheet = ws.name;
  const merges = readMerges(ws);
  const master = new Map<string, Merge>();
  for (const mg of merges) {
    for (let r = mg.top; r <= mg.bottom; r++) {
      for (let c = mg.left; c <= mg.right; c++) master.set(`${r}:${c}`, mg);
    }
  }
  /** Value of a cell, resolved through its merge range, plus the master address. */
  const resolve = (r: number, c: number): { text: string; address: string } => {
    const mg = master.get(`${r}:${c}`);
    const rr = mg ? mg.top : r;
    const cc = mg ? mg.left : c;
    return { text: cellText(ws.getCell(rr, cc).value).trim(), address: `${colLetter(cc)}${rr}` };
  };

  // Header row: the first row (within the top 10) that has group names.
  let headerRow = 0;
  const groupCols: { col: number; name: string }[] = [];
  const maxCol = Math.max(ws.actualColumnCount, ws.columnCount);
  for (let r = 1; r <= 10 && !headerRow; r++) {
    for (let c = 1; c <= maxCol; c++) {
      const name = normalizeGroupName(cellText(ws.getCell(r, c).value));
      if (name) groupCols.push({ col: c, name });
    }
    if (groupCols.length) headerRow = r;
  }
  if (!headerRow) {
    errors.push({ sheet, cell: 'A1', text: '', reason: 'No group header row ("Grupa ...") found' });
    return null;
  }
  const seen = new Set<string>();
  for (const g of groupCols) {
    if (seen.has(g.name)) {
      errors.push({
        sheet,
        cell: `${colLetter(g.col)}${headerRow}`,
        text: g.name,
        reason: 'Duplicate group name in header',
      });
    }
    seen.add(g.name);
  }

  // The table may start in any column (sheets are offset differently): the
  // day, time slot and parity columns sit immediately left of the first group.
  const firstGroupCol = Math.min(...groupCols.map((g) => g.col));
  const parityCol = firstGroupCol - 1;
  const slotCol = firstGroupCol - 2;
  const dayCol = firstGroupCol - 3;
  if (dayCol < 1) {
    errors.push({
      sheet,
      cell: `${colLetter(firstGroupCol)}${headerRow}`,
      text: '',
      reason: 'Expected day, time slot and parity columns left of the first group',
    });
    return null;
  }

  type Half = { text: string; address: string };
  const slots = new Map<string, { odd?: Half; even?: Half }>();
  const order: string[] = [];

  let weekday = 0;
  let slot: { start: string; end: string } | null = null;
  const lastRow = ws.actualRowCount || ws.rowCount;

  for (let r = headerRow + 1; r <= lastRow; r++) {
    const dayText = cellText(ws.getCell(r, dayCol).value).trim();
    if (dayText) {
      const key = stripDiacritics(dayText).toUpperCase();
      const wd = WEEKDAYS[key];
      if (wd) {
        weekday = wd;
        slot = null;
      } else if (parseParity(cellText(ws.getCell(r, parityCol).value))) {
        errors.push({ sheet, cell: `${colLetter(dayCol)}${r}`, text: dayText, reason: 'Unknown weekday' });
        weekday = 0;
      }
    }
    const slotText = cellText(ws.getCell(r, slotCol).value).trim();
    if (slotText) {
      const parsed = parseSlot(slotText);
      if (parsed) slot = parsed;
      else if (parseParity(cellText(ws.getCell(r, parityCol).value))) {
        errors.push({ sheet, cell: `${colLetter(slotCol)}${r}`, text: slotText, reason: 'Unreadable time slot' });
        slot = null;
      }
    }
    const parity = parseParity(cellText(ws.getCell(r, parityCol).value));
    if (!parity) continue;

    for (const g of groupCols) {
      const cell = resolve(r, g.col);
      if (!cell.text) continue;
      if (!weekday || !slot) {
        errors.push({
          sheet,
          cell: cell.address,
          text: cell.text,
          reason: 'Cell is outside a known weekday / time slot',
        });
        continue;
      }
      const key = `${g.name}|${weekday}|${slot.start}|${slot.end}`;
      let entry = slots.get(key);
      if (!entry) {
        entry = {};
        slots.set(key, entry);
        order.push(key);
      }
      entry[parity] = cell;
    }
  }

  const byGroup = new Map<string, ParsedSession[]>();
  for (const g of groupCols) if (!byGroup.has(g.name)) byGroup.set(g.name, []);
  const reported = new Set<string>();

  const push = (key: string, half: Half, weekParity: WeekParity) => {
    const [groupName, wd, start, end] = key.split('|') as [string, string, string, string];
    const parsed = parseCell(half.text);
    if ('error' in parsed) {
      // A merged cell is shared by several groups: report it once.
      if (!reported.has(half.address)) {
        reported.add(half.address);
        errors.push({ sheet, cell: half.address, text: half.text, reason: parsed.error });
      }
      return;
    }
    if (isExcluded(parsed)) return;
    byGroup.get(groupName)?.push({
      weekday: Number(wd),
      weekParity,
      name: parsed.name,
      type: parsed.type,
      professor: parsed.professor,
      room: parsed.room,
      isOptional: parsed.isOptional,
      startTime: parsed.startTime ?? start,
      endTime: parsed.endTime ?? end,
    });
  };

  for (const key of order) {
    const entry = slots.get(key);
    if (!entry) continue;
    if (entry.odd && entry.even && entry.odd.text === entry.even.text) {
      push(key, entry.odd, 'all');
    } else {
      if (entry.odd) push(key, entry.odd, 'odd');
      if (entry.even) push(key, entry.even, 'even');
    }
  }

  const groups: ParsedGroup[] = [];
  for (const [name, sessions] of byGroup) {
    sessions.sort(
      (a, b) =>
        a.weekday - b.weekday ||
        a.startTime.localeCompare(b.startTime) ||
        a.weekParity.localeCompare(b.weekParity),
    );
    groups.push({ name, sessions });
  }
  if (groups.every((g) => g.sessions.length === 0)) {
    errors.push({
      sheet,
      cell: `${colLetter(firstGroupCol)}${headerRow}`,
      text: '',
      reason: 'Group header found but no sessions could be read from this sheet',
    });
  }
  return { name: yearName(ws), sourceSheet: sheet, groups };
}

/** Parses the faculty timetable workbook. Never drops a cell silently. */
export async function parseWorkbook(data: Buffer | ArrayBuffer): Promise<ParsedWorkbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as ArrayBuffer);
  const years: ParsedYear[] = [];
  const errors: ImportError[] = [];
  for (const ws of wb.worksheets) {
    const year = parseSheet(ws, errors);
    if (year) years.push(year);
  }
  return { years, errors };
}
