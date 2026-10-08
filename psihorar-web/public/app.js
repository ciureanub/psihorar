// PsihORAR front-end. No framework, no build step.

const TZ = 'Europe/Bucharest';
const DAY_NAMES = ['Luni', 'Marți', 'Miercuri', 'Joi', 'Vineri'];
const TYPE_LABEL = { curs: 'Curs', seminar: 'Seminar', practica: 'Practică' };
const PARITY_LABEL = { all: 'săptămânal', odd: 'săpt. impare', even: 'săpt. pare' };
const STATUS_LABEL = { past: 'Trecut', live: 'În desfășurare', future: 'Urmează' };
const ERRORS = {
  invalid_credentials: 'Email sau parolă greșită.',
  admin_not_configured: 'Contul de administrator nu este configurat pe server.',
  unauthorized: 'Sesiunea a expirat. Autentifică-te din nou.',
  end_before_start: 'Ora de sfârșit trebuie să fie după ora de început.',
  xlsx_required: 'Alege un fișier .xlsx.',
  unreadable_workbook: 'Fișierul nu a putut fi citit.',
  already_published: 'Acest import a fost deja publicat.',
  import_not_found: 'Importul nu mai există. Încarcă fișierul din nou.',
  invalid_date: 'Data nu este validă.',
};

const $ = (id) => document.getElementById(id);

/** Tiny DOM builder: h('div', {class: 'x'}, child, 'text'). Text is never parsed as HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el && key !== 'list') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the page still works, it just forgets the choice */
  }
  return null;
}

const state = {
  config: null,
  years: [],
  groupId: null,
  timetable: null,
  parity: null, // null = follow the current week
  token: null,
  scrolledToToday: false,
};

// ---------- Time, in the faculty's timezone regardless of the device ----------

function nowParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    hhmm: `${get('hour')}:${get('minute')}`,
  };
}

const dayNumber = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000);
const fromDayNumber = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const addDays = (iso, days) => fromDayNumber(dayNumber(iso) + days);
function mondayOf(iso) {
  const n = dayNumber(iso);
  return fromDayNumber(n - ((((n + 3) % 7) + 7) % 7));
}
const weekNumber = (iso, start) => Math.floor((dayNumber(mondayOf(iso)) - dayNumber(mondayOf(start))) / 7) + 1;
const parityOf = (week) => (Math.abs(week) % 2 === 1 ? 'odd' : 'even');
const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function formatDate(iso, options) {
  return new Intl.DateTimeFormat('ro-RO', { timeZone: 'UTC', ...options }).format(new Date(`${iso}T12:00:00Z`));
}

// ---------- API ----------

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  let body = options.body;
  if (body && !(body instanceof FormData)) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(path, { method: options.method ?? 'GET', headers, body });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.token) logout();
    const code = data.error ?? '';
    const message =
      ERRORS[code] ??
      (res.status === 429
        ? 'Prea multe încercări. Așteaptă un minut.'
        : res.status === 400
          ? 'Date invalide. Verifică toate câmpurile.'
          : 'A apărut o eroare. Încearcă din nou.');
    throw new Error(message);
  }
  return data;
}

// ---------- Public view ----------

function currentGroupMeta() {
  for (const year of state.years) {
    const group = year.groups.find((g) => g.id === state.groupId);
    if (group) return { year, group };
  }
  return null;
}

function fillSelectors() {
  const yearSelect = $('yearSelect');
  const groupSelect = $('groupSelect');
  const meta = currentGroupMeta();
  const year = meta?.year ?? state.years[0];
  yearSelect.replaceChildren(...state.years.map((y) => h('option', { value: y.id, selected: y.id === year?.id }, y.name)));
  groupSelect.replaceChildren(
    ...(year?.groups ?? []).map((g) => h('option', { value: g.id, selected: g.id === state.groupId }, g.name)),
  );
}

async function selectGroup(groupId) {
  state.groupId = groupId;
  state.scrolledToToday = false;
  store('psihorar.group', groupId);
  fillSelectors();
  updateCalendarLinks();
  await loadTimetable();
}

