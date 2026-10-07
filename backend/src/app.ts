import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { issueToken, TOKEN_TTL_SECONDS, verifyPassword, verifyToken } from './auth.js';
import { computeDiff } from './import/diff.js';
import { parseWorkbook, type ParsedSession } from './import/parser.js';
import type { PushSender } from './push/apns.js';
import { notifyGroups, publishImport } from './services/publish.js';
import type { Session, Store } from './store/types.js';

export interface AppOptions {
  store: Store;
  push: PushSender;
  adminTokenSecret: string;
  /** 0 disables rate limiting (tests). */
  rateLimitPerMinute?: number;
  logger?: boolean;
}

const ISO_DATE = '^\\d{4}-\\d{2}-\\d{2}$';
const HHMM = '^([01]\\d|2[0-3]):[0-5]\\d$';
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: UUID } },
} as const;

const sessionProps = {
  weekday: { type: 'integer', minimum: 1, maximum: 5 },
  startTime: { type: 'string', pattern: HHMM },
  endTime: { type: 'string', pattern: HHMM },
  name: { type: 'string', minLength: 1, maxLength: 200 },
  type: { type: 'string', enum: ['curs', 'seminar', 'practica'] },
  professor: { type: 'string', minLength: 1, maxLength: 200 },
  room: { type: 'string', minLength: 1, maxLength: 200 },
  weekParity: { type: 'string', enum: ['all', 'odd', 'even'] },
  isOptional: { type: 'boolean' },
} as const;

const SESSION_FIELDS = Object.keys(sessionProps) as (keyof ParsedSession)[];

function publicSession(s: Session) {
  return {
    id: s.id,
    weekday: s.weekday,
    startTime: s.startTime,
    endTime: s.endTime,
    name: s.name,
    type: s.type,
    professor: s.professor,
    room: s.room,
    weekParity: s.weekParity,
    isOptional: s.isOptional,
  };
}

function etagFor(groupId: string, version: number): string {
  return `"${groupId}-v${version}"`;
}

