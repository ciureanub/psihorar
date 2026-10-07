import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword, issueToken, verifyToken } from '../src/auth.js';
import { apnsProviderToken, buildApnsPayload, type PushMessage, type PushResult, type PushSender } from '../src/push/apns.js';
import { MemoryStore } from '../src/store/memory.js';
import type { Device } from '../src/store/types.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/PSIH.xlsx', import.meta.url));
const SECRET = 'test-secret-test-secret-test-secret-0123';
const EMAIL = 'admin@example.test';
const PASSWORD = 'correct horse battery staple';

class FakePush implements PushSender {
  calls: { tokens: string[]; message: PushMessage }[] = [];
  invalid: string[] = [];
  async send(devices: Device[], message: PushMessage): Promise<PushResult> {
    this.calls.push({ tokens: devices.map((d) => d.apnsToken), message });
    const invalidTokens = devices.map((d) => d.apnsToken).filter((t) => this.invalid.includes(t));
    return { sent: devices.length - invalidTokens.length, invalidTokens, failures: [] };
  }
}

function multipart(fileName: string, content: Buffer) {
  const boundary = '----psihorartest';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, content, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const DEVICE_A = '11111111-1111-4111-8111-111111111111';
const DEVICE_B = '22222222-2222-4222-8222-222222222222';

describe('API', () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let push: FakePush;
  let auth: { authorization: string };

  beforeEach(async () => {
    store = new MemoryStore();
    push = new FakePush();
    await store.upsertAdmin(EMAIL, await hashPassword(PASSWORD));
    app = await buildApp({ store, push, adminTokenSecret: SECRET, rateLimitPerMinute: 0 });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/login',
      payload: { email: EMAIL, password: PASSWORD },
    });
    auth = { authorization: `Bearer ${res.json().token}` };
  });

  const upload = async () => {
    const form = multipart('PSIH.xlsx', await readFile(FIXTURE));
    return app.inject({
      method: 'POST',
      url: '/v1/admin/imports',
      payload: form.payload,
      headers: { ...form.headers, ...auth },
    });
  };
  const publish = (id: string) =>
    app.inject({ method: 'POST', url: `/v1/admin/imports/${id}/publish`, headers: auth });
  const importAll = async () => {
    const res = await upload();
    await publish(res.json().importId);
  };
  const groupId = async (yearName: string, groupName: string): Promise<string> => {
    const years = (await app.inject({ url: '/v1/years' })).json() as { id: string; name: string }[];
    const year = years.find((y) => y.name === yearName)!;
    const groups = (await app.inject({ url: `/v1/years/${year.id}/groups` })).json() as {
      id: string;
      name: string;
    }[];
    return groups.find((g) => g.name === groupName)!.id;
  };

  it('public endpoints need no credentials', async () => {
    const config = await app.inject({ url: '/v1/config' });
    expect(config.statusCode).toBe(200);
    expect(config.json()).toEqual({
      semesterStart: '2026-09-28',
      semesterEnd: '2027-02-14',
      timezone: 'Europe/Bucharest',
    });
    expect((await app.inject({ url: '/v1/years' })).statusCode).toBe(200);
  });

  it('admin endpoints return 401 without a valid token', async () => {
    const form = multipart('PSIH.xlsx', Buffer.from('x'));
    const attempts = [
      { method: 'POST', url: '/v1/admin/imports', payload: form.payload, headers: form.headers },
      { method: 'POST', url: `/v1/admin/imports/${DEVICE_A}/publish` },
      { method: 'POST', url: '/v1/admin/sessions', payload: {} },
      { method: 'DELETE', url: `/v1/admin/sessions/${DEVICE_A}` },
      { method: 'PUT', url: '/v1/admin/config', payload: { semesterStart: '2026-01-01' } },
    ] as const;
    for (const a of attempts) {
      expect((await app.inject(a)).statusCode, a.url).toBe(401);
      const forged = await app.inject({ ...a, headers: { ...('headers' in a ? a.headers : {}), authorization: 'Bearer abc.def' } });
      expect(forged.statusCode, a.url).toBe(401);
    }
  });

  it('login rejects wrong credentials and tokens expire', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/admin/login',
      payload: { email: EMAIL, password: 'nope' },
    });
    expect(bad.statusCode).toBe(401);
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/admin/login',
      payload: { email: 'x@example.test', password: PASSWORD },
    });
    expect(unknown.statusCode).toBe(401);

    const now = Date.now();
    const token = issueToken('admin-1', SECRET, now);
    expect(verifyToken(token, SECRET, now + 60_000)).toBe('admin-1');
    expect(verifyToken(token, SECRET, now + 13 * 3600_000)).toBeNull();
    expect(verifyToken(token, 'another-secret', now)).toBeNull();
  });

  it('import writes nothing until publish', async () => {
    const res = await upload();
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.errors).toEqual([]);
    expect(body.years.map((y: { name: string }) => y.name)).toEqual(['An I', 'An II', 'An III']);
    expect((await app.inject({ url: '/v1/years' })).json()).toEqual([]);

    const published = await publish(body.importId);
    expect(published.statusCode).toBe(200);
    expect((await app.inject({ url: '/v1/years' })).json()).toHaveLength(3);
    expect((await publish(body.importId)).statusCode).toBe(409);
  });

  it('timetable returns sessions with an ETag and 304 when unchanged', async () => {
    await importAll();
    const id = await groupId('An I', 'Grupa I');
    const first = await app.inject({ url: `/v1/groups/${id}/timetable` });
    expect(first.statusCode).toBe(200);
    expect(first.json().version).toBe(1);
    expect(first.json().sessions).toHaveLength(20);
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();

    const cached = await app.inject({
      url: `/v1/groups/${id}/timetable`,
      headers: { 'if-none-match': etag },
    });
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe('');
  });

  it('re-publishing the same file changes no version and sends no push', async () => {
    await importAll();
    const id = await groupId('An I', 'Grupa I');
    await app.inject({
      method: 'PUT',
      url: `/v1/devices/${DEVICE_A}`,
      payload: { apnsToken: TOKEN_A, groupId: id, environment: 'sandbox' },
    });
    const again = await upload();
    expect(again.json().diff).toEqual([]);
    const res = await publish(again.json().importId);
    expect(res.json().groups).toEqual([]);
    expect(push.calls).toEqual([]);
    expect((await app.inject({ url: `/v1/groups/${id}/timetable` })).json().version).toBe(1);
  });

  it('a session edit bumps only that group and pushes only to its devices', async () => {
    await importAll();
    const g1 = await groupId('An I', 'Grupa I');
    const g2 = await groupId('An I', 'Grupa II');
    for (const [device, token, group] of [
      [DEVICE_A, TOKEN_A, g1],
      [DEVICE_B, TOKEN_B, g2],
    ] as const) {
      const reg = await app.inject({
        method: 'PUT',
        url: `/v1/devices/${device}`,
        payload: { apnsToken: token, groupId: group, environment: 'sandbox' },
      });
      expect(reg.statusCode).toBe(204);
    }
    const sessions = (
      await app.inject({ url: `/v1/admin/groups/${g1}/sessions`, headers: auth })
    ).json() as { id: string; weekday: number; startTime: string; name: string }[];
    const target = sessions.find((s) => s.weekday === 3 && s.startTime === '16:00')!;

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/sessions/${target.id}`,
      headers: auth,
      payload: { room: 'D1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().room).toBe('D1');

    expect((await app.inject({ url: `/v1/groups/${g1}/timetable` })).json().version).toBe(2);
    expect((await app.inject({ url: `/v1/groups/${g2}/timetable` })).json().version).toBe(1);

    // One visible alert and one silent push, both only to group I's device.
    expect(push.calls).toHaveLength(2);
    expect(push.calls.every((c) => c.tokens.length === 1 && c.tokens[0] === TOKEN_A)).toBe(true);
    expect(push.calls[0]?.message.alert?.body).toBe('Orar modificat: Statistică, miercuri, sala D1');
    expect(push.calls[1]?.message.alert).toBeUndefined();
  });

  it('tokens rejected by APNs are removed', async () => {
    await importAll();
    const g1 = await groupId('An I', 'Grupa I');
    await app.inject({
      method: 'PUT',
      url: `/v1/devices/${DEVICE_A}`,
      payload: { apnsToken: TOKEN_A, groupId: g1, environment: 'production' },
    });
    push.invalid = [TOKEN_A];
    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/sessions',
      headers: auth,
      payload: {
        groupId: g1, weekday: 5, startTime: '16:00', endTime: '18:00', name: 'Consultații',
        type: 'seminar', professor: 'Prof. Test', room: 'D2', weekParity: 'all', isOptional: false,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(await store.devicesForGroups([g1])).toEqual([]);
  });

  it('validates payloads', async () => {
    await importAll();
    const g1 = await groupId('An I', 'Grupa I');
    const badDevice = await app.inject({
      method: 'PUT',
      url: `/v1/devices/${DEVICE_A}`,
      payload: { apnsToken: 'not-hex', groupId: g1, environment: 'sandbox' },
    });
    expect(badDevice.statusCode).toBe(400);
    const badSession = await app.inject({
      method: 'POST',
      url: '/v1/admin/sessions',
      headers: auth,
      payload: {
        groupId: g1, weekday: 9, startTime: '16:00', endTime: '18:00', name: 'X',
        type: 'curs', professor: 'P', room: 'R', weekParity: 'all', isOptional: false,
      },
    });
    expect(badSession.statusCode).toBe(400);
    const badConfig = await app.inject({
      method: 'PUT',
      url: '/v1/admin/config',
      headers: auth,
      payload: { semesterEnd: '2026-01-01' },
    });
    expect(badConfig.statusCode).toBe(400);
    expect((await app.inject({ url: '/v1/groups/not-a-uuid/timetable' })).statusCode).toBe(400);
  });
});

describe('APNs helpers', () => {
  it('builds alert and silent payloads', () => {
    expect(buildApnsPayload({ alert: { title: 'PsihORAR', body: 'x' }, data: { groupId: 'g' } })).toEqual({
      aps: { alert: { title: 'PsihORAR', body: 'x' }, sound: 'default' },
      groupId: 'g',
    });
    expect(buildApnsPayload({ data: { version: 2 } })).toEqual({
      aps: { 'content-available': 1 },
      version: 2,
    });
  });

  it('signs an ES256 provider token', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const p8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const token = apnsProviderToken({ keyId: 'KEY123', teamId: 'TEAM123', p8, bundleId: 'x.y' }, 1_700_000_000_000);
    const [header, payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY123' });
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({ iss: 'TEAM123', iat: 1_700_000_000 });
    expect(Buffer.from(signature!, 'base64url')).toHaveLength(64);
  });
});