const slugify = (text) =>
  text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function calendarFileName() {
  const meta = currentGroupMeta();
  return meta ? `psihorar-${slugify(meta.year.name)}-${slugify(meta.group.name)}.ics` : 'psihorar.ics';
}

function updateCalendarLinks() {
  const meta = currentGroupMeta();
  if (!meta) return;
  $('calendarLink').href = `/api/groups/${meta.group.id}/calendar.ics`;
  $('calendarLink').download = calendarFileName();
  const path = `/api/calendar/${slugify(meta.year.name)}/${slugify(meta.group.name)}.ics`;
  const https = `${location.origin}${path}`;
  const webcal = https.replace(/^https?:/, 'webcal:');
  $('subscribeUrl').value = https;
  $('subscribeApple').href = webcal;
  $('subscribeGoogle').href = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`;
}

async function loadTimetable() {
  if (!state.groupId) return;
  try {
    state.timetable = await api(`/api/groups/${state.groupId}/timetable`);
    showNotice(null);
  } catch (err) {
    state.timetable = null;
    showNotice(err.message);
  }
  render();
  if (state.token) renderSessionEditor();
}

function showNotice(text) {
  $('notice').hidden = !text;
  $('notice').textContent = text ?? '';
}

function render() {
  if (!state.config) return;
  const now = nowParts();
  const week = weekNumber(now.date, state.config.semesterStart);
  const currentParity = parityOf(week);
  const parity = state.parity ?? currentParity;
  const inSemester = week >= 1 && week <= state.config.semesterWeeks;

  $('clockDate').textContent = formatDate(now.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('clockTime').textContent = now.hhmm;
  $('clockWeek').textContent = inSemester
    ? `Săptămâna ${week} · ${currentParity === 'odd' ? 'impară' : 'pară'}`
    : 'În afara semestrului';

  $('parityOdd').setAttribute('aria-pressed', String(parity === 'odd'));
  $('parityEven').setAttribute('aria-pressed', String(parity === 'even'));

  // The other parity means next week.
  const monday = addDays(mondayOf(now.date), parity === currentParity ? 0 : 7);
  const shownWeek = weekNumber(monday, state.config.semesterStart);
  $('rangeTitle').textContent =
    `${formatDate(monday, { day: 'numeric', month: 'long' })} – ${formatDate(addDays(monday, 4), { day: 'numeric', month: 'long' })}` +
    ` · săptămâna ${shownWeek}, ${parity === 'odd' ? 'impară' : 'pară'}`;

  const sessions = state.timetable?.sessions ?? [];
  const columns = DAY_NAMES.map((name, index) => {
    const date = addDays(monday, index);
    const isToday = date === now.date;
    const cards = sessions
      .filter((s) => s.weekday === index + 1 && (s.weekParity === 'all' || s.weekParity === parity))
      .map((s) => sessionCard(s, date, now));
    return h(
      'div',
      { class: `day${isToday ? ' today' : ''}` },
      h('div', { class: 'day-head', id: isToday ? 'today' : null },
        h('span', { class: 'num' }, formatDate(date, { day: 'numeric' })),
        h('span', { class: 'name' }, name),
      ),
      cards.length ? cards : h('div', { class: 'empty' }, 'Nicio oră.'),
    );
  });
  $('week').replaceChildren(...columns);

  // On a phone the days stack: bring today into view once.
  if (!state.scrolledToToday && state.timetable && window.matchMedia('(max-width: 640px)').matches) {
    state.scrolledToToday = true;
    document.getElementById('today')?.scrollIntoView({ block: 'start' });
  }
}

/** 63 -> "1h3m", 45 -> "45m", 120 -> "2h". */
function formatCountdown(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h${rest}m` : `${hours}h`;
}

