import { fileURLToPath } from 'node:url';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { issueToken, TOKEN_TTL_SECONDS, verifyPassword, verifyToken } from './auth.js';
import { computeDiff } from './diff.js';
import { buildCalendar, calendarFileName, slugify } from './ics.js';
import { parseWorkbook, type ParsedSession } from './parser.js';
import type { Session, Store } from './store.js';

export interface AppOptions {
  store: Store;
  /** null disables admin login (credentials not configured). */
  admin: { email: string; passwordHash: string } | null;
  tokenSecret: string;
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
  const { groupId: _groupId, ...rest } = s;
  return rest;
}

function isRealDate(dateISO: string): boolean {
  const d = new Date(`${dateISO}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === dateISO;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { store } = opts;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024, trustProxy: true });

  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
  const limit = opts.rateLimitPerMinute ?? 300;
  if (limit > 0) await app.register(rateLimit, { max: limit, timeWindow: '1 minute' });
  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../public', import.meta.url)),
    cacheControl: false,
  });

  // ---------- Public ----------

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/config', async () => ({ ...store.getConfig(), adminEnabled: opts.admin !== null }));

  app.get('/api/years', async () =>
    store.listYears().map((y) => ({
      id: y.id,
      name: y.name,
      groups: y.groups.map((g) => ({ id: g.id, name: g.name, version: g.version })),
    })),
  );

  app.get<{ Params: { id: string } }>(
    '/api/groups/:id/timetable',
    { schema: { params: idParams } },
    async (req, reply) => {
      const group = store.getGroup(req.params.id);
      if (!group) return reply.code(404).send({ error: 'group_not_found' });
      const etag = `"${group.id}-v${group.version}"`;
      reply.header('ETag', etag).header('Cache-Control', 'no-cache');
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      return {
        groupId: group.id,
        groupName: group.name,
        yearName: group.yearName,
        version: group.version,
        sessions: store.listSessions(group.id).map(publicSession),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/groups/:id/calendar.ics',
    { schema: { params: idParams } },
    async (req, reply) => {
      const group = store.getGroup(req.params.id);
      if (!group) return reply.code(404).send({ error: 'group_not_found' });
      return reply
        .header('Content-Type', 'text/calendar; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${calendarFileName(group.yearName, group.name)}"`)
        .send(buildCalendar(store.getConfig(), group, store.listSessions(group.id)));
    },
  );

  // Subscription feed. Addressed by year and group name, not by id, so the
  // link keeps working when the timetable is re-imported or the database rebuilt.
  app.get<{ Params: { year: string; file: string } }>(
    '/api/calendar/:year/:file',
    {
      schema: {
        params: {
          type: 'object',
          required: ['year', 'file'],
          properties: {
            year: { type: 'string', pattern: '^[a-z0-9-]{1,40}$' },
            file: { type: 'string', pattern: '^[a-z0-9-]{1,40}\\.ics$' },
          },
        },
      },
    },
    async (req, reply) => {
      const groupSlug = req.params.file.slice(0, -4);
      for (const year of store.listYears()) {
        if (slugify(year.name) !== req.params.year) continue;
        const match = year.groups.find((g) => slugify(g.name) === groupSlug);
        const group = match && store.getGroup(match.id);
        if (!group) break;
        return reply
          .header('Content-Type', 'text/calendar; charset=utf-8')
          .header('Cache-Control', 'public, max-age=900')
          .send(buildCalendar(store.getConfig(), group, store.listSessions(group.id)));
      }
      return reply.code(404).send({ error: 'group_not_found' });
    },
  );

  // ---------- Admin ----------

  app.post<{ Body: { email: string; password: string } }>(
    '/api/admin/login',
    {
      // Stricter limit against password guessing.
      config: limit > 0 ? { rateLimit: { max: 8, timeWindow: '1 minute' } } : {},
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
      if (!opts.admin) return reply.code(503).send({ error: 'admin_not_configured' });
      const emailOk = req.body.email.trim().toLowerCase() === opts.admin.email.toLowerCase();
      // Always run the hash check so timing does not reveal whether the email matched.
      const passwordOk = await verifyPassword(req.body.password, opts.admin.passwordHash);
      if (!emailOk || !passwordOk) return reply.code(401).send({ error: 'invalid_credentials' });
      return { token: issueToken('admin', opts.tokenSecret), expiresInSeconds: TOKEN_TTL_SECONDS };
    },
  );

  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !verifyToken(token, opts.tokenSecret)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };

  await app.register(async (admin) => {
    admin.addHook('onRequest', requireAdmin);

    admin.get('/api/admin/me', async () => ({ ok: true }));

    admin.put<{ Body: { semesterStart?: string; semesterWeeks?: number } }>(
      '/api/admin/config',
      {
        schema: {
          body: {
            type: 'object',
            minProperties: 1,
            additionalProperties: false,
            properties: {
              semesterStart: { type: 'string', pattern: ISO_DATE },
              semesterWeeks: { type: 'integer', minimum: 1, maximum: 60 },
            },
          },
        },
      },
      async (req, reply) => {
        if (req.body.semesterStart && !isRealDate(req.body.semesterStart)) {
          return reply.code(400).send({ error: 'invalid_date' });
        }
        return store.setConfig(req.body);
      },
    );

    admin.post<{ Body: ParsedSession & { groupId: string } }>(
      '/api/admin/sessions',
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
        if (!store.getGroup(groupId)) return reply.code(404).send({ error: 'group_not_found' });
        if (data.endTime <= data.startTime) return reply.code(400).send({ error: 'end_before_start' });
        return reply.code(201).send(publicSession(await store.createSession(groupId, data)));
      },
    );

    admin.patch<{ Params: { id: string }; Body: Partial<ParsedSession> }>(
      '/api/admin/sessions/:id',
      {
        schema: {
          params: idParams,
          body: { type: 'object', minProperties: 1, additionalProperties: false, properties: sessionProps },
        },
      },
      async (req, reply) => {
        const current = store.getSession(req.params.id);
        if (!current) return reply.code(404).send({ error: 'session_not_found' });
        const merged = { ...current, ...req.body };
        if (merged.endTime <= merged.startTime) return reply.code(400).send({ error: 'end_before_start' });
        const updated = await store.updateSession(req.params.id, req.body);
        if (!updated) return reply.code(404).send({ error: 'session_not_found' });
        return publicSession(updated);
      },
    );

    admin.delete<{ Params: { id: string } }>(
      '/api/admin/sessions/:id',
      { schema: { params: idParams } },
      async (req, reply) => {
        if (!(await store.deleteSession(req.params.id))) {
          return reply.code(404).send({ error: 'session_not_found' });
        }
        return reply.code(204).send();
      },
    );

    admin.post('/api/admin/imports', async (req, reply) => {
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
      const diff = computeDiff(store.snapshot(), parsed.years);
      const job = store.createImport({
        fileName: file.filename,
        payload: parsed.years,
        diff,
        errors: parsed.errors,
      });
      return reply.code(201).send({
        importId: job.id,
        fileName: job.fileName,
        years: parsed.years.map((y) => ({
          name: y.name,
          groups: y.groups.map((g) => ({ name: g.name, sessions: g.sessions.length })),
        })),
        diff,
        errors: parsed.errors,
      });
    });

    admin.post<{ Params: { id: string } }>(
      '/api/admin/imports/:id/publish',
      { schema: { params: idParams } },
      async (req, reply) => {
        const job = store.getImport(req.params.id);
        if (!job) return reply.code(404).send({ error: 'import_not_found' });
        if (job.published) return reply.code(409).send({ error: 'already_published' });
        // Recomputed now, so only groups that really differ get a new version.
        const changed = computeDiff(store.snapshot(), job.payload).filter(
          (d) => d.added.length || d.changed.length || d.removed.length,
        );
        const touched = await store.applyImport(
          job,
          changed.map((d) => ({ year: d.year, group: d.group })),
        );
        return { changedGroups: touched.length };
      },
    );
  });

  return app;
}
