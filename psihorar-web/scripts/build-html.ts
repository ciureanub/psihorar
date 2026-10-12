/**
 * Builds PsihORAR.html: the whole app in one file, with no server.
 *
 *   npm run build:html                       -> ../PsihORAR.html
 *   npm run build:html -- --xlsx file.xlsx   -> from a specific workbook
 *   npm run build:html -- --out some.html    -> to another path
 *
 * Data source, in order: --xlsx, data/last-good.xlsx (the last workbook the
 * server synced successfully from the faculty Google Sheet), data/PSIH.xlsx.
 * The page itself is public/index.html + styles.css + app.js, with the server
 * calls replaced by scripts/standalone/local-api.js (data in the browser).
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { OPTIONALS } from '../src/optionals.js';
import { parseWorkbook } from '../src/parser.js';

const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));

const { values } = parseArgs({
  options: { xlsx: { type: 'string' }, out: { type: 'string' } },
});
const xlsx =
  values.xlsx ?? (existsSync(root('data/last-good.xlsx')) ? root('data/last-good.xlsx') : root('data/PSIH.xlsx'));
const out = values.out ?? root('../PsihORAR.html');

function one(text: string, find: string, replacement: string): string {
  const count = text.split(find).length - 1;
  if (count !== 1) throw new Error(`Expected exactly one "${find.slice(0, 60)}", found ${count}. The page changed: update build-html.ts.`);
  return text.replace(find, () => replacement);
}

/** Replaces everything from `start` up to (not including) `end`. */
function cut(text: string, start: string, end: string, replacement: string): string {
  const i = text.indexOf(start);
  if (i < 0) throw new Error(`Marker not found: "${start.slice(0, 60)}". Update build-html.ts.`);
  const j = text.indexOf(end, i);
  if (j < 0) throw new Error(`Marker not found: "${end.slice(0, 60)}". Update build-html.ts.`);
  return text.slice(0, i) + replacement + text.slice(j);
}

// ---------- Data ----------

const workbook = await parseWorkbook(await readFile(xlsx));
let counter = 0;
const seed = {
  config: { semesterStart: '2026-09-28', semesterWeeks: 20 },
  years: workbook.years.map((y, yi) => ({
    id: `y${yi + 1}`,
    name: y.name,
    groups: y.groups.map((g, gi) => ({
      id: `y${yi + 1}g${gi + 1}`,
      name: g.name,
      sessions: g.sessions.map((s) => ({ id: `s${++counter}`, ...s })),
    })),
  })),
};
// "</" inside a <script> would end it early.
const safeJson = (value: unknown) => JSON.stringify(value).replace(/<\//g, '<\\/');

// ---------- Page ----------

let html = await readFile(root('public/index.html'), 'utf8');
const css = await readFile(root('public/styles.css'), 'utf8');
let js = await readFile(root('public/app.js'), 'utf8');
const localApi = (await readFile(root('scripts/standalone/local-api.js'), 'utf8'))
  .replace('/*SEED*/', () => safeJson(seed))
  .replace('/*OPTIONALS*/', () => safeJson(OPTIONALS));
const localWiring = await readFile(root('scripts/standalone/local-wiring.js'), 'utf8');

js = one(js, '// PsihORAR front-end. No framework, no build step.',
  "// PsihORAR, single-file version. Data lives in this file and in the browser's storage.");
js = cut(js, '// ---------- API ----------', '// ---------- Public view ----------', `${localApi}\n`);
js = cut(js, 'const describe = (s) =>', '// ---------- Wiring ----------', '');
js = cut(js, "$('importForm').addEventListener", '// Statuses depend on the clock', `${localWiring}\n`);
js = one(js, "  $('loginError').hidden = true;\n  $('loginDialog').showModal();",
  "  $('loginError').hidden = true;\n  $('loginHint').hidden = Boolean(store(ADMIN_KEY));\n  $('loginDialog').showModal();");
js = cut(js, 'function updateCalendarLinks() {', 'async function loadTimetable() {', 'function updateCalendarLinks() {}\n\n');
js = cut(js, "$('copySubscribe').addEventListener", "$('parityOdd').addEventListener('click',", '');

html = cut(html, '    <details class="subscribe" id="subscribeBox">', '  </section>\n\n  <section class="optionals"', '');
html = cut(html, '      <div class="sync-box" id="syncBox">', '    </div>\n    <p class="status" id="adminStatus"', `      <div class="row">
        <button type="button" class="btn primary" id="exportData">Exportă datele (.json)</button>
        <div class="field grow">
          <label for="importData">Importă date (.json)</label>
          <input type="file" id="importData" accept=".json,application/json">
        </div>
        <button type="button" class="btn quiet" id="resetData">Revino la orarul inițial</button>
      </div>
      <p class="hint">Modificările se păstrează doar în acest browser. Pentru alt dispozitiv, exportă datele aici și importă-le acolo.</p>
`);
html = one(html, 'aria-selected="false">Sincronizare / Import</button>', 'aria-selected="false">Date</button>');
html = one(html, '    <p class="error" id="loginError" role="alert" hidden></p>',
  '    <p class="hint" id="loginHint" hidden>Prima autentificare în acest browser: emailul și parola introduse acum devin datele de administrator.</p>\n    <p class="error" id="loginError" role="alert" hidden></p>');
html = one(html, '<link rel="stylesheet" href="/styles.css">', `<style>\n${css}</style>`);
html = one(html, '<script type="module" src="/app.js"></script>',
  `<script type="module">\n${js.replace(/<\/script/gi, '<\\/script')}</script>`);

// Server-only features must not leak into the single file.
for (const marker of ['subscribeBox', 'importForm', 'syncNow', 'syncBox', 'loadSyncStatus', "'/api/admin/imports", 'renderImportResult', 'webcal']) {
  if (html.includes(marker)) throw new Error(`Server-only code left in the output: ${marker}`);
}
if (/\bfetch\(/.test(js)) throw new Error('The single file must not call the server (fetch found).');

await writeFile(out, html);
const sessions = seed.years.reduce((n, y) => n + y.groups.reduce((m, g) => m + g.sessions.length, 0), 0);
console.log(`Wrote ${out}`);
console.log(`  data: ${xlsx.split(/[\\/]/).pop()} (${seed.years.length} years, ${sessions} sessions, ${workbook.errors.length} unreadable cells)`);
console.log(`  size: ${Math.round(html.length / 1024)} KB`);
