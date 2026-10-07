import { describe, expect, it } from 'vitest';
import {
  localDateISO,
  mondayOf,
  parityOfWeek,
  parityOn,
  semesterEnd,
  weekNumber,
} from '../src/domain/parity.js';

const START = '2026-09-28';

describe('week parity', () => {
  it('2026-09-28 is week 1, odd', () => {
    expect(weekNumber('2026-09-28', START)).toBe(1);
    expect(parityOn('2026-09-28', START)).toBe('odd');
  });

  it('2026-10-07 is week 2, even', () => {
    expect(weekNumber('2026-10-07', START)).toBe(2);
    expect(parityOn('2026-10-07', START)).toBe('even');
  });

  it('a whole week shares one number, Sunday included', () => {
    expect(weekNumber('2026-10-04', START)).toBe(1);
    expect(weekNumber('2026-10-05', START)).toBe(2);
    expect(weekNumber('2026-10-11', START)).toBe(2);
  });

  it('is stable across the DST change on 2026-10-25', () => {
    expect(weekNumber('2026-10-25', START)).toBe(4);
    expect(weekNumber('2026-10-26', START)).toBe(5);
    expect(parityOfWeek(5)).toBe('odd');
  });

  it('mondayOf returns the Monday of the week', () => {
    expect(mondayOf('2026-10-07')).toBe('2026-10-05');
    expect(mondayOf('2026-10-05')).toBe('2026-10-05');
    expect(mondayOf('2026-10-11')).toBe('2026-10-05');
  });

  it('semester of 20 weeks ends on Sunday 2027-02-14', () => {
    expect(semesterEnd(START, 20)).toBe('2027-02-14');
    expect(weekNumber('2027-02-14', START)).toBe(20);
  });

  it('uses the Europe/Bucharest calendar date, not UTC', () => {
    // 22:30 UTC on Sunday is already Monday 01:30 in Bucharest (UTC+3).
    const instant = new Date('2026-10-04T22:30:00Z');
    expect(localDateISO(instant)).toBe('2026-10-05');
    expect(weekNumber(localDateISO(instant), START)).toBe(2);
  });
});
