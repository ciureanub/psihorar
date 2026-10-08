import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword, issueToken, verifyToken } from '../src/auth.js';
import { MemoryPersistence, Store } from '../src/store.js';

const FIXTURE = fileURLToPath(new URL('../data/PSIH.xlsx', import.meta.url));
const SECRET = 'test-secret-test-secret-test-secret-0123';
const EMAIL = 'admin@example.test';
const PASSWORD = 'correct horse battery staple';
const UNKNOWN = '11111111-1111-4111-8111-111111111111';

function multipart(fileName: string, content: Buffer) {
  const boundary = '----psihorartest';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
  );
  return {
    payload: Buffer.concat([head, content, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('API', () => {
  let app: FastifyInstance;
  let persistence: MemoryPersistence;
  let auth: { authorization: string };

  const open = async () =>
    buildApp({
      store: await Store.open(persistence),
      admin: { email: EMAIL, passwordHash: await hashPassword(PASSWORD) },
      tokenSecret: SECRET,
      rateLimitPerMinute: 0,
    });

  beforeEach(async () => {
    persistence = new MemoryPersistence();
    app = await open();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { email: EMAIL, password: PASSWORD },
    });
    auth = { authorization: `Bearer ${res.json().token}` };
  });

  const upload = async () => {
    const form = multipart('PSIH.xlsx', await readFile(FIXTURE));
    return app.inject({
      method: 'POST',
      url: '/api/admin/imports',
      payload: form.payload,
      headers: { ...form.headers, ...auth },
    });
  };
  const publish = (id: string) =>
    app.inject({ method: 'POST', url: `/api/admin/imports/${id}/publish`, headers: auth });
  const importAll = async () => publish((await upload()).json().importId);
  const groupId = async (yearName: string, groupName: string): Promise<string> => {
    const years = (await app.inject({ url: '/api/years' })).json() as {
      name: string;
      groups: { id: string; name: string }[];
    }[];
    return years.find((y) => y.name === yearName)!.groups.find((g) => g.name === groupName)!.id;
  };
  const timetable = async (id: string) => (await app.inject({ url: `/api/groups/${id}/timetable` })).json();

  it('serves the page and the public config without credentials', async () => {
    const page = await app.inject({ url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('PsihORAR');
    expect((await app.inject({ url: '/api/config' })).json()).toEqual({
      semesterStart: '2026-09-28',
      semesterWeeks: 20,
      semesterEnd: '2027-02-14',
      timezone: 'Europe/Bucharest',
      adminEnabled: true,
    });
  });

  it('admin endpoints return 401 without a valid token', async () => {
    const attempts = [
      { method: 'GET', url: '/api/admin/me' },
      { method: 'POST', url: `/api/admin/imports/${UNKNOWN}/publish` },
      { method: 'POST', url: '/api/admin/sessions', payload: {} },
      { method: 'DELETE', url: `/api/admin/sessions/${UNKNOWN}` },
      { method: 'PUT', url: '/api/admin/config', payload: { semesterWeeks: 14 } },
    ] as const;
    for (const a of attempts) {
      expect((await app.inject(a)).statusCode, a.url).toBe(401);
      const forged = await app.inject({ ...a, headers: { authorization: 'Bearer abc.def' } });
      expect(forged.statusCode, a.url).toBe(401);
    }
  });

  it('login rejects wrong credentials, and tokens expire', async () => {
    for (const payload of [
      { email: EMAIL, password: 'nope' },
      { email: 'x@example.test', password: PASSWORD },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload });
      expect(res.statusCode).toBe(401);
    }
    const now = Date.now();
    const token = issueToken('admin', SECRET, now);
    expect(verifyToken(token, SECRET, now + 60_000)).toBe('admin');
    expect(verifyToken(token, SECRET, now + 13 * 3600_000)).toBeNull();
    expect(verifyToken(token, 'another-secret', now)).toBeNull();
  });

  it('login is unavailable when no admin is configured', async () => {
    const bare = await buildApp({
      store: await Store.open(new MemoryPersistence()),
      admin: null,
      tokenSecret: SECRET,
      rateLimitPerMinute: 0,
    });
    const res = await bare.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(res.statusCode).toBe(503);
  });

  it('import writes nothing until publish', async () => {
    const res = await upload();
    expect(res.statusCode).toBe(201);
    expect(res.json().errors).toEqual([]);
    expect((await app.inject({ url: '/api/years' })).json()).toEqual([]);
    expect((await publish(res.json().importId)).json()).toEqual({ changedGroups: 28 });
    expect((await app.inject({ url: '/api/years' })).json()).toHaveLength(3);
    expect((await publish(res.json().importId)).statusCode).toBe(409);
  });

  it('timetable has 17 sessions for An I Grupa I, with ETag and 304', async () => {
    await importAll();
    const id = await groupId('An I', 'Grupa I');
    const first = await app.inject({ url: `/api/groups/${id}/timetable` });
    expect(first.json().sessions).toHaveLength(17);
    expect(first.json().version).toBe(1);
    const cached = await app.inject({
      url: `/api/groups/${id}/timetable`,
      headers: { 'if-none-match': first.headers.etag as string },
    });
    expect(cached.statusCode).toBe(304);
  });

  it('re-publishing the same file changes nothing', async () => {
    await importAll();
    const again = await upload();
    expect(again.json().diff).toEqual([]);
    expect((await publish(again.json().importId)).json()).toEqual({ changedGroups: 0 });
    expect((await timetable(await groupId('An I', 'Grupa I'))).version).toBe(1);
  });

  it('admin can add, edit and delete a session; only that group changes', async () => {
    await importAll();
    const g1 = await groupId('An I', 'Grupa I');
    const g2 = await groupId('An I', 'Grupa II');
    const body = {
      groupId: g1, weekday: 5, startTime: '16:00', endTime: '18:00', name: 'Consultații',
      type: 'seminar', professor: 'Prof. Test', room: 'D2', weekParity: 'odd', isOptional: true,
    };
    const created = await app.inject({ method: 'POST', url: '/api/admin/sessions', headers: auth, payload: body });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect((await timetable(g1)).sessions).toHaveLength(18);

    const edited = await app.inject({
      method: 'PATCH', url: `/api/admin/sessions/${id}`, headers: auth, payload: { room: 'D1' },
    });
    expect(edited.json()).toMatchObject({ room: 'D1', name: 'Consultații', isOptional: true });

    const reversed = await app.inject({
      method: 'PATCH', url: `/api/admin/sessions/${id}`, headers: auth, payload: { endTime: '15:00' },
    });
    expect(reversed.statusCode).toBe(400);

    expect((await app.inject({ method: 'DELETE', url: `/api/admin/sessions/${id}`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/sessions/${id}`, headers: auth })).statusCode).toBe(404);

    expect((await timetable(g1)).version).toBe(4);
    expect((await timetable(g1)).sessions).toHaveLength(17);
    expect((await timetable(g2)).version).toBe(1);
  });

  it('admin can change the semester start and length', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/admin/config', headers: auth,
      payload: { semesterStart: '2026-10-05', semesterWeeks: 14 },
    });
    expect(res.json()).toMatchObject({ semesterStart: '2026-10-05', semesterWeeks: 14, semesterEnd: '2027-01-10' });
    for (const payload of [{ semesterWeeks: 0 }, { semesterStart: '2026-02-31' }, { semesterStart: 'soon' }, {}]) {
      const bad = await app.inject({ method: 'PUT', url: '/api/admin/config', headers: auth, payload });
      expect(bad.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('data survives a restart', async () => {
    await importAll();
    const g1 = await groupId('An I', 'Grupa I');
    await app.inject({
      method: 'PUT', url: '/api/admin/config', headers: auth, payload: { semesterWeeks: 16 },
    });
    app = await open();
    expect((await app.inject({ url: '/api/config' })).json().semesterWeeks).toBe(16);
    expect((await timetable(g1)).sessions).toHaveLength(17);
  });

  it('exports a calendar with weekly and fortnightly recurrences', async () => {
    await importAll();
    const res = await app.inject({ url: `/api/groups/${await groupId('An I', 'Grupa I')}/calendar.ics` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/calendar');
    const ics = res.body.replace(/\r\n /g, '');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(17);
    // Weekly: Neuroștiințe, Tuesday 08:00, first occurrence in week 1.
    expect(ics).toContain('DTSTART;TZID=Europe/Bucharest:20260929T080000\r\nDTEND;TZID=Europe/Bucharest:20260929T100000\r\nRRULE:FREQ=WEEKLY;INTERVAL=1;UNTIL=20270214T215959Z');
    // Even weeks only: Monday 10:00, first occurrence in week 2.
    expect(ics).toContain('DTSTART;TZID=Europe/Bucharest:20261005T100000\r\nDTEND;TZID=Europe/Bucharest:20261005T120000\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;');
    // Odd weeks only: Tuesday 12:00, first occurrence in week 1.
    expect(ics).toContain('DTSTART;TZID=Europe/Bucharest:20260929T120000\r\nDTEND;TZID=Europe/Bucharest:20260929T140000\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;');
    expect(res.body.split('\r\n').every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
  });

  it('names the calendar file after year and group', async () => {
    await importAll();
    const res = await app.inject({ url: `/api/groups/${await groupId('An I', 'Grupa VII')}/calendar.ics` });
    expect(res.headers['content-disposition']).toBe('attachment; filename="psihorar-an-i-grupa-vii.ics"');
  });

  it('serves a subscription feed by year and group name', async () => {
    await importAll();
    const feed = await app.inject({ url: '/api/calendar/an-ii/grupa-iii.ics' });
    expect(feed.statusCode).toBe(200);
    expect(feed.headers['content-type']).toContain('text/calendar');
    expect(feed.headers['content-disposition']).toBeUndefined();
    expect(feed.body).toContain('X-WR-CALNAME:PsihORAR An II Grupa III');
    expect(feed.body).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT6H');
    expect((await app.inject({ url: '/api/calendar/an-ix/grupa-i.ics' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/calendar/an-i/grupa-xx.ics' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/calendar/an-i/grupa-i.txt' })).statusCode).toBe(400);
  });

  it('keeps event UIDs stable when the timetable is rebuilt from scratch', async () => {
    await importAll();
    const uids = (body: string) => body.match(/^UID:.*$/gm)?.sort();
    const first = uids((await app.inject({ url: '/api/calendar/an-i/grupa-i.ics' })).body);
    persistence = new MemoryPersistence();
    app = await open();
    const login = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { email: EMAIL, password: PASSWORD } });
    auth = { authorization: `Bearer ${login.json().token}` };
    await importAll();
    const second = uids((await app.inject({ url: '/api/calendar/an-i/grupa-i.ics' })).body);
    expect(first).toHaveLength(17);
    expect(second).toEqual(first);
  });

  it('rejects malformed input', async () => {
    expect((await app.inject({ url: '/api/groups/not-a-uuid/timetable' })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/groups/${UNKNOWN}/timetable` })).statusCode).toBe(404);
    const form = multipart('orar.txt', Buffer.from('x'));
    const res = await app.inject({
      method: 'POST', url: '/api/admin/imports', payload: form.payload, headers: { ...form.headers, ...auth },
    });
    expect(res.statusCode).toBe(400);
    const broken = multipart('orar.xlsx', Buffer.from('not a workbook'));
    const res2 = await app.inject({
      method: 'POST', url: '/api/admin/imports', payload: broken.payload, headers: { ...broken.headers, ...auth },
    });
    expect(res2.statusCode).toBe(400);
  });
});
