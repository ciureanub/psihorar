import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import pg from 'pg';
import type { GroupDiff } from './diff.js';
import { semesterEnd } from './parity.js';
import type { ImportError, ParsedSession, ParsedYear } from './parser.js';

export interface Config {
  /** ISO date; week 1 (odd) is the week that contains it. */
  semesterStart: string;
  semesterWeeks: number;
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
  /** Incremented on every change to the group's timetable. */
  version: number;
}

export interface Session extends ParsedSession {
  id: string;
  groupId: string;
}

export interface State {
  config: Config;
  years: Year[];
  groups: Group[];
  sessions: Session[];
}

export interface ImportJob {
  id: string;
  fileName: string;
  payload: ParsedYear[];
  diff: GroupDiff[];
  errors: ImportError[];
  published: boolean;
}

/** Where the whole state document is kept. */
export interface Persistence {
  load(): Promise<State | null>;
  save(state: State): Promise<void>;
}

export class MemoryPersistence implements Persistence {
  private doc: string | null = null;
  async load() {
    return this.doc ? (JSON.parse(this.doc) as State) : null;
  }
  async save(state: State) {
    this.doc = JSON.stringify(state);
  }
}

/** JSON file on disk. Fine locally; on Replit deployments the disk is reset on redeploy. */
export class FilePersistence implements Persistence {
  constructor(private readonly path: string) {}
  async load() {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as State;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
  async save(state: State) {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(state));
    await rename(tmp, this.path);
  }
}

/** One JSONB row in PostgreSQL (Replit database). Survives redeploys. */
export class PgPersistence implements Persistence {
  private readonly pool: pg.Pool;
  private ready: Promise<unknown> | null = null;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 3 });
  }
  private init() {
    this.ready ??= this.pool.query(
      'CREATE TABLE IF NOT EXISTS psihorar_state (id integer PRIMARY KEY, data jsonb NOT NULL)',
    );
    return this.ready;
  }
  async load() {
    await this.init();
    const res = await this.pool.query('SELECT data FROM psihorar_state WHERE id = 1');
    return res.rows[0] ? (res.rows[0].data as State) : null;
  }
  async save(state: State) {
    await this.init();
    await this.pool.query(
      'INSERT INTO psihorar_state (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data',
      [JSON.stringify(state)],
    );
  }
}

const DEFAULT_CONFIG: Config = {
  semesterStart: '2026-09-28',
  semesterWeeks: 20,
  timezone: 'Europe/Bucharest',
};

function strip(s: Session): ParsedSession {
  const { id: _id, groupId: _groupId, ...rest } = s;
  return rest;
}

/**
 * The timetable. State lives in memory and is written through to the
 * persistence layer after every change (the data set is a few hundred rows).
 */
export class Store {
  private state: State = { config: { ...DEFAULT_CONFIG }, years: [], groups: [], sessions: [] };
  private imports = new Map<string, ImportJob>();
  private writing: Promise<void> = Promise.resolve();

  private constructor(private readonly persistence: Persistence) {}

  static async open(persistence: Persistence): Promise<Store> {
    const store = new Store(persistence);
    const loaded = await persistence.load();
    if (loaded) {
      store.state = {
        config: { ...DEFAULT_CONFIG, ...loaded.config },
        years: loaded.years ?? [],
        groups: loaded.groups ?? [],
        sessions: loaded.sessions ?? [],
      };
    }
    return store;
  }

