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
  openDays: new Set(), // past days the user expanded, by date
  shownMonday: null, // Monday of the week on screen
  pickedDate: null,
  pickerMonth: null, // 'YYYY-MM' shown in the date picker
  weekOffset: 0, // weeks from the default week, moved by the arrows
  optionalPrefs: loadOptionalPrefs(), // { AMPAC: false, TAA: true, ... } as the student set them
  stacked: null, // last seen layout: days in one column?
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

// ---------- Optional disciplines (switches) ----------

const OPTIONAL_KEY = 'psihorar.optionale';

function loadOptionalPrefs() {
  try {
    // Literal key: this runs while `state` is being built, before OPTIONAL_KEY exists.
    const saved = JSON.parse(store('psihorar.optionale') ?? '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

const normName = (text) =>
  text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

function optionalsForYear() {
  const meta = currentGroupMeta();
  return meta ? (state.config?.optionals ?? []).filter((o) => o.year === meta.year.name) : [];
}

/** The optional discipline a session belongs to, or null. */
function optionalOf(session) {
  const key = normName(session.name);
  return optionalsForYear().find((o) => normName(o.name) === key) ?? null;
}

const isOn = (o) => (typeof state.optionalPrefs[o.code] === 'boolean' ? state.optionalPrefs[o.code] : o.defaultOn);
const hiddenCodes = () => optionalsForYear().filter((o) => !isOn(o)).map((o) => o.code);
const isVisible = (session) => {
  const o = optionalOf(session);
  return !o || isOn(o);
};

function renderOptionals() {
  const list = optionalsForYear();
  $('optionals').hidden = list.length === 0;
  $('optionalSwitches').replaceChildren(
    ...list.map((o) =>
      h('button', {
        type: 'button',
        class: 'switch',
        role: 'switch',
        'aria-checked': String(isOn(o)),
        title: o.name,
        'aria-label': `${o.code}: ${o.name}`,
        onclick: () => {
          state.optionalPrefs = { ...state.optionalPrefs, [o.code]: !isOn(o) };
          store(OPTIONAL_KEY, JSON.stringify(state.optionalPrefs));
          renderOptionals();
          updateCalendarLinks();
          render();
        },
      },
        h('span', { class: 'track', 'aria-hidden': 'true' }, h('span', { class: 'knob' })),
        h('span', { class: 'code' }, o.code),
      ),
    ),
  );
  $('optionalLegend').replaceChildren(
    ...list.map((o) => h('span', {}, h('b', {}, o.code), ` ${o.name}`)),
  );
}

async function selectGroup(groupId) {
  state.groupId = groupId;
  state.scrolledToToday = false;
  store('psihorar.group', groupId);
  fillSelectors();
  renderOptionals();
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
  const hidden = hiddenCodes();
  const query = hidden.length ? `?ascunde=${hidden.join(',')}` : '';
  $('calendarLink').href = `/api/groups/${meta.group.id}/calendar.ics${query}`;
  $('calendarLink').download = calendarFileName();
  const path = `/api/calendar/${slugify(meta.year.name)}/${slugify(meta.group.name)}.ics${query}`;
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
  const inSemester = week >= 1 && week <= state.config.semesterWeeks;

  $('clockDate').textContent = formatDate(now.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('clockTime').textContent = now.hhmm;
  $('clockWeek').textContent = inSemester
    ? `Săptămâna ${week} · ${currentParity === 'odd' ? 'impară' : 'pară'}`
    : 'În afara semestrului';

  // On Saturday and Sunday the week is over: show next week by default.
  const weekend = dayNumber(now.date) - dayNumber(mondayOf(now.date)) >= 5;
  const baseMonday = defaultMonday(now);
  const baseWeek = weekNumber(baseMonday, state.config.semesterStart);
  const monday = addDays(baseMonday, state.weekOffset * 7);
  const shownWeek = baseWeek + state.weekOffset;
  const parity = parityOf(shownWeek);
  state.shownMonday = monday;
  renderPicker();

  $('parityOdd').setAttribute('aria-pressed', String(parity === 'odd'));
  $('parityEven').setAttribute('aria-pressed', String(parity === 'even'));
  $('weekPrev').disabled = shownWeek <= 1;
  $('weekPrev').setAttribute('aria-label', shownWeek <= 1 ? 'Săptămâna anterioară (aceasta este prima săptămână)' : `Săptămâna anterioară: ${shownWeek - 1}`);
  $('weekNext').setAttribute('aria-label', `Săptămâna următoare: ${shownWeek + 1}`);
  $('rangeTitle').textContent =
    `${formatDate(monday, { day: 'numeric', month: 'long' })} – ${formatDate(addDays(monday, 4), { day: 'numeric', month: 'long' })}` +
    ` · ${
      shownWeek < 1
        ? 'înainte de semestru'
        : shownWeek > state.config.semesterWeeks
          ? `după semestru, săptămâna ${shownWeek}`
          : `săptămâna ${shownWeek}`
    }, ${parity === 'odd' ? 'impară' : 'pară'}` +
    (weekend && monday === baseMonday ? ' · săptămâna viitoare' : '');
  // Collapse only in the week being lived now (on a weekend that week is over).
  const isCurrentWeek = !weekend && monday === mondayOf(now.date);

  // Where the days stack in one column (phones, narrow tablets, narrow
  // windows), days already over collapse to their name.
  const stacked = isStacked();
  state.stacked = stacked;

  const sessions = (state.timetable?.sessions ?? []).filter(isVisible);
  const columns = DAY_NAMES.map((name, index) => {
    const date = addDays(monday, index);
    const isToday = date === now.date;
    const cards = sessions
      .filter((s) => s.weekday === index + 1 && (s.weekParity === 'all' || s.weekParity === parity))
      .map((s) => sessionCard(s, date, now));
    if (stacked && isCurrentWeek && date < now.date) {
      const open = state.openDays.has(date);
      return h(
        'div',
        { class: `day past-day${open ? ' open' : ''}`, 'data-date': date },
        h('button', {
          type: 'button',
          class: 'day-toggle',
          'aria-expanded': String(open),
          'aria-label': `${name}, zi încheiată, ${cards.length} ${cards.length === 1 ? 'oră' : 'ore'}`,
          onclick: () => {
            if (state.openDays.has(date)) state.openDays.delete(date);
            else state.openDays.add(date);
            render();
          },
        },
          h('span', { class: 'name' }, name),
          h('span', { class: 'chev', 'aria-hidden': 'true' }),
        ),
        open && (cards.length ? cards : h('div', { class: 'empty' }, 'Nicio oră.')),
      );
    }
    return h(
      'div',
      { class: `day${isToday ? ' today' : ''}`, 'data-date': date },
      h('div', { class: 'day-head', id: isToday ? 'today' : null },
        h('span', { class: 'num' }, formatDate(date, { day: 'numeric' })),
        h('span', { class: 'name' }, name),
      ),
      cards.length ? cards : h('div', { class: 'empty' }, 'Nicio oră.'),
    );
  });
  $('week').replaceChildren(...columns);

  // Anchor on "now": the class in progress, else the next one today, else the
  // last one that ended today. Marked on every refresh, scrolled to only once
  // per load (or on "Acum"), so it never fights the user's own scrolling.
  const todayCards = [...document.querySelectorAll('.day.today .card')];
  const focus =
    todayCards.find((c) => c.dataset.status === 'live') ??
    todayCards.find((c) => c.dataset.status === 'future') ??
    todayCards.at(-1) ??
    document.getElementById('today');
  focus?.classList.add('focus');
  if (!state.scrolledToToday && state.timetable) {
    state.scrolledToToday = true;
    if (focus) {
      const phone = stacked;
      // Two frames: let fonts and layout settle before measuring.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        // On a phone, keep the day name in sight when the class is the day's first.
        const target = phone && focus === todayCards[0] ? document.getElementById('today') : focus;
        target.scrollIntoView({ block: phone && target !== focus ? 'start' : 'center', behavior: 'auto' });
      }));
    }
  }
}

/** True when the week grid shows a single column. */
function isStacked() {
  const columns = getComputedStyle($('week')).gridTemplateColumns.trim().split(/\s+/).filter(Boolean);
  return columns.length <= 1;
}

/** "Acum": back to the current week and to the current class. */
function jumpToNow() {
  state.weekOffset = 0;
  state.pickedDate = null;
  state.scrolledToToday = false;
  render();
}

/** Monday of the week shown by default: this week, or next week on Saturday and Sunday. */
function defaultMonday(now = nowParts()) {
  const weekend = dayNumber(now.date) - dayNumber(mondayOf(now.date)) >= 5;
  return addDays(mondayOf(now.date), weekend ? 7 : 0);
}

// ---------- Date picker ----------

const MONTHS = ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie', 'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];

