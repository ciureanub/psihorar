// ---------- Local data layer (this file has no server) ----------

const SEED = /*SEED*/;
const OPTIONALS = /*OPTIONALS*/;
const DB_KEY = 'psihorar.data.v5';
const ADMIN_KEY = 'psihorar.admin.v1';

Object.assign(ERRORS, {
  weak_password: 'Alege o parolă de minimum 8 caractere.',
  missing_fields: 'Completează toate câmpurile.',
  not_found: 'Elementul nu mai există.',
  bad_file: 'Fișierul nu este un export PsihORAR valid.',
});

function loadDb() {
  try {
    const raw = store(DB_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && isValidDb(parsed)) return parsed;
  } catch { /* fall through to the built-in timetable */ }
  return JSON.parse(JSON.stringify(SEED));
}

function isValidDb(d) {
  return Boolean(
    d && d.config && typeof d.config.semesterStart === 'string' && Number.isInteger(d.config.semesterWeeks) &&
    Array.isArray(d.years) &&
    d.years.every((y) => typeof y.id === 'string' && typeof y.name === 'string' && Array.isArray(y.groups) &&
      y.groups.every((g) => typeof g.id === 'string' && typeof g.name === 'string' && Array.isArray(g.sessions) &&
        g.sessions.every(isValidSession))),
  );
}

function isValidSession(s) {
  return Boolean(
    s && typeof s.id === 'string' && Number.isInteger(s.weekday) && s.weekday >= 1 && s.weekday <= 5 &&
    /^\d{2}:\d{2}$/.test(s.startTime) && /^\d{2}:\d{2}$/.test(s.endTime) &&
    typeof s.name === 'string' && typeof s.professor === 'string' && typeof s.room === 'string' &&
    ['curs', 'seminar', 'practica'].includes(s.type) && ['all', 'odd', 'even'].includes(s.weekParity) &&
    typeof s.isOptional === 'boolean',
  );
}

let db = loadDb();
const saveDb = () => store(DB_KEY, JSON.stringify(db));
const findGroup = (id) => db.years.flatMap((y) => y.groups.map((g) => ({ year: y, group: g }))).find((x) => x.group.id === id);
const sortSessions = (list) =>
  [...list].sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime) || a.name.localeCompare(b.name));
const localConfig = () => ({
  ...db.config,
  timezone: TZ,
  semesterEnd: addDays(mondayOf(db.config.semesterStart), db.config.semesterWeeks * 7 - 1),
  adminEnabled: true,
  optionals: OPTIONALS,
});

async function digest(text) {
  if (globalThis.crypto?.subtle) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let hash = 5381; // Fallback where Web Crypto is unavailable.
  for (const ch of text) hash = ((hash * 33) ^ ch.codePointAt(0)) >>> 0;
  return `x${hash.toString(16)}`;
}

function fail(code) {
  if (code === 'unauthorized' && state.token) logout();
  throw new Error(ERRORS[code] ?? 'A apărut o eroare. Încearcă din nou.');
}

function cleanSession(input, base = {}) {
  const s = { ...base, ...input };
  for (const key of ['name', 'professor', 'room']) s[key] = String(s[key] ?? '').trim();
  if (!s.name || !s.professor || !s.room || !s.startTime || !s.endTime) fail('missing_fields');
  if (s.endTime <= s.startTime) fail('end_before_start');
  return s;
}

