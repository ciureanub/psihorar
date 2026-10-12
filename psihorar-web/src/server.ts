import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { hashPassword } from './auth.js';
import { isExcluded } from './exclusions.js';
import { parseWorkbook } from './parser.js';
import { DEFAULT_SHEET_URL, SheetSync } from './sheet-sync.js';
import { FilePersistence, PgPersistence, Store } from './store.js';

const env = (name: string): string | null => {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
};

const databaseUrl = env('DATABASE_URL');
const persistence = databaseUrl
  ? new PgPersistence(databaseUrl)
  : new FilePersistence(fileURLToPath(new URL('../data/state.json', import.meta.url)));
const store = await Store.open(persistence);

// Sync with the faculty Google Sheet (the source of truth).
// SHEET_XLSX_URL: a share or export link; "off" disables syncing.
const sheetSetting = env('SHEET_XLSX_URL');
const sync = new SheetSync(store, {
  url: sheetSetting === 'off' ? null : sheetSetting ?? DEFAULT_SHEET_URL,
  dataDir: fileURLToPath(new URL('../data', import.meta.url)),
});
await sync.init();

// Empty store (first start, or a rebuilt deployment): seed it from the last
// good synced workbook, else from the bundled copy, so the site is never empty.
if (store.isEmpty()) {
  const lastGood = await sync.readLastGood();
  const [source, data] = lastGood
    ? ['data/last-good.xlsx', lastGood]
    : ['data/PSIH.xlsx', await readFile(fileURLToPath(new URL('../data/PSIH.xlsx', import.meta.url))).catch(() => null)];
  if (data) {
    try {
      const parsed = await parseWorkbook(data);
      const job = store.createImport({ fileName: source, payload: parsed.years, diff: [], errors: parsed.errors });
      await store.applyImport(job, parsed.years.flatMap((y) => y.groups.map((g) => ({ year: y.name, group: g.name }))));
      console.log(`Seeded timetable from ${source} (${parsed.errors.length} unreadable cells)`);
    } catch (err) {
      console.warn(`Could not load ${source}:`, (err as Error).message);
    }
  }
}

// Data saved before a session was put on the exclusion list is cleaned here.
const purged = await store.purge(isExcluded);
if (purged) console.log(`Removed ${purged} excluded sessions from stored data`);

// Admin credentials come from Secrets / environment, never from the source code.
const adminEmail = env('ADMIN_EMAIL');
const adminPassword = env('ADMIN_PASSWORD');
const admin =
  adminEmail && adminPassword
    ? { email: adminEmail, passwordHash: await hashPassword(adminPassword) }
    : null;

let tokenSecret = env('SESSION_SECRET');
if (!tokenSecret || tokenSecret.length < 32) {
  tokenSecret = randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET is not set (or shorter than 32 characters): using a random one. Admin sessions end when the server restarts.');
}
if (!admin) console.warn('ADMIN_EMAIL / ADMIN_PASSWORD are not set: admin login is disabled.');
if (!databaseUrl) console.warn('DATABASE_URL is not set: data is stored in data/state.json and is lost when a Replit deployment is rebuilt.');

const app = await buildApp({ store, admin, tokenSecret, sync, logger: true });
await app.listen({ port: Number(env('PORT') ?? 3000), host: '0.0.0.0' });

// Sync once at start-up, then on a schedule (SYNC_INTERVAL_MINUTES, default 60; 0 = only manual).
if (sync.status().enabled) {
  const logSync = async () => {
    const result = await sync.run();
    if (result.ok) app.log.info(`Sheet sync OK: ${result.changedGroups} group(s) changed`);
    else app.log.warn(`Sheet sync failed, keeping the last good version: ${result.error}`);
  };
  void logSync();
  const minutes = Number(env('SYNC_INTERVAL_MINUTES') ?? 60);
  if (minutes > 0) setInterval(() => void logSync(), minutes * 60_000).unref();
}