function sessionCard(s, date, now) {
  const start = toMinutes(s.startTime);
  const end = toMinutes(s.endTime);
  let status = 'future';
  if (date < now.date || (date === now.date && now.minutes >= end)) status = 'past';
  else if (date === now.date && now.minutes >= start) status = 'live';

  return h(
    'article',
    { class: `card ${status}` },
    h('div', { class: 'time' }, `${s.startTime}–${s.endTime}`),
    h('div', { class: 'title' },
      s.name,
      h('span', { class: 'kind' }, ` · ${TYPE_LABEL[s.type] ?? s.type}`),
      s.isOptional && h('span', { class: 'opt' }, '(Opt.)')),
    h('div', { class: 'meta' }, PARITY_LABEL[s.weekParity]),
    h('div', { class: 'meta' }, 'Prof. coordonator: ', h('b', {}, s.professor)),
    h('div', { class: 'meta' }, 'Sala: ', h('b', {}, s.room)),
    h('span', { class: 'pill' },
      status === 'live'
        ? `${STATUS_LABEL.live} · încă ${end - now.minutes} min`
        : status === 'future' && date === now.date
          ? `${STATUS_LABEL.future} ${formatCountdown(start - now.minutes)}`
          : STATUS_LABEL[status]),
    status === 'live' &&
      h('div', { class: 'bar', role: 'presentation' },
        h('i', { style: `width:${Math.round(((now.minutes - start) / (end - start)) * 100)}%` })),
  );
}

// ---------- Admin ----------

function setStatus(text, bad = false) {
  const el = $('adminStatus');
  el.textContent = text ?? '';
  el.classList.toggle('bad', bad);
}

function showAdmin(visible) {
  $('adminPanel').hidden = !visible;
  $('adminButton').textContent = visible ? 'Administrare ↓' : 'Administrator';
  if (visible) {
    $('semesterStart').value = state.config.semesterStart;
    $('semesterWeeks').value = state.config.semesterWeeks;
    renderSettingsInfo();
    renderSessionEditor();
  }
}

function logout() {
  state.token = null;
  try { sessionStorage.removeItem('psihorar.token'); } catch { /* ignore */ }
  showAdmin(false);
}

function renderSettingsInfo() {
  $('settingsInfo').textContent =
    `Săptămâna 1 este impară. Semestrul se termină la ${formatDate(state.config.semesterEnd, { day: 'numeric', month: 'long', year: 'numeric' })}.`;
}

function selectTab(name) {
  for (const tab of ['Settings', 'Sessions', 'Import']) {
    $(`tab${tab}`).setAttribute('aria-selected', String(tab === name));
    $(`pane${tab}`).hidden = tab !== name;
  }
  setStatus('');
}

/** One editable row. `session` is null for the "add" form. */
function sessionForm(session) {
  const uid = session?.id ?? 'new';
  const field = (label, control, extraClass = '') =>
    h('div', { class: `field ${extraClass}`.trim() }, h('label', { for: control.id }, label), control);
  const select = (key, options, value) =>
    h('select', { id: `${key}-${uid}` }, options.map(([v, text]) => h('option', { value: v, selected: String(v) === String(value) }, text)));
  const input = (key, type, value) => h('input', { id: `${key}-${uid}`, type, value: value ?? '', required: true });

  const c = {
    weekday: select('weekday', DAY_NAMES.map((d, i) => [i + 1, d]), session?.weekday ?? 1),
    startTime: input('start', 'time', session?.startTime),
    endTime: input('end', 'time', session?.endTime),
    name: input('name', 'text', session?.name),
    type: select('type', Object.entries(TYPE_LABEL), session?.type ?? 'curs'),
    professor: input('prof', 'text', session?.professor),
    room: input('room', 'text', session?.room),
    weekParity: select('parity', [['all', 'Toate'], ['odd', 'Impare'], ['even', 'Pare']], session?.weekParity ?? 'all'),
    isOptional: h('input', { id: `opt-${uid}`, type: 'checkbox', checked: session?.isOptional ?? false }),
  };
  const values = () => ({
    weekday: Number(c.weekday.value),
    startTime: c.startTime.value,
    endTime: c.endTime.value,
    name: c.name.value.trim(),
    type: c.type.value,
    professor: c.professor.value.trim(),
    room: c.room.value.trim(),
    weekParity: c.weekParity.value,
    isOptional: c.isOptional.checked,
  });

  const form = h('form', { class: 'editor' },
    field('Zi', c.weekday),
    field('Început', c.startTime),
    field('Sfârșit', c.endTime),
    field('Nume', c.name, 'wide'),
    field('Tip', c.type),
    field('Profesor coordonator', c.professor, 'wide'),
    field('Sala', c.room),
    field('Săptămâni', c.weekParity),
    h('div', { class: 'field check' }, c.isOptional, h('label', { for: c.isOptional.id }, 'Opțional (Opt.)')),
    h('div', { class: 'actions' },
      h('button', { type: 'submit', class: 'btn primary' }, session ? 'Salvează' : 'Adaugă'),
      session && h('button', {
        type: 'button', class: 'btn quiet',
        onclick: async () => {
          if (!confirm(`Ștergi „${session.name}”?`)) return;
          await adminAction(() => api(`/api/admin/sessions/${session.id}`, { method: 'DELETE' }), 'Ora a fost ștearsă.');
        },
      }, 'Șterge'),
    ),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (session) {
      await adminAction(() => api(`/api/admin/sessions/${session.id}`, { method: 'PATCH', body: values() }), 'Ora a fost salvată.');
    } else {
      await adminAction(
        () => api('/api/admin/sessions', { method: 'POST', body: { groupId: state.groupId, ...values() } }),
        'Ora a fost adăugată.',
      );
    }
  });
  return form;
}

