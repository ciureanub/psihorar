/**
 * Weekly cross-check: compares a freshly downloaded copy of the faculty
 * workbook with the timetable stored by the app and writes an HTML report.
 *
 *   node scripts/check-diff.mjs --state data/state.json --xlsx PSIH-live.xlsx \
 *        --out diferente.html [--year "An I"] [--focus "Grupa I"]
 *
 * check-diff.mjs is a self-contained bundle of this file (npm run build:check),
 * so it runs with plain Node, without node_modules.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseWorkbook, type ParsedSession } from '../src/parser.js';
import { computeDiff, type ExistingGroup, type GroupDiff } from '../src/diff.js';

const { values: args } = parseArgs({
  options: {
    state: { type: 'string' },
    xlsx: { type: 'string' },
    out: { type: 'string' },
    year: { type: 'string', default: 'An I' },
    focus: { type: 'string', default: 'Grupa I' },
  },
});
if (!args.state || !args.xlsx || !args.out) {
  console.error('Folosire: --state <state.json> --xlsx <fisier.xlsx> --out <diferente.html> [--year "An I"] [--focus "Grupa I"]');
  process.exit(2);
}

const state = JSON.parse(readFileSync(args.state, 'utf8'));
const yearName = new Map<string, string>(state.years.map((y: any) => [y.id, y.name]));
const existing: ExistingGroup[] = state.groups.map((g: any) => ({
  year: yearName.get(g.yearId) ?? '?',
  group: g.name,
  sessions: state.sessions.filter((s: any) => s.groupId === g.id),
}));

const parsed = await parseWorkbook(readFileSync(args.xlsx));
const diffs = computeDiff(existing, parsed.years).filter((d) => d.year === args.year);
const yearErrors = parsed.errors.filter((e) =>
  parsed.years.some((y) => y.name === args.year && y.sourceSheet === e.sheet),
);

// ---------- HTML ----------
const DAYS = ['', 'Luni', 'Marți', 'Miercuri', 'Joi', 'Vineri'];
const PARITY: Record<string, string> = { all: 'în fiecare săptămână', odd: 'săpt. impară', even: 'săpt. pară' };
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const when = (s: ParsedSession) => `${DAYS[s.weekday]} ${s.startTime}–${s.endTime}, ${PARITY[s.weekParity]}`;
const what = (s: ParsedSession) =>
  `<b>${esc(s.name)}</b> <span class="muted">(${s.type}${s.isOptional ? ', opțional' : ''})</span>`;
const where = (s: ParsedSession) => `${esc(s.professor)} · ${esc(s.room)}`;

/** Pairs a removed and an added session of the same subject as a move. */
function rows(d: GroupDiff): string[] {
  const added = [...d.added];
  const out: string[] = [];
  for (const r of d.removed) {
    const i = added.findIndex((a) => a.name === r.name && a.type === r.type);
    if (i >= 0) {
      const a = added.splice(i, 1)[0];
      out.push(`<li class="move">${what(a)}<br><s>${when(r)} · ${where(r)}</s><br>→ <b>${when(a)}</b> · ${where(a)}</li>`);
    } else {
      out.push(`<li class="del">Eliminat: ${what(r)}<br>${when(r)} · ${where(r)}</li>`);
    }
  }
  for (const a of added) out.push(`<li class="add">Nou: ${what(a)}<br>${when(a)} · ${where(a)}</li>`);
  for (const c of d.changed) {
    out.push(`<li class="move">${what(c.after)}, ${when(c.after)}<br><s>${where(c.before)}</s> → <b>${where(c.after)}</b></li>`);
  }
  return out;
}

const focus = diffs.find((d) => d.group === args.focus);
const others = diffs.filter((d) => d.group !== args.focus);
const now = new Date().toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest', dateStyle: 'full', timeStyle: 'short' });
const total = diffs.reduce((n, d) => n + rows(d).length, 0);

const section = (d: GroupDiff) => `<section><h3>${esc(d.group)}${d.isNewGroup ? ' <span class="tag">grupă nouă</span>' : ''}</h3><ul>${rows(d).join('')}</ul></section>`;

const html = `<!doctype html>
<html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Diferențe ${esc(args.year!)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1c2230;--muted:#667085;--line:#e3e6ec;--ok:#1f7a4d;--warn:#b54708;--accent:#2659c7}
@media (prefers-color-scheme:dark){:root{--bg:#11151c;--card:#1a2029;--fg:#e8ebf1;--muted:#98a2b3;--line:#2a3240;--ok:#4ade80;--warn:#fbbf24;--accent:#7aa2ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px}h1{margin:0 0 4px;font-size:22px}h2{font-size:17px;margin:28px 0 8px}h3{font-size:15px;margin:0 0 8px}
.muted{color:var(--muted)}.card,section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
.focus{border:2px solid var(--accent)}ul{margin:0;padding-left:18px}li{margin:6px 0}s{color:var(--muted)}
.ok{color:var(--ok);font-weight:600}.warn{color:var(--warn);font-weight:600}.tag{font-size:12px;border:1px solid var(--line);border-radius:6px;padding:1px 6px}
</style></head><body><main>
<h1>Diferențe ${esc(args.year!)}</h1>
<div class="muted">Verificat: ${esc(now)} · fișierul facultății (PSIH.xlsx din Google Drive) comparat cu orarul din PsihORAR</div>
<div class="card">${total ? `<span class="warn">${total} modificări în ${diffs.length} grupe</span>` : '<span class="ok">Nicio diferență pentru ' + esc(args.year!) + '.</span>'}${yearErrors.length ? `<br><span class="warn">${yearErrors.length} celule nu au putut fi citite.</span>` : ''}</div>
<h2>${esc(args.year!)}, ${esc(args.focus!)}</h2>
${focus ? section(focus).replace('<section>', '<section class="focus">') : `<div class="card focus"><span class="ok">Nicio diferență pentru ${esc(args.focus!)}.</span></div>`}
<h2>Celelalte grupe din ${esc(args.year!)}</h2>
${others.length ? others.map(section).join('\n') : '<div class="card"><span class="ok">Nicio diferență.</span></div>'}
${yearErrors.length ? `<h2>Celule necitite</h2><div class="card"><ul>${yearErrors.map((e) => `<li>${esc(e.sheet)}!${esc(e.cell)}: ${esc(e.reason)} <span class="muted">${esc(e.text)}</span></li>`).join('')}</ul></div>` : ''}
<p class="muted">Diferențele dispar după ce aplici sincronizarea din Administrare.</p>
</main></body></html>
`;

writeFileSync(args.out, html);
console.log(`${args.year}: ${total} modificări în ${diffs.length} grupe; ${args.focus}: ${focus ? rows(focus).length : 0}. Scris: ${args.out}`);
