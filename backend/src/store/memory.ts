import { randomUUID } from 'node:crypto';
import type { ParsedSession, ParsedYear } from '../import/parser.js';
import type {
  Admin,
  Config,
  Device,
  Group,
  GroupSnapshot,
  ImportJob,
  Session,
  Store,
  Year,
} from './types.js';

function strip(s: Session): ParsedSession {
  const { id: _id, groupId: _groupId, updatedAt: _updatedAt, ...rest } = s;
  return rest;
}

/** In-memory Store used by the test suite. Not for production. */
export class MemoryStore implements Store {
  private config: Config = {
    semesterStart: '2026-09-28',
    semesterEnd: '2027-02-14',
    timezone: 'Europe/Bucharest',
  };
  private years: Year[] = [];
  private groups: Group[] = [];
  private sessions: Session[] = [];
  private devices = new Map<string, Device>();
  private imports = new Map<string, ImportJob>();
  private admins = new Map<string, Admin>();

  async getConfig() {
    return { ...this.config };
  }
  async setConfig(patch: Partial<Config>) {
    this.config = { ...this.config, ...patch };
    return { ...this.config };
  }

  async listYears() {
    return [...this.years].sort((a, b) => a.sourceSheet.localeCompare(b.sourceSheet));
  }
  async listGroups(yearId: string) {
    if (!this.years.some((y) => y.id === yearId)) return null;
    return this.groups.filter((g) => g.yearId === yearId).map((g) => ({ ...g }));
  }
  async getGroup(groupId: string) {
    const g = this.groups.find((x) => x.id === groupId);
    return g ? { ...g } : null;
  }
  async listSessions(groupId: string) {
    return this.sessions
      .filter((s) => s.groupId === groupId)
      .sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime))
      .map((s) => ({ ...s }));
  }
  async snapshot(): Promise<GroupSnapshot[]> {
    return this.groups.map((g) => ({
      groupId: g.id,
      year: this.years.find((y) => y.id === g.yearId)?.name ?? '',
      group: g.name,
      sessions: this.sessions.filter((s) => s.groupId === g.id).map(strip),
    }));
  }

  async applyImport(years: ParsedYear[], changed: { year: string; group: string }[]) {
    const wanted = new Set(changed.map((c) => `${c.year}|${c.group}`));
    const touched: Group[] = [];
    const now = new Date().toISOString();
    for (const y of years) {
      let year = this.years.find((x) => x.name === y.name);
      if (!year) {
        year = { id: randomUUID(), name: y.name, sourceSheet: y.sourceSheet };
        this.years.push(year);
      }
      for (const g of y.groups) {
        let group = this.groups.find((x) => x.yearId === year.id && x.name === g.name);
        if (!group) {
          group = { id: randomUUID(), yearId: year.id, name: g.name, version: 0 };
          this.groups.push(group);
        }
        if (!wanted.has(`${y.name}|${g.name}`)) continue;
        const groupId = group.id;
        this.sessions = this.sessions.filter((s) => s.groupId !== groupId);
        for (const s of g.sessions) {
          this.sessions.push({ ...s, id: randomUUID(), groupId, updatedAt: now });
        }
        group.version += 1;
        touched.push({ ...group });
      }
    }
    // Groups removed from the file: listed in `changed` but absent from `years`.
    for (const key of wanted) {
      const [yearName, groupName] = key.split('|');
      const year = this.years.find((x) => x.name === yearName);
      const group = this.groups.find((x) => x.yearId === year?.id && x.name === groupName);
      if (!group || touched.some((t) => t.id === group.id)) continue;
      this.sessions = this.sessions.filter((s) => s.groupId !== group.id);
      group.version += 1;
      touched.push({ ...group });
    }
    return touched;
  }

  private bump(groupId: string) {
    const g = this.groups.find((x) => x.id === groupId);
    if (g) g.version += 1;
  }
  async getSession(id: string) {
    const s = this.sessions.find((x) => x.id === id);
    return s ? { ...s } : null;
  }
  async createSession(groupId: string, data: ParsedSession) {
    const s: Session = { ...data, id: randomUUID(), groupId, updatedAt: new Date().toISOString() };
    this.sessions.push(s);
    this.bump(groupId);
    return { ...s };
  }
  async updateSession(id: string, patch: Partial<ParsedSession>) {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return null;
    Object.assign(s, patch, { updatedAt: new Date().toISOString() });
    this.bump(s.groupId);
    return { ...s };
  }
  async deleteSession(id: string) {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return null;
    this.sessions = this.sessions.filter((x) => x.id !== id);
    this.bump(s.groupId);
    return { ...s };
  }

  async upsertDevice(device: Device) {
    this.devices.set(device.id, { ...device });
  }
  async deleteDevice(id: string) {
    this.devices.delete(id);
  }
  async devicesForGroups(groupIds: string[]) {
    return [...this.devices.values()].filter((d) => groupIds.includes(d.groupId));
  }
  async deleteDevicesByToken(tokens: string[]) {
    for (const [id, d] of this.devices) if (tokens.includes(d.apnsToken)) this.devices.delete(id);
  }

  async createImport(job: Omit<ImportJob, 'id' | 'createdAt' | 'publishedAt'>) {
    const full: ImportJob = {
      ...job,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      publishedAt: null,
    };
    this.imports.set(full.id, full);
    return full;
  }
  async getImport(id: string) {
    return this.imports.get(id) ?? null;
  }
  async markImportPublished(id: string) {
    const job = this.imports.get(id);
    if (job) {
      job.status = 'published';
      job.publishedAt = new Date().toISOString();
    }
  }

  async findAdminByEmail(email: string) {
    return this.admins.get(email.toLowerCase()) ?? null;
  }
  async upsertAdmin(email: string, passwordHash: string) {
    const key = email.toLowerCase();
    const existing = this.admins.get(key);
    this.admins.set(key, { id: existing?.id ?? randomUUID(), email: key, passwordHash });
  }
}
