import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { hashPassword } from './auth.js';
import { parseWorkbook } from './parser.js';
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

// First start: load the bundled timetable so the site is not empty.
if (store.isEmpty()) {
  const bundled = fileURLToPath(new URL('../data/PSIH.xlsx', import.meta.url));
  try {
    const parsed = await parseWorkbook(await readFile(bundled));
    const job = store.createImport({ fileName: 'PSIH.xlsx', payload: parsed.years, diff: [], errors: parsed.errors });
    await store.applyImport(
      job,
      parsed.years.flatMap((y) => y.groups.map((g) => ({ year: y.name, group: g.name }))),
    );
    console.log(`Seeded timetable from data/PSIH.xlsx (${parsed.errors.length} unreadable cells)`);
  } catch (err) {
    console.warn('No bundled timetable loaded:', (err as Error).message);
  }
}

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

const app = await buildApp({ store, admin, tokenSecret, logger: true });
await app.listen({ port: Number(env('PORT') ?? 3000), host: '0.0.0.0' });
