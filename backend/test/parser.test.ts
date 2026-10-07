import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { computeDiff } from '../src/import/diff.js';
import {
  normalizeGroupName,
  parseCell,
  parseWorkbook,
  type ParsedWorkbook,
} from '../src/import/parser.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/PSIH.xlsx', import.meta.url));

describe('parseCell', () => {
  it('keeps commas inside the name and inside the room', () => {
    const cell = parseCell(
      'Comunicare, fake news şi rezilienţă la dezinformare (Op), S, Spec. Raileanu-Olariu Teodor, corp E, P3',
    );
    expect(cell).toEqual({
      name: 'Comunicare, fake news şi rezilienţă la dezinformare',
      type: 'seminar',
      professor: 'Spec. Raileanu-Olariu Teodor',
      room: 'corp E, P3',
      isOptional: true,
    });
  });

  it('maps C to curs and leaves non-optional sessions unflagged', () => {
    expect(parseCell(' Neuroștiințe, C, CSI Juravle Georgiana, D4')).toEqual({
      name: 'Neuroștiințe',
      type: 'curs',
      professor: 'CSI Juravle Georgiana',
      room: 'D4',
      isOptional: false,
    });
  });

  it('reports cells without a type token instead of guessing', () => {
    expect(parseCell('Consultații')).toHaveProperty('error');
    expect(parseCell('Statistică, S, Asist.Dr. Arhiri Laura')).toHaveProperty('error');
  });
});

describe('normalizeGroupName', () => {
  it('fixes inconsistent casing', () => {
    expect(normalizeGroupName('Grupa v')).toBe('Grupa V');
    expect(normalizeGroupName('Grupa Vii')).toBe('Grupa VII');
    expect(normalizeGroupName('Grupa 3')).toBe('Grupa III');
    expect(normalizeGroupName('ANUL I')).toBeNull();
  });
});

describe('workbook import', () => {
  let wb: ParsedWorkbook;
  beforeAll(async () => {
    wb = await parseWorkbook(await readFile(FIXTURE));
  });

  const psih1 = () => {
    const year = wb.years.find((y) => y.sourceSheet === 'PSIH 1');
    if (!year) throw new Error('PSIH 1 not parsed');
    return year;
  };

  it('PSIH 1 yields An I with 10 groups', () => {
    const year = psih1();
    expect(year.name).toBe('An I');
    expect(year.groups.map((g) => g.name)).toEqual([
      'Grupa I', 'Grupa II', 'Grupa III', 'Grupa IV', 'Grupa V',
      'Grupa VI', 'Grupa VII', 'Grupa VIII', 'Grupa IX', 'Grupa X',
    ]);
  });

  it('Grupa I has exactly 20 sessions', () => {
    const g1 = psih1().groups.find((g) => g.name === 'Grupa I');
    expect(g1?.sessions).toHaveLength(20);
  });

  it('vertical merge means weekly, single row means that parity only', () => {
    const g1 = psih1().groups.find((g) => g.name === 'Grupa I')!;
    const tuesday8 = g1.sessions.find((s) => s.weekday === 2 && s.startTime === '08:00');
    expect(tuesday8).toMatchObject({ name: 'Neuroștiințe', type: 'curs', weekParity: 'all', room: 'D4' });

    const monday10 = g1.sessions.filter((s) => s.weekday === 1 && s.startTime === '10:00');
    expect(monday10.map((s) => s.weekParity).sort()).toEqual(['even', 'odd']);
    expect(monday10.every((s) => s.isOptional)).toBe(true);
  });

  it('horizontal merge is shared by every covered group', () => {
    for (const group of psih1().groups) {
      const shared = group.sessions.find(
        (s) => s.weekday === 1 && s.startTime === '10:00' && s.weekParity === 'even',
      );
      expect(shared?.name, group.name).toBe('Tehnici şi abilităţi academice');
    }
  });

  it('practice sessions take their time range from the cell text', () => {
    expect(wb.errors).toEqual([]);
    const year3 = wb.years.find((y) => y.sourceSheet === 'PSIH 3');
    const practice = (year3?.groups ?? []).flatMap((g) => g.sessions.filter((s) => s.type === 'practica'));
    expect(practice.length).toBeGreaterThanOrEqual(10);
    expect(practice.every((s) => s.name.startsWith('Practică pedagogică'))).toBe(true);
    expect(practice.every((s) => !/\d{1,2}:\d{2}/.test(s.name))).toBe(true);
    expect(
      parseCell('Practică pedagogică (sem I) - Subgrupa 1.2. (10:00 - 13:00), PPED_I, Conf.Dr. Popusoi Simona Andreea, fs'),
    ).toEqual({
      name: 'Practică pedagogică (sem I) - Subgrupa 1.2.',
      type: 'practica',
      professor: 'Conf.Dr. Popusoi Simona Andreea',
      room: 'fs',
      isOptional: false,
      startTime: '10:00',
      endTime: '13:00',
    });
  });

  it('PSIH 1 has no unparseable cells', () => {
    expect(wb.errors.filter((e) => e.sheet === 'PSIH 1')).toEqual([]);
  });

  it('reads sheets whose table starts in another column (PSIH 2, PSIH 3)', () => {
    const year2 = wb.years.find((y) => y.sourceSheet === 'PSIH 2');
    const year3 = wb.years.find((y) => y.sourceSheet === 'PSIH 3');
    expect(year2?.name).toBe('An II');
    expect(year3?.name).toBe('An III');
    expect(year2?.groups).toHaveLength(10);
    // In the fixture, the "Grupa X" column of year II is empty.
    const filled = (groups: { sessions: unknown[] }[] = []) =>
      groups.filter((g) => g.sessions.length > 0).length;
    expect(filled(year2?.groups)).toBe(9);
    expect(filled(year3?.groups)).toBe(9);
    const first = year2?.groups[0]?.sessions.find((s) => s.weekday === 1 && s.startTime === '08:00');
    expect(first).toMatchObject({ name: 'Psihologia sinelui', type: 'seminar', isOptional: true, weekParity: 'odd' });
  });

  it('diff against an empty database adds everything, and is empty when unchanged', () => {
    const fresh = computeDiff([], wb.years);
    const g1 = fresh.find((d) => d.year === 'An I' && d.group === 'Grupa I');
    expect(g1?.added).toHaveLength(20);
    expect(g1?.isNewGroup).toBe(true);

    const existing = wb.years.flatMap((y) =>
      y.groups.map((g) => ({ year: y.name, group: g.name, sessions: g.sessions })),
    );
    expect(computeDiff(existing, wb.years)).toEqual([]);
  });

  it('diff reports a room change as "changed" for that group only', () => {
    const existing = wb.years.flatMap((y) =>
      y.groups.map((g) => ({
        year: y.name,
        group: g.name,
        sessions: g.sessions.map((s) => ({ ...s })),
      })),
    );
    const target = existing.find((g) => g.year === 'An I' && g.group === 'Grupa I')!;
    const session = target.sessions.find((s) => s.weekday === 3 && s.startTime === '16:00')!;
    session.room = 'D1';
    const diff = computeDiff(existing, wb.years);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({ group: 'Grupa I', added: [], removed: [] });
    expect(diff[0]?.changed).toHaveLength(1);
  });
});
