import type { ParsedSession, ParsedYear } from './parser.js';

/** Sessions currently stored for one group, keyed like the parsed data. */
export interface ExistingGroup {
  year: string;
  group: string;
  sessions: ParsedSession[];
}

export interface SessionChange {
  before: ParsedSession;
  after: ParsedSession;
}

export interface GroupDiff {
  year: string;
  group: string;
  isNewGroup: boolean;
  added: ParsedSession[];
  changed: SessionChange[];
  removed: ParsedSession[];
}

/**
 * Identity of a session inside a group. Professor, room, end time and the
 * optional flag are attributes: a difference there is a "changed" entry.
 */
function identity(s: ParsedSession): string {
  return [s.weekday, s.startTime, s.weekParity, s.type, s.name.toLowerCase()].join('|');
}

function sameAttributes(a: ParsedSession, b: ParsedSession): boolean {
  return (
    a.endTime === b.endTime &&
    a.professor === b.professor &&
    a.room === b.room &&
    a.isOptional === b.isOptional &&
    a.name === b.name
  );
}

/** Returns only the groups that actually differ. */
export function computeDiff(existing: ExistingGroup[], incoming: ParsedYear[]): GroupDiff[] {
  const current = new Map<string, ExistingGroup>();
  for (const g of existing) current.set(`${g.year}|${g.group}`, g);

  const out: GroupDiff[] = [];
  const visited = new Set<string>();

  for (const year of incoming) {
    for (const group of year.groups) {
      const key = `${year.name}|${group.name}`;
      visited.add(key);
      const old = current.get(key);
      const oldById = new Map((old?.sessions ?? []).map((s) => [identity(s), s]));
      const diff: GroupDiff = {
        year: year.name,
        group: group.name,
        isNewGroup: !old,
        added: [],
        changed: [],
        removed: [],
      };
      for (const s of group.sessions) {
        const id = identity(s);
        const before = oldById.get(id);
        if (!before) diff.added.push(s);
        else if (!sameAttributes(before, s)) diff.changed.push({ before, after: s });
        oldById.delete(id);
      }
      diff.removed.push(...oldById.values());
      if (diff.isNewGroup || diff.added.length || diff.changed.length || diff.removed.length) {
        out.push(diff);
      }
    }
  }

  // Groups that exist in the database but are absent from the file.
  for (const [key, g] of current) {
    if (visited.has(key) || g.sessions.length === 0) continue;
    out.push({
      year: g.year,
      group: g.group,
      isNewGroup: false,
      added: [],
      changed: [],
      removed: [...g.sessions],
    });
  }
  return out;
}
