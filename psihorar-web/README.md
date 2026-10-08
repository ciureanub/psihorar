# PsihORAR

Orar web pentru Facultatea de Psihologie: vizualizare săptămânală, responsivă, cu zonă de administrare.

- Orar pe an și grupă, săptămână impară / pară, ora curentă în fusul Europe/Bucharest.
- Gri = oră trecută, albastru = în desfășurare, verde = urmează.
- Fiecare oră arată: nume, tip (Curs / Seminar / Practică), profesor coordonator, sala, (Opt.).
- Calendar per grupă: descărcare `.ics` (`psihorar-an-i-grupa-i.ics`) sau abonare (Google, Apple, Outlook) la `/api/calendar/<an>/<grupa>.ics`, care se actualizează singură.
- Administrator: setări semestru, editare ore, import din .xlsx cu previzualizarea diferențelor.

## Publicare pe Replit

1. Creează un Repl nou de tip Node.js și urcă tot conținutul acestui folder (sau importă arhiva .zip).
2. În **Secrets** adaugă:

   | Cheie | Valoare |
   |---|---|
   | `ADMIN_EMAIL` | emailul de administrator |
   | `ADMIN_PASSWORD` | parola de administrator |
   | `SESSION_SECRET` | un șir aleatoriu de minimum 32 de caractere |

3. Pentru date care rezistă la redeploy, adaugă o bază de date PostgreSQL din panoul Replit (creează automat `DATABASE_URL`). Fără ea, datele stau în `data/state.json` și se pierd la reconstruirea deployment-ului.
4. Apasă **Run**. Comanda este `npm start`; serverul ascultă pe `PORT` (implicit 3000).

La prima pornire, dacă baza de date este goală, orarul se încarcă din `data/PSIH.xlsx`.

Parola nu se scrie niciodată în cod. Se schimbă doar din Secrets, apoi se repornește aplicația.

## Local

```
npm install
npm test
ADMIN_EMAIL=... ADMIN_PASSWORD=... npm start
```

Pe Windows (PowerShell): `$env:ADMIN_EMAIL="..."; $env:ADMIN_PASSWORD="..."; npm start`

## Structură

| Fișier | Rol |
|---|---|
| `src/server.ts` | pornire, variabile de mediu, încărcare inițială |
| `src/app.ts` | rutele API și servirea paginii |
| `src/store.ts` | datele: fișier JSON sau PostgreSQL |
| `src/parser.ts` | citirea fișierului .xlsx al facultății |
| `src/diff.ts` | diferențele dintre fișier și orarul publicat |
| `src/parity.ts` | numărul săptămânii și paritatea |
| `src/ics.ts` | exportul de calendar |
| `src/auth.ts` | parolă (scrypt) și sesiune de administrator |
| `public/` | pagina: `index.html`, `styles.css`, `app.js` |
| `src/exclusions.ts` | orele scoase din orar la cerere; importul le ignoră |
| `test/` | 35 de teste (`npm test`) |

## Reguli

- Săptămâna 1 a semestrului este impară. Implicit: început 2026-09-28, 20 de săptămâni.
- Importul nu modifică nimic până la „Publică”. Celulele care nu pot fi citite sunt listate, nu ignorate.
- Sesiunea de administrator expiră după 12 ore.
