import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { SheetSync, toExportUrl } from '../src/sheet-sync.js';
import { MemoryPersistence, Store } from '../src/store.js';

const FIXTURE = fileURLToPath(new URL('../data/PSIH.xlsx', import.meta.url));
const URL_ = 'https://docs.google.com/spreadsheets/d/abc/export?format=xlsx';

type Reply = Response | Error | 'hang';

/** A fetch that answers from a queue, recording calls. */
function fakeFetch(replies: Reply[]) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    const next = replies.shift() ?? new Error('no more replies');
    if (next === 'hang') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
      });
    }
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

const xlsxResponse = (body: Buffer) => new Response(new Uint8Array(body), { status: 200 });

async function tinyWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('PSIH 1');
  ws.getCell('A2').value = 'PSIHOLOGIE ZI, an I';
  ws.getCell('D4').value = 'Grupa I';
  ws.getCell('A5').value = 'LUNI';
  ws.getCell('B5').value = '08:00 - 10:00';
  ws.getCell('C5').value = 's.i.';
  ws.getCell('D5').value = 'Test, C, Prof. Test, D1';
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('Google Sheet sync', () => {
  let dir: string;
  let store: Store;
  let workbook: Buffer;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'psihorar-sync-'));
    store = await Store.open(new MemoryPersistence());
    workbook = await readFile(FIXTURE);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const make = (replies: Reply[], extra: { timeoutMs?: number } = {}) => {
    const f = fakeFetch(replies);
    return { sync: new SheetSync(store, { url: URL_, dataDir: dir, fetchImpl: f.impl, ...extra }), calls: f.calls };
  };
  const total = () => store.listYears().flatMap((y) => y.groups).reduce((n, g) => n + store.listSessions(g.id).length, 0);

  it('applies a valid sheet and keeps it as the last good version', async () => {
    const { sync, calls } = make([xlsxResponse(workbook)]);
    const result = await sync.run();
    expect(result).toEqual({ ok: true, changedGroups: 28 });
    expect(calls).toEqual([URL_]);
    expect(total()).toBe(589);
    expect((await readFile(join(dir, 'last-good.xlsx'))).equals(workbook)).toBe(true);
    expect(sync.status()).toMatchObject({ enabled: true, lastError: null, lastGood: { years: 3, sessions: 589 } });
  });

  it('a second identical sync changes nothing', async () => {
    const { sync } = make([xlsxResponse(workbook), xlsxResponse(workbook)]);
    await sync.run();
    expect(await sync.run()).toEqual({ ok: true, changedGroups: 0 });
  });

  const failures: [string, () => Promise<Reply>, RegExp][] = [
    ['HTTP error', async () => new Response('denied', { status: 403 }), /HTTP 403/],
    ['sign-in page instead of a file', async () => new Response('<html>Sign in</html>', { status: 200 }), /nu este un fișier \.xlsx/],
    ['network failure', async () => new Error('getaddrinfo ENOTFOUND'), /nu este accesibilă/],
    ['corrupt zip', async () => xlsxResponse(Buffer.from('PK\u0003\u0004 not really a workbook')), /nu a putut fi citit/],
    ['suspicious drop in classes', async () => xlsxResponse(await tinyWorkbook()), /pare incomplet/],
  ];

  for (const [name, reply, message] of failures) {
    it(`keeps the last good version on ${name}`, async () => {
      const { sync } = make([xlsxResponse(workbook), await reply()]);
      await sync.run();
      const before = sync.status();
      const result = await sync.run();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(message);
      expect(total()).toBe(589);
      expect((await readFile(join(dir, 'last-good.xlsx'))).equals(workbook)).toBe(true);
      const after = sync.status();
      expect(after.lastError).toMatch(message);
      expect(after.lastSuccessAt).toBe(before.lastSuccessAt);
      expect(after.lastGood).toEqual(before.lastGood);
    });
  }

  it('gives up on a source that does not answer in time', async () => {
    const { sync } = make(['hang'], { timeoutMs: 50 });
    const result = await sync.run();
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/nu a răspuns la timp/);
  });

  it('remembers the last good version across a restart', async () => {
    await make([xlsxResponse(workbook)]).sync.run();
    const restarted = new SheetSync(store, { url: URL_, dataDir: dir, fetchImpl: fakeFetch([]).impl });
    await restarted.init();
    expect(restarted.status().lastGood).toMatchObject({ sessions: 589 });
    expect((await restarted.readLastGood())?.equals(workbook)).toBe(true);
  });

  it('runs once when asked twice at the same time', async () => {
    const { sync, calls } = make([xlsxResponse(workbook), xlsxResponse(workbook)]);
    const [a, b] = await Promise.all([sync.run(), sync.run()]);
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
  });

  it('can be switched off', async () => {
    const sync = new SheetSync(store, { url: null, dataDir: dir });
    expect(sync.status().enabled).toBe(false);
    expect((await sync.run()).ok).toBe(false);
  });

  it('turns share links into download links', () => {
    expect(toExportUrl('https://docs.google.com/spreadsheets/d/1DhsGCD6yn0oOfCIEt6cmKKc6juxu11J4/edit?gid=2085020967#gid=2085020967'))
      .toBe('https://docs.google.com/spreadsheets/d/1DhsGCD6yn0oOfCIEt6cmKKc6juxu11J4/export?format=xlsx');
    expect(toExportUrl('https://drive.google.com/file/d/XYZ_123/view?usp=sharing'))
      .toBe('https://drive.google.com/uc?export=download&id=XYZ_123');
    expect(toExportUrl('https://example.org/orar.xlsx')).toBe('https://example.org/orar.xlsx');
  });

  it('admin endpoints report and trigger the sync', async () => {
    const { sync } = make([new Response('denied', { status: 403 })]);
    const app = await buildApp({
      store,
      sync,
      admin: { email: 'a@b.ro', passwordHash: await hashPassword('parola-test-1') },
      tokenSecret: 'test-secret-test-secret-test-secret-0123',
      rateLimitPerMinute: 0,
    });
    expect((await app.inject({ url: '/api/admin/sync' })).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { email: 'a@b.ro', password: 'parola-test-1' } });
    const auth = { authorization: `Bearer ${login.json().token}` };
    const run = await app.inject({ method: 'POST', url: '/api/admin/sync', headers: auth });
    expect(run.json()).toMatchObject({ ok: false, status: { enabled: true, lastError: expect.stringMatching(/HTTP 403/) } });
    expect((await app.inject({ url: '/api/admin/sync', headers: auth })).json()).toMatchObject({ enabled: true });
  });
});