/** Shows the week that contains `dateISO` (any date, inside the semester or not), without scrolling. */
function showWeekOf(dateISO) {
  state.weekOffset = Math.round((dayNumber(mondayOf(dateISO)) - dayNumber(defaultMonday())) / 7);
  state.pickedDate = dateISO;
  // Only the week changes; the page stays where it is and the user scrolls.
  render();
}

function openPicker() {
  state.pickerMonth = (state.shownMonday ?? defaultMonday()).slice(0, 7);
  $('pickerPanel').hidden = false;
  $('pickerButton').setAttribute('aria-expanded', 'true');
  renderPicker();
  // Opens towards the left of the button; flips to the right if that would leave the screen.
  const panel = $('pickerPanel');
  panel.style.left = '';
  panel.style.right = '';
  if (!window.matchMedia('(max-width: 640px)').matches && panel.getBoundingClientRect().left < 8) {
    panel.style.left = '0';
    panel.style.right = 'auto';
  }
  const grid = $('pickerGrid');
  (grid.querySelector('button[aria-current="date"]') ?? grid.querySelector('button.in-week') ?? grid.querySelector('button'))?.focus();
}

function closePicker(returnFocus = true) {
  if ($('pickerPanel').hidden) return;
  $('pickerPanel').hidden = true;
  $('pickerButton').setAttribute('aria-expanded', 'false');
  if (returnFocus) $('pickerButton').focus();
}

