import type { GroupDiff } from '../import/diff.js';
import type { ImportError, ParsedSession, ParsedYear } from '../import/parser.js';

export interface Config {
  semesterStart: string;
  semesterEnd: string;
  timezone: string;
}

export interface Year {
  id: string;
  name: string;
  sourceSheet: string;
}

export interface Group {
  id: string;
  yearId: string;
  name: string;
  version: number;
}

export interface Session extends ParsedSession {
  id: string;
  groupId: string;
  updatedAt: string;
}

export interface Device {
  id: string;
  apnsToken: string;
  groupId: string;
  environment: 'sandbox' | 'production';
}

export interface ImportJob {
  id: string;
  fileName: string;
  status: 'parsed' | 'published' | 'failed';
  payload: ParsedYear[];
  diff: GroupDiff[];
  errors: ImportError[];
  createdAt: string;
  publishedAt: string | null;
}

export interface Admin {
  id: string;
  email: string;
  passwordHash: string;
}

export interface GroupSnapshot {
  groupId: string;
  year: string;
  group: string;
  sessions: ParsedSession[];
}

/** Persistence boundary. Implemented by PrismaStore (PostgreSQL) and MemoryStore (tests). */
export interface Store {
  getConfig(): Promise<Config>;
  setConfig(patch: Partial<Config>): Promise<Config>;

  listYears(): Promise<Year[]>;
  listGroups(yearId: string): Promise<Group[] | null>;
  getGroup(groupId: string): Promise<Group | null>;
  listSessions(groupId: string): Promise<Session[]>;
  snapshot(): Promise<GroupSnapshot[]>;

  /**
   * Replaces the sessions of the listed groups with the parsed data, creating
   * missing years and groups, and bumps each changed group's version once.
   * Must be atomic. Returns the ids of the groups it touched.
   */
  applyImport(years: ParsedYear[], changed: { year: string; group: string }[]): Promise<Group[]>;

  getSession(id: string): Promise<Session | null>;
  /** Each session write bumps the owning group's version. */
  createSession(groupId: string, data: ParsedSession): Promise<Session>;
  updateSession(id: string, patch: Partial<ParsedSession>): Promise<Session | null>;
  deleteSession(id: string): Promise<Session | null>;

  upsertDevice(device: Device): Promise<void>;
  deleteDevice(id: string): Promise<void>;
  devicesForGroups(groupIds: string[]): Promise<Device[]>;
  deleteDevicesByToken(tokens: string[]): Promise<void>;

  createImport(job: Omit<ImportJob, 'id' | 'createdAt' | 'publishedAt'>): Promise<ImportJob>;
  getImport(id: string): Promise<ImportJob | null>;
  markImportPublished(id: string): Promise<void>;

  findAdminByEmail(email: string): Promise<Admin | null>;
  upsertAdmin(email: string, passwordHash: string): Promise<void>;
}