async function adminAction(run, successText) {
  try {
    await run();
    await loadTimetable();
    setStatus(successText);
  } catch (err) {
    setStatus(err.message, true);
  }
}

function renderSessionEditor() {
  if ($('adminPanel').hidden) return;
  const meta = currentGroupMeta();
  const sessions = state.timetable?.sessions ?? [];
  $('sessionsInfo').textContent = meta
    ? `${meta.year.name}, ${meta.group.name}: ${sessions.length} ore. Grupa se schimbă din selectorul de sus.`
    : 'Alege o grupă.';
  $('sessionRows').replaceChildren(...sessions.map((s) => sessionForm(s)));
  $('newSession').replaceChildren(sessionForm(null));
}

const describe = (s) =>
  `${DAY_NAMES[s.weekday - 1]} ${s.startTime}–${s.endTime}, ${s.name}, ${TYPE_LABEL[s.type] ?? s.type}, ${s.professor}, ${s.room} (${PARITY_LABEL[s.weekParity]})`;

function renderImportResult(result) {
  const total = result.diff.reduce(
    (acc, d) => ({ add: acc.add + d.added.length, chg: acc.chg + d.changed.length, del: acc.del + d.removed.length }),
    { add: 0, chg: 0, del: 0 },
  );
  const box = $('importResult');
  box.replaceChildren(
    h('div', { class: 'diff' },
      h('b', {}, result.fileName),
      h('ul', {}, result.years.map((y) =>
        h('li', {}, `${y.name}: ${y.groups.length} grupe, ${y.groups.reduce((n, g) => n + g.sessions, 0)} ore în total`))),
    ),
    h('div', { class: 'diff' },
      h('b', {}, `Diferențe față de orarul publicat: ${result.diff.length} grupe`),
      h('div', {},
        h('span', { class: 'add' }, `+${total.add} adăugate `),
        h('span', { class: 'chg' }, `~${total.chg} modificate `),
        h('span', { class: 'del' }, `−${total.del} șterse`)),
      result.diff.slice(0, 40).map((d) =>
        h('details', {},
          h('summary', {}, `${d.year}, ${d.group}: +${d.added.length} ~${d.changed.length} −${d.removed.length}`),
          h('ul', {},
            d.added.map((s) => h('li', { class: 'add' }, `+ ${describe(s)}`)),
            d.changed.map((c) => h('li', { class: 'chg' }, `~ ${describe(c.before)} → ${describe(c.after)}`)),
            d.removed.map((s) => h('li', { class: 'del' }, `− ${describe(s)}`))))),
    ),
    h('div', { class: 'diff' },
      h('b', { class: result.errors.length ? 'del' : '' }, `Celule necitite: ${result.errors.length}`),
      result.errors.length > 0 &&
        h('ul', {}, result.errors.map((e) => h('li', {}, `${e.sheet}, celula ${e.cell}: „${e.text}” (${e.reason})`))),
    ),
    h('div', { class: 'row end' },
      h('button', {
        type: 'button', class: 'btn primary', disabled: result.diff.length === 0,
        onclick: async (event) => {
          event.target.disabled = true;
          try {
            const res = await api(`/api/admin/imports/${result.importId}/publish`, { method: 'POST' });
            await bootstrap(true);
            setStatus(`Publicat. ${res.changedGroups} grupe actualizate.`);
            box.replaceChildren();
          } catch (err) {
            setStatus(err.message, true);
          }
        },
      }, result.diff.length ? 'Publică' : 'Nimic de publicat'),
    ),
  );
}