/** Same calls as the server version, answered from the browser's own storage. */
async function api(path, options = {}) {
  const method = options.method ?? 'GET';
  const body = options.body ?? {};
  let m;

  if (path === '/api/config') return localConfig();
  if (path === '/api/years') {
    return db.years.map((y) => ({ id: y.id, name: y.name, groups: y.groups.map((g) => ({ id: g.id, name: g.name })) }));
  }
  if ((m = /^\/api\/groups\/([^/]+)\/timetable$/.exec(path))) {
    const found = findGroup(m[1]);
    if (!found) fail('not_found');
    return { groupId: found.group.id, groupName: found.group.name, yearName: found.year.name, sessions: sortSessions(found.group.sessions) };
  }

  if (path === '/api/admin/login') {
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    let saved = null;
    try { saved = JSON.parse(store(ADMIN_KEY) ?? 'null'); } catch { saved = null; }
    if (!saved) {
      if (password.length < 8) fail('weak_password');
      store(ADMIN_KEY, JSON.stringify({ email, hash: await digest(`${email}\n${password}`) }));
    } else if (saved.email !== email || saved.hash !== (await digest(`${email}\n${password}`))) {
      fail('invalid_credentials');
    }
    return { token: 'local' };
  }

  if (!state.token) fail('unauthorized');
  if (path === '/api/admin/me') return { ok: true };

  if (path === '/api/admin/config') {
    const weeks = Number(body.semesterWeeks);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.semesterStart ?? '') || Number.isNaN(Date.parse(`${body.semesterStart}T00:00:00Z`))) fail('invalid_date');
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 60) fail('missing_fields');
    db.config = { semesterStart: body.semesterStart, semesterWeeks: weeks };
    saveDb();
    return localConfig();
  }
  if (path === '/api/admin/sessions' && method === 'POST') {
    const { groupId, ...data } = body;
    const found = findGroup(groupId);
    if (!found) fail('not_found');
    const session = cleanSession(data, { id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` });
    found.group.sessions.push(session);
    saveDb();
    return session;
  }
  if ((m = /^\/api\/admin\/sessions\/([^/]+)$/.exec(path))) {
    for (const year of db.years) {
      for (const group of year.groups) {
        const index = group.sessions.findIndex((s) => s.id === m[1]);
        if (index === -1) continue;
        if (method === 'DELETE') group.sessions.splice(index, 1);
        else group.sessions[index] = cleanSession(body, group.sessions[index]);
        saveDb();
        return method === 'DELETE' ? null : group.sessions[index];
      }
    }
    fail('not_found');
  }
  fail('not_found');
}

// ---------- Calendar export, built in the browser ----------

/** Same UID for the same class across versions, so re-importing updates instead of duplicating. */
function eventUid(found, s) {
  const key = [found.year.name, found.group.name, s.weekday, s.startTime, s.weekParity, s.type, s.name].join('|');
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (const ch of key) {
    const c = ch.codePointAt(0);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}@psihorar`;
}

function buildCalendar(found) {
  const cfg = localConfig();
  const esc = (t) => String(t).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const compact = (iso, hhmm) => `${iso.replace(/-/g, '')}T${hhmm.replace(':', '')}00`;
  const fold = (line) => {
    const bytes = new TextEncoder();
    const out = [];
    let current = '';
    let size = 0;
    for (const ch of line) {
      const n = bytes.encode(ch).length;
      if (size + n > (out.length ? 74 : 75)) { out.push(current); current = ''; size = 0; }
      current += ch;
      size += n;
    }
    out.push(current);
    return out.join('\r\n ');
  };
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const until = `${cfg.semesterEnd.replace(/-/g, '')}T215959Z`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PsihORAR//Orar//RO', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(`PsihORAR ${found.year.name} ${found.group.name}`)}`, 'X-WR-TIMEZONE:Europe/Bucharest',
    'BEGIN:VTIMEZONE', 'TZID:Europe/Bucharest',
    'BEGIN:STANDARD', 'DTSTART:19701025T040000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'TZOFFSETFROM:+0300', 'TZOFFSETTO:+0200', 'TZNAME:EET', 'END:STANDARD',
    'BEGIN:DAYLIGHT', 'DTSTART:19700329T030000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0300', 'TZNAME:EEST', 'END:DAYLIGHT',
    'END:VTIMEZONE',
  ];
  const monday = mondayOf(cfg.semesterStart);
  for (const s of found.group.sessions.filter(isVisible)) {
    const first = addDays(monday, s.weekday - 1 + (s.weekParity === 'even' ? 7 : 0));
    if (first > cfg.semesterEnd) continue;
    const parity = s.weekParity === 'all' ? 'săptămânal' : s.weekParity === 'odd' ? 'săptămâni impare' : 'săptămâni pare';
    lines.push(
      'BEGIN:VEVENT', `UID:${eventUid(found, s)}`, `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Europe/Bucharest:${compact(first, s.startTime)}`,
      `DTEND;TZID=Europe/Bucharest:${compact(first, s.endTime)}`,
      `RRULE:FREQ=WEEKLY;INTERVAL=${s.weekParity === 'all' ? 1 : 2};UNTIL=${until}`,
      `SUMMARY:${esc(`${s.name}${s.isOptional ? ' (Opt.)' : ''} · ${TYPE_LABEL[s.type] ?? s.type}`)}`,
      `LOCATION:${esc(s.room)}`,
      `DESCRIPTION:${esc(`Profesor coordonator: ${s.professor}\nSala: ${s.room}\n${parity}`)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

function download(fileName, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = h('a', { href: url, download: fileName });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
