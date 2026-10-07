import { PrismaClient, type Prisma } from '@prisma/client';
import type { GroupDiff } from '../import/diff.js';
import type { ImportError, ParsedSession, ParsedYear } from '../import/parser.js';
import type { Config, Device, Group, GroupSnapshot, ImportJob, Session, Store } from './types.js';

type SessionRow = {
  id: string;
  groupId: string;
  weekday: number;
  startTime: string;
  endTime: string;
  name: string;
  type: ParsedSession['type'];
  professor: string;
  room: string;
  weekParity: ParsedSession['weekParity'];
  isOptional: boolean;
  updatedAt: Date;
};

function toSession(r: SessionRow): Session {
  return { ...r, updatedAt: r.updatedAt.toISOString() };
}

function toParsed(r: SessionRow): ParsedSession {
  const { id: _id, groupId: _groupId, updatedAt: _updatedAt, ...rest } = r;
  return rest;
}

function json<T>(value: T): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** PostgreSQL-backed Store. */
export class PrismaStore implements Store {
  constructor(private readonly db: PrismaClient = new PrismaClient()) {}

  async close() {
    await this.db.$disconnect();
  }

  async getConfig(): Promise<Config> {
    const row = await this.db.appConfig.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    return { semesterStart: row.semesterStart, semesterEnd: row.semesterEnd, timezone: row.timezone };
  }
  async setConfig(patch: Partial<Config>): Promise<Config> {
    await this.db.appConfig.upsert({ where: { id: 1 }, create: { id: 1, ...patch }, update: patch });
    return this.getConfig();
  }

  async listYears() {
    return this.db.studyYear.findMany({ orderBy: { sourceSheet: 'asc' } });
  }
  async listGroups(yearId: string) {
    const year = await this.db.studyYear.findUnique({ where: { id: yearId } });
    if (!year) return null;
    return this.db.studyGroup.findMany({ where: { yearId } });
  }
  async getGroup(groupId: string): Promise<Group | null> {
    return this.db.studyGroup.findUnique({ where: { id: groupId } });
  }
  async listSessions(groupId: string) {
    const rows = await this.db.classSession.findMany({
      where: { groupId },
      orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
    });
    return rows.map(toSession);
  }
  async snapshot(): Promise<GroupSnapshot[]> {
    const groups = await this.db.studyGroup.findMany({ include: { year: true, sessions: true } });
    return groups.map((g) => ({
      groupId: g.id,
      year: g.year.name,
      group: g.name,
      sessions: g.sessions.map(toParsed),
    }));
  }

  async applyImport(years: ParsedYear[], changed: { year: string; group: string }[]) {
    const wanted = new Set(changed.map((c) => `${c.year}|${c.group}`));
    return this.db.$transaction(async (tx) => {
      const touched: Group[] = [];
      for (const y of years) {
        const year = await tx.studyYear.upsert({
          where: { name: y.name },
          create: { name: y.name, sourceSheet: y.sourceSheet },
          update: { sourceSheet: y.sourceSheet },
        });
        for (const g of y.groups) {
          const group = await tx.studyGroup.upsert({
            where: { yearId_name: { yearId: year.id, name: g.name } },
            create: { yearId: year.id, name: g.name },
            update: {},
          });
          if (!wanted.has(`${y.name}|${g.name}`)) continue;
          await tx.classSession.deleteMany({ where: { groupId: group.id } });
          if (g.sessions.length) {
            await tx.classSession.createMany({
              data: g.sessions.map((s) => ({ ...s, groupId: group.id })),
            });
          }
          touched.push(
            await tx.studyGroup.update({
              where: { id: group.id },
              data: { version: { increment: 1 } },
            }),
          );
        }
      }
      // Groups removed from the file: listed in `changed` but absent from `years`.
      for (const key of wanted) {
        const [yearName, groupName] = key.split('|');
        const group = await tx.studyGroup.findFirst({
          where: { name: groupName, year: { name: yearName } },
        });
        if (!group || touched.some((t) => t.id === group.id)) continue;
        await tx.classSession.deleteMany({ where: { groupId: group.id } });
        touched.push(
          await tx.studyGroup.update({
            where: { id: group.id },
            data: { version: { increment: 1 } },
          }),
        );
      }
      return touched;
    });
  }