function movePickerMonth(delta) {
  const [y, m] = state.pickerMonth.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  state.pickerMonth = d.toISOString().slice(0, 7);
  renderPicker();
}

function renderPicker() {
  if ($('pickerPanel').hidden) return;
  const now = nowParts();
  const [y, m] = state.pickerMonth.split('-').map(Number);
  $('pickerTitle').textContent = `${MONTHS[m - 1]} ${y}`;
  const first = `${state.pickerMonth}-01`;
  const start = mondayOf(first);
  const shown = state.shownMonday;
  const head = ['', 'L', 'Ma', 'Mi', 'J', 'V', 'S', 'D'].map((d) => h('span', { class: 'picker-dow', 'aria-hidden': 'true' }, d));
  const cells = [];
  for (let row = 0; row < 6; row++) {
    const rowMonday = addDays(start, row * 7);
    if (row > 0 && rowMonday.slice(0, 7) !== state.pickerMonth) break;
    const week = weekNumber(rowMonday, state.config.semesterStart);
    const par = parityOf(week) === 'odd' ? 'I' : 'P';
    cells.push(h('span', { class: `picker-week${rowMonday === shown ? ' in-week' : ''}`, title: week >= 1 ? `Săptămâna ${week}, ${par === 'I' ? 'impară' : 'pară'}` : (par === 'I' ? 'Impară' : 'Pară') },
      week >= 1 ? `S${week}` : '', h('b', {}, par)));
    for (let i = 0; i < 7; i++) {
      const date = addDays(rowMonday, i);
      const classes = ['picker-day'];
      if (date.slice(0, 7) !== state.pickerMonth) classes.push('other-month');
      if (i >= 5) classes.push('weekend');
      if (rowMonday === shown) classes.push('in-week');
      cells.push(h('button', {
        type: 'button',
        class: classes.join(' '),
        'aria-current': date === now.date ? 'date' : null,
        'aria-label': `${formatDate(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${week >= 1 ? `săptămâna ${week}, ` : ''}${par === 'I' ? 'impară' : 'pară'}`,
        onclick: () => {
          closePicker(false);
          showWeekOf(date);
        },
      }, String(Number(date.slice(8, 10)))));
    }
  }
  $('pickerGrid').replaceChildren(...head, ...cells);
}