const WEEKDAY_NAMES = ['', 'luni', 'marți', 'miercuri', 'joi', 'vineri'];

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { store, push } = opts;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 });

  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
  const limit = opts.rateLimitPerMinute ?? 120;
  if (limit > 0) await app.register(rateLimit, { max: limit, timeWindow: '1 minute' });

  // ---------- Public, no authentication ----------

  app.get('/health', async () => ({ ok: true }));

  app.get('/v1/config', async () => store.getConfig());

  app.get('/v1/years', async () => {
    const years = await store.listYears();
    return years.map((y) => ({ id: y.id, name: y.name }));
  });

  app.get<{ Params: { id: string } }>(
    '/v1/years/:id/groups',
    { schema: { params: idParams } },
    async (req, reply) => {
      const groups = await store.listGroups(req.params.id);
      if (!groups) return reply.code(404).send({ error: 'year_not_found' });
      return groups.map((g) => ({ id: g.id, name: g.name, version: g.version }));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/groups/:id/timetable',
    { schema: { params: idParams } },
    async (req, reply) => {
      const group = await store.getGroup(req.params.id);
      if (!group) return reply.code(404).send({ error: 'group_not_found' });
      const etag = etagFor(group.id, group.version);
      reply.header('ETag', etag).header('Cache-Control', 'no-cache');
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      const sessions = await store.listSessions(group.id);
      return {
        groupId: group.id,
        groupName: group.name,
        version: group.version,
        sessions: sessions.map(publicSession),
      };
    },
  );

  app.put<{
    Params: { id: string };
    Body: { apnsToken: string; groupId: string; environment: 'sandbox' | 'production' };
  }>(
    '/v1/devices/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['apnsToken', 'groupId', 'environment'],
          additionalProperties: false,
          properties: {
            apnsToken: { type: 'string', pattern: '^[0-9a-fA-F]{32,200}$' },
            groupId: { type: 'string', pattern: UUID },
            environment: { type: 'string', enum: ['sandbox', 'production'] },
          },
        },
      },
    },
    async (req, reply) => {
      if (!(await store.getGroup(req.body.groupId))) {
        return reply.code(404).send({ error: 'group_not_found' });
      }
      await store.upsertDevice({ id: req.params.id.toLowerCase(), ...req.body });
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/devices/:id',
    { schema: { params: idParams } },
    async (req, reply) => {
      await store.deleteDevice(req.params.id.toLowerCase());
      return reply.code(204).send();
    },
  );

  // ---------- Admin ----------

  app.post<{ Body: { email: string; password: string } }>(
    '/v1/admin/login',
    {
      // Stricter limit against password guessing.
      config: limit > 0 ? { rateLimit: { max: 10, timeWindow: '1 minute' } } : {},
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 200 },
            password: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      const admin = await store.findAdminByEmail(req.body.email);
      const ok = admin ? await verifyPassword(req.body.password, admin.passwordHash) : false;
      if (!admin || !ok) return reply.code(401).send({ error: 'invalid_credentials' });
      return {
        token: issueToken(admin.id, opts.adminTokenSecret),
        expiresInSeconds: TOKEN_TTL_SECONDS,
      };
    },
  );

  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !verifyToken(token, opts.adminTokenSecret)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };

  await app.register(async (admin) => {
    admin.addHook('onRequest', requireAdmin);

    admin.post('/v1/admin/imports', async (req, reply) => {
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'file_required' });
      if (!file.filename.toLowerCase().endsWith('.xlsx')) {
        return reply.code(400).send({ error: 'xlsx_required' });
      }
      const buffer = await file.toBuffer();
      let parsed;
      try {
        parsed = await parseWorkbook(buffer);
      } catch {
        return reply.code(400).send({ error: 'unreadable_workbook' });
      }
      const diff = computeDiff(await store.snapshot(), parsed.years);
      const job = await store.createImport({
        fileName: file.filename,
        status: 'parsed',
        payload: parsed.years,
        diff,
        errors: parsed.errors,
      });
      return reply.code(201).send({
        importId: job.id,
        fileName: job.fileName,
        years: parsed.years.map((y) => ({
          name: y.name,
          sourceSheet: y.sourceSheet,
          groups: y.groups.map((g) => ({ name: g.name, sessions: g.sessions.length })),
        })),
        diff,
        errors: parsed.errors,
      });
    });

    admin.post<{ Params: { id: string } }>(
      '/v1/admin/imports/:id/publish',
      { schema: { params: idParams } },
      async (req, reply) => {
        const outcome = await publishImport(store, push, req.params.id);
        if (outcome === 'not_found') return reply.code(404).send({ error: 'import_not_found' });
        if (outcome === 'already_published') {
          return reply.code(409).send({ error: 'already_published' });
        }
        return {
          groups: outcome.groups,
          push: {
            sent: outcome.push.sent,
            removedTokens: outcome.push.invalidTokens.length,
            failures: outcome.push.failures.length,
          },
        };
      },
    );

    const notifySessionChange = async (groupId: string, verb: string, s: ParsedSession) => {
      const group = await store.getGroup(groupId);
      if (!group) return;
      const summary = `${verb}: ${s.name}, ${WEEKDAY_NAMES[s.weekday] ?? ''}, sala ${s.room}`;
      await notifyGroups(store, push, [{ group, summary }]);
    };

    admin.get<{ Params: { id: string } }>(
      '/v1/admin/groups/:id/sessions',
      { schema: { params: idParams } },
      async (req, reply) => {
        if (!(await store.getGroup(req.params.id))) {
          return reply.code(404).send({ error: 'group_not_found' });
        }
        return (await store.listSessions(req.params.id)).map(publicSession);
      },
    );

    admin.post<{ Body: ParsedSession & { groupId: string } }>(
      '/v1/admin/sessions',
      {
        schema: {
          body: {
            type: 'object',
            required: ['groupId', ...SESSION_FIELDS],
            additionalProperties: false,
            properties: { groupId: { type: 'string', pattern: UUID }, ...sessionProps },
          },
        },
      },
      async (req, reply) => {
        const { groupId, ...data } = req.body;
        if (!(await store.getGroup(groupId))) {
          return reply.code(404).send({ error: 'group_not_found' });
        }
        if (data.endTime <= data.startTime) {
          return reply.code(400).send({ error: 'end_before_start' });
        }
        const created = await store.createSession(groupId, data);
        await notifySessionChange(groupId, 'Oră nouă', created);
        return reply.code(201).send(publicSession(created));
      },
    );

    admin.patch<{ Params: { id: string }; Body: Partial<ParsedSession> }>(
      '/v1/admin/sessions/:id',
      {
        schema: {
          params: idParams,
          body: {
            type: 'object',
            minProperties: 1,
            additionalProperties: false,
            properties: sessionProps,
          },
        },
      },
      async (req, reply) => {
        const current = await store.getSession(req.params.id);
        if (!current) return reply.code(404).send({ error: 'session_not_found' });
        const merged = { ...current, ...req.body };
        if (merged.endTime <= merged.startTime) {
          return reply.code(400).send({ error: 'end_before_start' });
        }
        const updated = await store.updateSession(req.params.id, req.body);
        if (!updated) return reply.code(404).send({ error: 'session_not_found' });
        await notifySessionChange(updated.groupId, 'Orar modificat', updated);
        return publicSession(updated);
      },
    );

    admin.delete<{ Params: { id: string } }>(
      '/v1/admin/sessions/:id',
      { schema: { params: idParams } },
      async (req, reply) => {
        const removed = await store.deleteSession(req.params.id);
        if (!removed) return reply.code(404).send({ error: 'session_not_found' });
        await notifySessionChange(removed.groupId, 'Oră anulată', removed);
        return reply.code(204).send();
      },
    );

    admin.put<{ Body: { semesterStart?: string; semesterEnd?: string } }>(
      '/v1/admin/config',
      {
        schema: {
          body: {
            type: 'object',
            minProperties: 1,
            additionalProperties: false,
            properties: {
              semesterStart: { type: 'string', pattern: ISO_DATE },
              semesterEnd: { type: 'string', pattern: ISO_DATE },
            },
          },
        },
      },
      async (req, reply) => {
        const next = { ...(await store.getConfig()), ...req.body };
        if (next.semesterEnd <= next.semesterStart) {
          return reply.code(400).send({ error: 'end_before_start' });
        }
        return store.setConfig(req.body);
      },
    );
  });

  return app;
}