  async getSession(id: string) {
    const row = await this.db.classSession.findUnique({ where: { id } });
    return row ? toSession(row) : null;
  }
  async createSession(groupId: string, data: ParsedSession) {
    const [row] = await this.db.$transaction([
      this.db.classSession.create({ data: { ...data, groupId } }),
      this.db.studyGroup.update({ where: { id: groupId }, data: { version: { increment: 1 } } }),
    ]);
    return toSession(row);
  }
  async updateSession(id: string, patch: Partial<ParsedSession>) {
    const existing = await this.db.classSession.findUnique({ where: { id } });
    if (!existing) return null;
    const [row] = await this.db.$transaction([
      this.db.classSession.update({ where: { id }, data: patch }),
      this.db.studyGroup.update({
        where: { id: existing.groupId },
        data: { version: { increment: 1 } },
      }),
    ]);
    return toSession(row);
  }
  async deleteSession(id: string) {
    const existing = await this.db.classSession.findUnique({ where: { id } });
    if (!existing) return null;
    await this.db.$transaction([
      this.db.classSession.delete({ where: { id } }),
      this.db.studyGroup.update({
        where: { id: existing.groupId },
        data: { version: { increment: 1 } },
      }),
    ]);
    return toSession(existing);
  }

  async upsertDevice(device: Device) {
    const data = { ...device, lastSeenAt: new Date() };
    await this.db.device.upsert({ where: { id: device.id }, create: data, update: data });
  }
  async deleteDevice(id: string) {
    await this.db.device.deleteMany({ where: { id } });
  }
  async devicesForGroups(groupIds: string[]): Promise<Device[]> {
    return this.db.device.findMany({ where: { groupId: { in: groupIds } } });
  }
  async deleteDevicesByToken(tokens: string[]) {
    if (tokens.length) await this.db.device.deleteMany({ where: { apnsToken: { in: tokens } } });
  }

  private toJob(row: {
    id: string;
    fileName: string;
    status: ImportJob['status'];
    payload: unknown;
    diff: unknown;
    errors: unknown;
    createdAt: Date;
    publishedAt: Date | null;
  }): ImportJob {
    return {
      id: row.id,
      fileName: row.fileName,
      status: row.status,
      payload: row.payload as ParsedYear[],
      diff: row.diff as GroupDiff[],
      errors: row.errors as ImportError[],
      createdAt: row.createdAt.toISOString(),
      publishedAt: row.publishedAt?.toISOString() ?? null,
    };
  }
  async createImport(job: Omit<ImportJob, 'id' | 'createdAt' | 'publishedAt'>) {
    const row = await this.db.importJob.create({
      data: {
        fileName: job.fileName,
        status: job.status,
        payload: json(job.payload),
        diff: json(job.diff),
        errors: json(job.errors),
      },
    });
    return this.toJob(row);
  }
  async getImport(id: string) {
    const row = await this.db.importJob.findUnique({ where: { id } });
    return row ? this.toJob(row) : null;
  }
  async markImportPublished(id: string) {
    await this.db.importJob.update({
      where: { id },
      data: { status: 'published', publishedAt: new Date() },
    });
  }

  async findAdminByEmail(email: string) {
    return this.db.adminUser.findUnique({ where: { email: email.toLowerCase() } });
  }
  async upsertAdmin(email: string, passwordHash: string) {
    const key = email.toLowerCase();
    await this.db.adminUser.upsert({
      where: { email: key },
      create: { email: key, passwordHash },
      update: { passwordHash },
    });
  }
}