/** Impară / Pară: the default week if it has that parity, otherwise the week after. */
function showParity(wanted) {
  const baseWeek = weekNumber(defaultMonday(), state.config.semesterStart);
  state.weekOffset = parityOf(baseWeek) === wanted ? 0 : 1;
  render();
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
    { class: `card ${status}`, 'data-status': status },
    h('div', { class: 'time' }, `${s.startTime}–${s.endTime}`),
    h('div', { class: 'title' },
      s.name,
      h('span', { class: 'kind' }, ` · ${TYPE_LABEL[s.type] ?? s.type}`),
      s.isOptional && h('span', { class: 'opt' }, optionalOf(s) ? `(Opt. · ${optionalOf(s).code})` : '(Opt.)')),
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
    window.dispatchEvent(new Event('psihorar:admin-open'));
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
$('parityOdd').addEventListener('click', () => showParity('odd'));
$('parityEven').addEventListener('click', () => showParity('even'));
// The arrow stops at week 1; the date picker can still show any week.
$('weekPrev').addEventListener('click', () => {
  if (weekNumber(state.shownMonday, state.config.semesterStart) > 1) state.weekOffset -= 1;
  render();
});
$('pickerButton').addEventListener('click', () => ($('pickerPanel').hidden ? openPicker() : closePicker()));
$('pickerPrev').addEventListener('click', () => movePickerMonth(-1));
$('pickerNext').addEventListener('click', () => movePickerMonth(1));
$('pickerToday').addEventListener('click', () => {
  closePicker(false);
  showWeekOf(nowParts().date);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closePicker();
});
document.addEventListener('click', (event) => {
  if (!$('pickerBox').contains(event.target)) closePicker(false);
});
$('weekNext').addEventListener('click', () => { state.weekOffset += 1; render(); });
$('jumpNow').addEventListener('click', jumpToNow);
// Rotation or resizing can switch between stacked and side-by-side days.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.stacked !== null && isStacked() !== state.stacked) render();
  }, 150);
});

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
    state.weekOffset = 0;
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


// ---------- Google Sheet sync (admin) ----------

const when = (iso) =>
  iso
    ? new Intl.DateTimeFormat('ro-RO', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
    : 'niciodată';

function renderSync(status) {
  const box = $('syncStatus');
  if (!status.enabled) {
    box.replaceChildren('Sincronizarea este oprită (SHEET_XLSX_URL=off). Orarul se actualizează doar prin import manual.');
    $('syncNow').disabled = true;
    return;
  }
  $('syncNow').disabled = Boolean(status.running);
  const good = status.lastGood;
  const failedLast = status.lastError && (!status.lastSuccessAt || status.lastAttemptAt > status.lastSuccessAt);
  box.replaceChildren(
    good
      ? h('span', {}, 'Ultima versiune bună: ', h('b', {}, when(status.lastSuccessAt)), ` · ${good.years} ani, ${good.sessions} ore`)
      : h('span', {}, 'Încă nicio sincronizare reușită: se folosește orarul inclus în aplicație.'),
    h('br'),
    h('span', {}, 'Ultima verificare: ', h('b', {}, when(status.lastAttemptAt)),
      failedLast ? ' · ' : status.lastAttemptAt ? ` · reușită, ${status.lastChangedGroups} grupe modificate` : ''),
    failedLast && h('span', { class: 'sync-error' }, `eșuată: ${status.lastError} Orarul afișat rămâne neschimbat.`),
  );
}

async function loadSyncStatus() {
  try {
    renderSync(await api('/api/admin/sync'));
  } catch (err) {
    $('syncStatus').textContent = err.message;
  }
}

window.addEventListener('psihorar:admin-open', loadSyncStatus);
$('tabImport').addEventListener('click', loadSyncStatus);
$('syncNow').addEventListener('click', async () => {
  $('syncNow').disabled = true;
  setStatus('Se descarcă fișierul facultății…');
  try {
    const result = await api('/api/admin/sync', { method: 'POST' });
    renderSync(result.status);
    if (result.ok) {
      await bootstrap(true);
      setStatus(result.changedGroups ? `Sincronizat. ${result.changedGroups} grupe actualizate.` : 'Sincronizat. Nicio modificare.');
    } else {
      setStatus(`Sincronizarea a eșuat; orarul rămâne la ultima versiune bună. ${result.error}`, true);
    }
  } catch (err) {
    setStatus(err.message, true);
    loadSyncStatus();
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
