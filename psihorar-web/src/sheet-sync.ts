import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { computeDiff } from './diff.js';
import { isExcluded } from './exclusions.js';
import { parseWorkbook, type ParsedYear } from './parser.js';
import type { Store } from './store.js';

/**
 * Keeps the timetable in step with the faculty's Google Sheet, the source of
 * truth. Fail-safe: whenever the sheet cannot be fetched or does not look like
 * a valid timetable, nothing changes and the last good import stays in use.
 * The last good workbook is kept on disk (data/last-good.xlsx) so it also
 * survives a restart and seeds an empty store.
 */

/** The faculty timetable (Google Sheets), exported as .xlsx. */
export const DEFAULT_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1DhsGCD6yn0oOfCIEt6cmKKc6juxu11J4/export?format=xlsx';

const MAX_BYTES = 15 * 1024 * 1024;

/** Accepts a normal Google Sheets / Drive share link and returns its .xlsx download link. */
export function toExportUrl(url: string): string {
  const sheet = /docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(url);
  if (sheet) return `https://docs.google.com/spreadsheets/d/${sheet[1]}/export?format=xlsx`;
  const file = /drive\.google\.com\/(?:file\/d\/|open\?id=)([A-Za-z0-9_-]+)/.exec(url);
  if (file) return `https://drive.google.com/uc?export=download&id=${file[1]}`;
  return url;
}

export interface LastGood {
  fetchedAt: string;
  sha256: string;
  years: number;
  sessions: number;
  unreadableCells: number;
}

export interface SyncStatus {
  enabled: boolean;
  source: string | null;
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  /** Groups whose timetable changed at the last successful sync. */
  lastChangedGroups: number;
  lastGood: LastGood | null;
}

export interface SyncResult {
  ok: boolean;
  changedGroups: number;
  error?: string;
}

export interface SheetSyncOptions {
  url: string | null;
  dataDir: string;
  timeoutMs?: number;
  /** Reject a sheet whose session count falls below this share of the last good one. */
  minSessionRatio?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const countSessions = (years: ParsedYear[]) =>
  years.reduce((n, y) => n + y.groups.reduce((m, g) => m + g.sessions.length, 0), 0);

export class SheetSync {
  private readonly url: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private running: Promise<SyncResult> | null = null;
  private state: Omit<SyncStatus, 'enabled' | 'source' | 'running'> = {
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastChangedGroups: 0,
    lastGood: null,
  };

  constructor(private readonly store: Store, private readonly opts: SheetSyncOptions) {
    this.url = opts.url ? toExportUrl(opts.url) : null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  get lastGoodPath(): string {
    return join(this.opts.dataDir, 'last-good.xlsx');
  }
  private get metaPath(): string {
    return join(this.opts.dataDir, 'last-good.json');
  }

  status(): SyncStatus {
    return { enabled: this.url !== null, source: this.url, running: this.running !== null, ...this.state };
  }

  /** Reads what is known about the last good workbook (after a restart). */
  async init(): Promise<void> {
    try {
      this.state.lastGood = JSON.parse(await readFile(this.metaPath, 'utf8')) as LastGood;
      this.state.lastSuccessAt = this.state.lastGood.fetchedAt;
    } catch {
      this.state.lastGood = null;
    }
  }

  /** The last good workbook, or null when none was ever synced. */
  async readLastGood(): Promise<Buffer | null> {
    try {
      return await readFile(this.lastGoodPath);
    } catch {
      return null;
    }
  }

  /** One sync. Concurrent calls share the run in progress. */
  run(): Promise<SyncResult> {
    this.running ??= this.runOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private fail(message: string): SyncResult {
    this.state.lastError = message;
    return { ok: false, changedGroups: 0, error: message };
  }

  private async runOnce(): Promise<SyncResult> {
    if (!this.url) return { ok: false, changedGroups: 0, error: 'Sincronizarea este oprită.' };
    this.state.lastAttemptAt = this.now().toISOString();

    // 1. Download, with a timeout and a size cap.
    let body: Buffer;
    try {
      const res = await this.fetchImpl(this.url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
      if (!res.ok) {
        return this.fail(`Fișierul nu a putut fi descărcat (HTTP ${res.status}). Verifică partajarea „oricine are linkul poate vedea”.`);
      }
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > MAX_BYTES) return this.fail('Fișierul este prea mare.');
      body = Buffer.from(await res.arrayBuffer());
      if (body.length > MAX_BYTES) return this.fail('Fișierul este prea mare.');
    } catch (err) {
      const name = (err as Error).name;
      return this.fail(
        name === 'TimeoutError' || name === 'AbortError'
          ? 'Sursa nu a răspuns la timp.'
          : `Sursa nu este accesibilă (${(err as Error).message}).`,
      );
    }

    // 2. Must be an .xlsx (a zip). A sign-in page means the sheet is not shared publicly.
    if (body.length < 4 || body[0] !== 0x50 || body[1] !== 0x4b) {
      return this.fail('Răspunsul nu este un fișier .xlsx (probabil fișierul nu este partajat public).');
    }

    // 3. Must parse into a plausible timetable.
    let years: ParsedYear[];
    let unreadable = 0;
    try {
      const parsed = await parseWorkbook(body);
      years = parsed.years;
      unreadable = parsed.errors.length;
    } catch {
      return this.fail('Fișierul nu a putut fi citit ca orar.');
    }
    const sessions = countSessions(years);
    if (!years.length || sessions === 0) return this.fail('Fișierul nu conține niciun an sau nicio oră.');
    const previous = this.state.lastGood?.sessions ?? 0;
    const ratio = this.opts.minSessionRatio ?? 0.5;
    if (previous > 0 && sessions < previous * ratio) {
      return this.fail(
        `Fișierul are doar ${sessions} ore față de ${previous} la ultima versiune bună; pare incomplet, așa că nu a fost aplicat.`,
      );
    }

    // 4. Keep it as the new last good version (atomic writes), then apply what changed.
    const meta: LastGood = {
      fetchedAt: this.now().toISOString(),
      sha256: createHash('sha256').update(body).digest('hex'),
      years: years.length,
      sessions,
      unreadableCells: unreadable,
    };
    await mkdir(this.opts.dataDir, { recursive: true });
    await writeFile(`${this.lastGoodPath}.tmp`, body);
    await rename(`${this.lastGoodPath}.tmp`, this.lastGoodPath);
    await writeFile(`${this.metaPath}.tmp`, JSON.stringify(meta, null, 2));
    await rename(`${this.metaPath}.tmp`, this.metaPath);

    const changed = computeDiff(this.store.snapshot(), years).filter(
      (d) => d.added.length || d.changed.length || d.removed.length,
    );
    let changedGroups = 0;
    if (changed.length) {
      const job = this.store.createImport({ fileName: 'Google Sheets', payload: years, diff: changed, errors: [] });
      changedGroups = (await this.store.applyImport(job, changed.map((d) => ({ year: d.year, group: d.group })))).length;
      await this.store.purge(isExcluded);
    }

    this.state = {
      ...this.state,
      lastSuccessAt: meta.fetchedAt,
      lastError: null,
      lastChangedGroups: changedGroups,
      lastGood: meta,
    };
    return { ok: true, changedGroups };
  }
}
