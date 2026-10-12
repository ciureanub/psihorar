$('calendarLink').addEventListener('click', (event) => {
  event.preventDefault();
  const found = findGroup(state.groupId);
  if (found) download(calendarFileName(), buildCalendar(found), 'text/calendar;charset=utf-8');
});

$('exportData').addEventListener('click', () => {
  download('psihorar-date.json', JSON.stringify(db, null, 2), 'application/json');
  setStatus('Datele au fost exportate.');
});

$('importData').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!isValidDb(parsed)) throw new Error(ERRORS.bad_file);
    if (!confirm('Înlocuiești tot orarul din acest browser cu cel din fișier?')) return;
    db = parsed;
    saveDb();
    state.weekOffset = 0;
    await bootstrap(true);
    showAdmin(true);
    setStatus('Datele au fost importate.');
  } catch (err) {
    setStatus(err instanceof SyntaxError ? ERRORS.bad_file : err.message, true);
  }
});

$('resetData').addEventListener('click', async () => {
  if (!confirm('Renunți la toate modificările și revii la orarul inițial din fișier?')) return;
  db = JSON.parse(JSON.stringify(SEED));
  saveDb();
  state.weekOffset = 0;
  await bootstrap(true);
  showAdmin(true);
  setStatus('Orarul inițial a fost restaurat.');
});