  /** Serialized so two quick edits cannot overwrite each other out of order. */
  private persist(): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(this.state)) as State;
    this.writing = this.writing.catch(() => undefined).then(() => this.persistence.save(snapshot));
    return this.writing;
  }

  isEmpty(): boolean {
    return this.state.groups.length === 0;
  }

  getConfig(): Config & { semesterEnd: string } {
    const c = this.state.config;
    return { ...c, semesterEnd: semesterEnd(c.semesterStart, c.semesterWeeks) };
  }
  async setConfig(patch: Partial<Pick<Config, 'semesterStart' | 'semesterWeeks'>>) {
    this.state.config = { ...this.state.config, ...patch };
    await this.persist();
    return this.getConfig();
  }

  listYears(): (Year & { groups: Group[] })[] {
    return [...this.state.years]
      .sort((a, b) => a.sourceSheet.localeCompare(b.sourceSheet))
      .map((y) => ({ ...y, groups: this.state.groups.filter((g) => g.yearId === y.id).map((g) => ({ ...g })) }));
  }
  getGroup(id: string): (Group & { yearName: string }) | null {
    const g = this.state.groups.find((x) => x.id === id);
    if (!g) return null;
    return { ...g, yearName: this.state.years.find((y) => y.id === g.yearId)?.name ?? '' };
  }
  listSessions(groupId: string): Session[] {
    return this.state.sessions
      .filter((s) => s.groupId === groupId)
      .sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime) || a.name.localeCompare(b.name))
      .map((s) => ({ ...s }));
  }
  getSession(id: string): Session | null {
    const s = this.state.sessions.find((x) => x.id === id);
    return s ? { ...s } : null;
  }
  snapshot(): { year: string; group: string; sessions: ParsedSession[] }[] {
    return this.state.groups.map((g) => ({
      year: this.state.years.find((y) => y.id === g.yearId)?.name ?? '',
      group: g.name,
      sessions: this.state.sessions.filter((s) => s.groupId === g.id).map(strip),
    }));
  }

  private bump(groupId: string) {
    const g = this.state.groups.find((x) => x.id === groupId);
    if (g) g.version += 1;
  }
  async createSession(groupId: string, data: ParsedSession): Promise<Session> {
    const s: Session = { ...data, id: randomUUID(), groupId };
    this.state.sessions.push(s);
    this.bump(groupId);
    await this.persist();
    return { ...s };
  }
  async updateSession(id: string, patch: Partial<ParsedSession>): Promise<Session | null> {
    const s = this.state.sessions.find((x) => x.id === id);
    if (!s) return null;
    Object.assign(s, patch);
    this.bump(s.groupId);
    await this.persist();
    return { ...s };
  }
  async deleteSession(id: string): Promise<boolean> {
    const s = this.state.sessions.find((x) => x.id === id);
    if (!s) return false;
    this.state.sessions = this.state.sessions.filter((x) => x.id !== id);
    this.bump(s.groupId);
    await this.persist();
    return true;
  }

  /**
   * Deletes stored sessions that match `predicate` (used at start-up for the
   * exclusion list, so data saved before an exclusion was added is cleaned too).
   */
  async purge(predicate: (s: Session) => boolean): Promise<number> {
    const doomed = this.state.sessions.filter(predicate);
    if (!doomed.length) return 0;
    this.state.sessions = this.state.sessions.filter((s) => !predicate(s));
    for (const groupId of new Set(doomed.map((s) => s.groupId))) this.bump(groupId);
    await this.persist();
    return doomed.length;
  }

  createImport(job: Omit<ImportJob, 'id' | 'published'>): ImportJob {
    const full: ImportJob = { ...job, id: randomUUID(), published: false };
    this.imports.set(full.id, full);
    // Keep only the latest few uploads in memory.
    for (const key of [...this.imports.keys()].slice(0, -5)) this.imports.delete(key);
    return full;
  }
  getImport(id: string): ImportJob | null {
    return this.imports.get(id) ?? null;
  }

  /**
   * Replaces the sessions of the listed groups with the parsed data, creating
   * missing years and groups. Each changed group's version goes up by one.
   */
  async applyImport(job: ImportJob, changed: { year: string; group: string }[]): Promise<Group[]> {
    const wanted = new Set(changed.map((c) => `${c.year}|${c.group}`));
    const touched: Group[] = [];
    for (const y of job.payload) {
      let year = this.state.years.find((x) => x.name === y.name);
      if (!year) {
        year = { id: randomUUID(), name: y.name, sourceSheet: y.sourceSheet };
        this.state.years.push(year);
      } else year.sourceSheet = y.sourceSheet;
      for (const g of y.groups) {
        let group = this.state.groups.find((x) => x.yearId === year.id && x.name === g.name);
        if (!group) {
          group = { id: randomUUID(), yearId: year.id, name: g.name, version: 0 };
          this.state.groups.push(group);
        }
        if (!wanted.has(`${y.name}|${g.name}`)) continue;
        const groupId = group.id;
        this.state.sessions = this.state.sessions.filter((s) => s.groupId !== groupId);
        for (const s of g.sessions) this.state.sessions.push({ ...s, id: randomUUID(), groupId });
        group.version += 1;
        touched.push({ ...group });
      }
    }
    // Groups that are in the database but no longer in the file.
    for (const key of wanted) {
      const [yearName, groupName] = key.split('|');
      const year = this.state.years.find((x) => x.name === yearName);
      const group = this.state.groups.find((x) => x.yearId === year?.id && x.name === groupName);
      if (!group || touched.some((t) => t.id === group.id)) continue;
      this.state.sessions = this.state.sessions.filter((s) => s.groupId !== group.id);
      group.version += 1;
      touched.push({ ...group });
    }
    job.published = true;
    await this.persist();
    return touched;
  }
}
