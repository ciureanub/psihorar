import { computeDiff, type GroupDiff } from '../import/diff.js';
import type { ParsedSession } from '../import/parser.js';
import type { PushResult, PushSender } from '../push/apns.js';
import type { Group, Store } from '../store/types.js';

const DAYS = ['', 'luni', 'marți', 'miercuri', 'joi', 'vineri'];

function describe(s: ParsedSession): string {
  return `${s.name}, ${DAYS[s.weekday] ?? ''}, sala ${s.room}`;
}

/** Romanian alert text for one group's changes, e.g. "Orar modificat: Statistică, miercuri, sala D4". */
export function changeSummary(diff: GroupDiff): string {
  const first = diff.changed[0]?.after ?? diff.added[0] ?? diff.removed[0];
  if (!first) return 'Orarul a fost actualizat.';
  const total = diff.changed.length + diff.added.length + diff.removed.length;
  const prefix = diff.changed.length ? 'Orar modificat' : diff.added.length ? 'Oră nouă' : 'Oră anulată';
  const more = total > 1 ? ` și încă ${total - 1}` : '';
  return `${prefix}: ${describe(first)}${more}`;
}

export interface PublishOutcome {
  groups: { id: string; year: string; name: string; version: number }[];
  push: PushResult;
}

/**
 * Sends the visible alert plus the silent sync push to the devices of the
 * given groups, then removes tokens APNs rejected.
 */
export async function notifyGroups(
  store: Store,
  push: PushSender,
  groups: { group: Group; summary: string }[],
): Promise<PushResult> {
  const total: PushResult = { sent: 0, invalidTokens: [], failures: [] };
  for (const { group, summary } of groups) {
    const devices = await store.devicesForGroups([group.id]);
    if (!devices.length) continue;
    const data = { groupId: group.id, version: group.version };
    for (const message of [
      { alert: { title: 'PsihORAR', body: summary }, data },
      { data },
    ]) {
      const r = await push.send(devices, message);
      total.sent += r.sent;
      total.invalidTokens.push(...r.invalidTokens);
      total.failures.push(...r.failures);
    }
  }
  total.invalidTokens = [...new Set(total.invalidTokens)];
  if (total.invalidTokens.length) await store.deleteDevicesByToken(total.invalidTokens);
  return total;
}

/**
 * Applies a parsed import. The diff is recomputed against the current
 * database, so only groups that really differ get a new version and a push.
 */
export async function publishImport(
  store: Store,
  push: PushSender,
  importId: string,
): Promise<PublishOutcome | 'not_found' | 'already_published'> {
  const job = await store.getImport(importId);
  if (!job) return 'not_found';
  if (job.status === 'published') return 'already_published';

  const snapshot = await store.snapshot();
  const diff = computeDiff(snapshot, job.payload);
  const changed = diff.filter((d) => d.added.length || d.changed.length || d.removed.length);
  const touched = await store.applyImport(
    job.payload,
    changed.map((d) => ({ year: d.year, group: d.group })),
  );
  await store.markImportPublished(importId);

  const years = await store.listYears();
  const yearName = (id: string) => years.find((y) => y.id === id)?.name ?? '';
  const pushResult = await notifyGroups(
    store,
    push,
    touched.map((group) => ({
      group,
      summary: changeSummary(
        changed.find((d) => d.group === group.name && d.year === yearName(group.yearId)) ?? {
          year: '',
          group: group.name,
          isNewGroup: false,
          added: [],
          changed: [],
          removed: [],
        },
      ),
    })),
  );

  return {
    groups: touched.map((g) => ({
      id: g.id,
      year: yearName(g.yearId),
      name: g.name,
      version: g.version,
    })),
    push: pushResult,
  };
}
