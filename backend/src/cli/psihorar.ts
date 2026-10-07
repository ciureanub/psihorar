#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';

const API = (process.env.PSIHORAR_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');

const USAGE = `PsihORAR admin CLI

  psihorar import <file.xlsx>          upload a workbook, print diff and errors
  psihorar publish <importId>          apply an import and notify devices
  psihorar groups                      list years and groups with their ids
  psihorar sessions <groupId>          list a group's sessions with their ids
  psihorar session add --group <id> --weekday <1-5> --start HH:mm --end HH:mm
                       --name <text> --type curs|seminar|practica
                       --professor <text> --room <text>
                       [--parity all|odd|even] [--optional]
  psihorar session edit <sessionId> [any of the flags above except --group]
  psihorar session remove <sessionId>

Environment: PSIHORAR_API_URL (default http://localhost:3000), ADMIN_EMAIL, ADMIN_PASSWORD`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function call(method: string, path: string, init: RequestInit = {}, token?: string) {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(`${API}${path}`, { ...init, method, headers });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) fail(`${method} ${path} failed: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function login(): Promise<string> {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) fail('Set ADMIN_EMAIL and ADMIN_PASSWORD in the environment.');
  const body = (await call('POST', '/v1/admin/login', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })) as { token: string };
  return body.token;
}

const json = (value: unknown): RequestInit => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});

interface SessionOut {
  weekday: number;
  startTime: string;
  endTime: string;
  name: string;
  type: string;
  professor: string;
  room: string;
  weekParity: string;
  isOptional: boolean;
  id?: string;
}

const DAYS = ['', 'Lu', 'Ma', 'Mi', 'Jo', 'Vi'];
const line = (s: SessionOut) =>
  `${DAYS[s.weekday]} ${s.startTime}-${s.endTime} [${s.weekParity}] ${s.name}${
    s.isOptional ? ' (Opt.)' : ''
  }, ${s.type}, ${s.professor}, ${s.room}`;

async function cmdImport(file: string | undefined) {
  if (!file) fail(USAGE);
  const token = await login();
  const form = new FormData();
  form.set('file', new Blob([await readFile(file)]), basename(file));
  const res = (await call('POST', '/v1/admin/imports', { body: form }, token)) as {
    importId: string;
    years: { name: string; sourceSheet: string; groups: { name: string; sessions: number }[] }[];
    diff: {
      year: string;
      group: string;
      added: SessionOut[];
      changed: { before: SessionOut; after: SessionOut }[];
      removed: SessionOut[];
    }[];
    errors: { sheet: string; cell: string; text: string; reason: string }[];
  };

  console.log(`Import ${res.importId}`);
  for (const y of res.years) {
    console.log(`\n${y.name} (${y.sourceSheet})`);
    for (const g of y.groups) console.log(`  ${g.name}: ${g.sessions} sessions`);
  }
  console.log(`\nDiff: ${res.diff.length} group(s) differ from the published timetable`);
  for (const d of res.diff) {
    console.log(`\n  ${d.year} / ${d.group}: +${d.added.length} ~${d.changed.length} -${d.removed.length}`);
    for (const s of d.added) console.log(`    + ${line(s)}`);
    for (const c of d.changed) console.log(`    ~ ${line(c.before)}\n      -> ${line(c.after)}`);
    for (const s of d.removed) console.log(`    - ${line(s)}`);
  }
  console.log(`\nErrors: ${res.errors.length}`);
  for (const e of res.errors) console.log(`  ${e.sheet}!${e.cell}: ${e.reason}\n    "${e.text}"`);
  console.log(`\nNothing is written yet. To apply: psihorar publish ${res.importId}`);
}

async function cmdPublish(id: string | undefined) {
  if (!id) fail(USAGE);
  const token = await login();
  const res = (await call('POST', `/v1/admin/imports/${id}/publish`, {}, token)) as {
    groups: { year: string; name: string; version: number }[];
    push: { sent: number; removedTokens: number; failures: number };
  };
  console.log(`Published. ${res.groups.length} group(s) changed:`);
  for (const g of res.groups) console.log(`  ${g.year} / ${g.name} -> version ${g.version}`);
  console.log(
    `Push: ${res.push.sent} sent, ${res.push.removedTokens} stale token(s) removed, ${res.push.failures} failure(s)`,
  );
}

async function cmdGroups() {
  const years = (await call('GET', '/v1/years')) as { id: string; name: string }[];
  for (const y of years) {
    console.log(`${y.name}  ${y.id}`);
    const groups = (await call('GET', `/v1/years/${y.id}/groups`)) as {
      id: string;
      name: string;
      version: number;
    }[];
    for (const g of groups) console.log(`  ${g.name.padEnd(12)} ${g.id}  v${g.version}`);
  }
}

async function cmdSessions(groupId: string | undefined) {
  if (!groupId) fail(USAGE);
  const token = await login();
  const sessions = (await call('GET', `/v1/admin/groups/${groupId}/sessions`, {}, token)) as SessionOut[];
  for (const s of sessions) console.log(`${s.id}  ${line(s)}`);
}

async function cmdSession(action: string | undefined, args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      group: { type: 'string' },
      weekday: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      name: { type: 'string' },
      type: { type: 'string' },
      professor: { type: 'string' },
      room: { type: 'string' },
      parity: { type: 'string' },
      optional: { type: 'boolean' },
      'not-optional': { type: 'boolean' },
    },
  });
  const fields: Record<string, unknown> = {};
  if (values.weekday !== undefined) fields.weekday = Number(values.weekday);
  if (values.start !== undefined) fields.startTime = values.start;
  if (values.end !== undefined) fields.endTime = values.end;
  if (values.name !== undefined) fields.name = values.name;
  if (values.type !== undefined) fields.type = values.type;
  if (values.professor !== undefined) fields.professor = values.professor;
  if (values.room !== undefined) fields.room = values.room;
  if (values.parity !== undefined) fields.weekParity = values.parity;
  if (values.optional) fields.isOptional = true;
  if (values['not-optional']) fields.isOptional = false;

  const token = await login();
  if (action === 'add') {
    if (!values.group) fail('session add needs --group <groupId>');
    const body = { weekParity: 'all', isOptional: false, ...fields, groupId: values.group };
    const created = (await call('POST', '/v1/admin/sessions', json(body), token)) as SessionOut;
    console.log(`Added ${created.id}\n  ${line(created)}`);
  } else if (action === 'edit') {
    const id = positionals[0];
    if (!id) fail('session edit needs <sessionId>');
    const updated = (await call('PATCH', `/v1/admin/sessions/${id}`, json(fields), token)) as SessionOut;
    console.log(`Updated ${updated.id}\n  ${line(updated)}`);
  } else if (action === 'remove') {
    const id = positionals[0];
    if (!id) fail('session remove needs <sessionId>');
    await call('DELETE', `/v1/admin/sessions/${id}`, {}, token);
    console.log(`Removed ${id}`);
  } else fail(USAGE);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'import':
    await cmdImport(rest[0]);
    break;
  case 'publish':
    await cmdPublish(rest[0]);
    break;
  case 'groups':
    await cmdGroups();
    break;
  case 'sessions':
    await cmdSessions(rest[0]);
    break;
  case 'session':
    await cmdSession(rest[0], rest.slice(1));
    break;
  default:
    console.log(USAGE);
}