// ---------- Wiring ----------

async function bootstrap(keepGroup = false) {
  [state.config, state.years] = await Promise.all([api('/api/config'), api('/api/years')]);
  const all = state.years.flatMap((y) => y.groups);
  const wanted = keepGroup ? state.groupId : store('psihorar.group');
  const groupId = all.some((g) => g.id === wanted) ? wanted : all[0]?.id ?? null;
  if (!groupId) {
    fillSelectors();
    showNotice('Orarul nu a fost încă încărcat.');
    render();
    return;
  }
  await selectGroup(groupId);
}

$('yearSelect').addEventListener('change', (e) => {
  const year = state.years.find((y) => y.id === e.target.value);
  if (year?.groups[0]) selectGroup(year.groups[0].id);
});
$('groupSelect').addEventListener('change', (e) => selectGroup(e.target.value));
$('copySubscribe').addEventListener('click', async () => {
  const input = $('subscribeUrl');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand('copy');
  }
  $('copySubscribe').textContent = 'Copiat';
  setTimeout(() => { $('copySubscribe').textContent = 'Copiază'; }, 1500);
});
document.addEventListener('click', (event) => {
  const box = $('subscribeBox');
  if (box.open && !box.contains(event.target)) box.open = false;
});
$('parityOdd').addEventListener('click', () => { state.parity = 'odd'; render(); });
$('parityEven').addEventListener('click', () => { state.parity = 'even'; render(); });

$('adminButton').addEventListener('click', () => {
  if (state.token) {
    $('adminPanel').scrollIntoView({ behavior: 'smooth' });
    return;
  }
  $('loginError').hidden = true;
  $('loginDialog').showModal();
});
$('loginCancel').addEventListener('click', () => $('loginDialog').close());
$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const res = await api('/api/admin/login', {
      method: 'POST',
      body: { email: $('loginEmail').value, password: $('loginPassword').value },
    });
    state.token = res.token;
    try { sessionStorage.setItem('psihorar.token', res.token); } catch { /* ignore */ }
    $('loginPassword').value = '';
    $('loginDialog').close();
    showAdmin(true);
    $('adminPanel').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    $('loginError').textContent = err.message;
    $('loginError').hidden = false;
  }
});
$('logoutButton').addEventListener('click', logout);

$('tabSettings').addEventListener('click', () => selectTab('Settings'));
$('tabSessions').addEventListener('click', () => selectTab('Sessions'));
$('tabImport').addEventListener('click', () => selectTab('Import'));

$('settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const saved = await api('/api/admin/config', {
      method: 'PUT',
      body: { semesterStart: $('semesterStart').value, semesterWeeks: Number($('semesterWeeks').value) },
    });
    state.config = { ...state.config, ...saved };
    state.parity = null;
    renderSettingsInfo();
    render();
    setStatus('Setările au fost salvate.');
  } catch (err) {
    setStatus(err.message, true);
  }
});

$('importForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = $('importFile').files[0];
  if (!file) return;
  const form = new FormData();
  form.set('file', file);
  setStatus('Se analizează fișierul…');
  try {
    renderImportResult(await api('/api/admin/imports', { method: 'POST', body: form }));
    setStatus('');
  } catch (err) {
    setStatus(err.message, true);
  }
});

// Statuses depend on the clock: refresh every 20 s and when the tab comes back.
setInterval(render, 20000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadTimetable();
});

(async () => {
  try {
    await bootstrap();
  } catch (err) {
    showNotice(err.message);
    return;
  }
  let saved = null;
  try { saved = sessionStorage.getItem('psihorar.token'); } catch { /* ignore */ }
  if (saved) {
    state.token = saved;
    try {
      await api('/api/admin/me');
      showAdmin(true);
    } catch {
      state.token = null;
    }
  }
})();
