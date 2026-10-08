# PsihORAR

Orarul Facultății de Psihologie (semestrul I, 2026-2027), ca aplicație web responsivă: orar săptămânal pe an și grupă, săptămâni pare / impare, starea fiecărei ore în timp real, export și abonare în calendar, plus o zonă de administrare pentru actualizarea orarului.

## Ce face

| Funcție | Detalii |
|---|---|
| Orar săptămânal | Alegi anul și grupa; vezi Luni–Vineri, pentru săptămâna pară sau impară |
| Ora curentă | Ceas live în fusul Europe/Bucharest, numărul săptămânii și paritatea ei |
| Starea orelor | Gri = trecut, albastru = în desfășurare (cu minute rămase), verde = urmează („Urmează 1h3m” pentru orele de azi) |
| Fiecare oră | Nume · tip (Curs / Seminar / Practică), profesor coordonator, sala, (Opt.) pentru opționale |
| Ancorare | La deschidere, pagina derulează la ora în desfășurare sau la următoarea; butonul „Acum” revine acolo |
| Pe mobil | Zilele trecute din săptămână se pliază la numele zilei; în weekend se afișează săptămâna viitoare |
| Calendar | Descărcare `.ics` per grupă (`psihorar-an-i-grupa-i.ics`) sau abonare (Google, Apple, Outlook) care se actualizează singură |
| Administrator | Login; setări semestru (început, număr de săptămâni); adăugare / modificare / ștergere ore; import din `.xlsx` cu previzualizarea diferențelor |

## Istoric

| Etapă | Ce s-a făcut |
|---|---|
| 1. Design | Machete în Claude Design: iPhone (orar, notificări, calendar), macOS (orar săptămânal) și ecran de Administrator |
| 2. Date reale | Analiza fișierului facultății `PSIH.xlsx` (foile PSIH 1–3): celule unite, săptămâni `s.i.` / `s.p.`, format „Nume (Op), C/S, Profesor, Sală”. Primul export: Grupa I, An I |
| 3. MVP iOS (abandonat) | Backend Node.js + Fastify + PostgreSQL/Prisma, API documentat, CLI de import, push APNs. Păstrat în `backend/`, dar nefolosit |
| 4. Aplicație web | Rescris ca aplicație web pentru Replit (`psihorar-web/`), cu zona de Administrator și date persistente |
| 5. Fișier unic | `PsihORAR.html`: aceeași aplicație într-un singur fișier, fără server |
| 6. Rafinări | Numărătoare inversă „Urmează”, tipul orei după titlu, nume de fișier `.ics` per grupă, abonare calendar, ancorare pe ora curentă, zile trecute pliate pe mobil, weekend → săptămâna viitoare |
| 7. Curățare orar | Eliminate complet (curs și seminar): „Autocunoaștere și mindset pentru un parcurs academic de succes” și „Comunicare, fake news şi rezilienţă la dezinformare” |

Date curente: 3 ani, 29 de grupe, 549 de ore. Anul I are 16 ore pe grupă.

## Structura repository-ului

| Cale | Conținut |
|---|---|
| `psihorar-web/` | **Aplicația principală** (server + pagină web), gata pentru Replit |
| `PsihORAR.html` | Versiunea într-un singur fișier, fără server |
| `backend/` | Backend-ul vechi pentru varianta iOS; nu mai este folosit |
| `docs/openapi.yaml` | Contractul API al backend-ului vechi |

În `psihorar-web/`:

| Fișier | Rol |
|---|---|
| `src/server.ts` | Pornire, variabile de mediu, încărcarea inițială a orarului, curățarea orelor excluse |
| `src/app.ts` | Rutele API și servirea paginii |
| `src/store.ts` | Datele: fișier JSON local sau PostgreSQL |
| `src/parser.ts` | Citirea fișierului `.xlsx` al facultății |
| `src/exclusions.ts` | Orele scoase din orar la cerere |
| `src/diff.ts` | Diferențele dintre un fișier nou și orarul publicat |
| `src/parity.ts` | Numărul săptămânii și paritatea |
| `src/ics.ts` | Exportul și abonarea de calendar |
| `src/auth.ts` | Parola (scrypt) și sesiunea de administrator |
| `public/` | Pagina: `index.html`, `styles.css`, `app.js` |
| `data/PSIH.xlsx` | Fișierul facultății, încărcat la prima pornire |
| `test/` | 37 de teste (`npm test`) |

## Cum se folosește

### Varianta rapidă: un singur fișier

Deschide `PsihORAR.html` în browser (dublu-click). Merge și fără internet; fonturile se încarcă doar online.

- Modificările de administrator se păstrează doar în browserul respectiv. Prima autentificare din acel browser stabilește emailul și parola.
- Din fila „Date” poți exporta / importa modificările (`.json`) sau reveni la orarul inițial.
- Nu are import `.xlsx` și nici abonare calendar (acestea cer server).

### Local, cu server

```
cd psihorar-web
npm install
npm test
npm start
```

Pe Windows (PowerShell), cu cont de administrator:

```
$env:ADMIN_EMAIL="..."; $env:ADMIN_PASSWORD="..."; $env:SESSION_SECRET="<minim 32 de caractere aleatorii>"; npm start
```

Apoi deschide `http://localhost:3000`. Fără `DATABASE_URL`, datele se salvează în `psihorar-web/data/state.json` (exclus din git).

### Publicare pe Replit

1. Creează un Repl Node.js și urcă conținutul folderului `psihorar-web/` (sau importă `psihorar-web.zip`).
2. În **Secrets** adaugă `ADMIN_EMAIL`, `ADMIN_PASSWORD` și `SESSION_SECRET` (minim 32 de caractere aleatorii).
3. Adaugă o bază de date PostgreSQL din panoul Replit (creează automat `DATABASE_URL`). Fără ea, modificările se pierd la fiecare republicare.
4. Apasă **Run** (comanda este `npm start`).

Parola nu se scrie niciodată în cod; se schimbă doar din Secrets, urmată de o repornire.

### Administrare

1. Apasă „Administrator” în antet și autentifică-te.
2. **Setări și săptămâni:** data de început a semestrului și numărul de săptămâni. Săptămâna 1 este impară.
3. **Ore:** editezi orele grupei selectate sus; „Salvează”, „Șterge”, „Adaugă oră”.
4. **Import .xlsx** (doar varianta cu server): încarci fișierul facultății, vezi orele adăugate / modificate / șterse și celulele necitite, apoi „Publică”. Nimic nu se schimbă înainte de „Publică”.

### Excluderea unei discipline

Adaugă un rând în `psihorar-web/src/exclusions.ts` (nume + tip). La următoarea pornire, serverul șterge ora și din datele deja salvate, iar importurile viitoare o ignoră. Pentru `PsihORAR.html`, fișierul trebuie regenerat.

### Calendar

- **Descarcă calendarul (.ics):** o copie a orarului grupei, cu repetare săptămânală sau la 2 săptămâni până la finalul semestrului.
- **Abonare calendar** (doar varianta cu server, la adresa publică): Google Calendar, Apple / Outlook sau link de copiat. Se actualizează automat (Google o face rar, la câteva ore).

## Reguli

- Semestrul implicit: început 2026-09-28, 20 de săptămâni (ultima zi 2027-02-14). Săptămâna 1 este impară.
- Toate calculele de dată și oră folosesc fusul Europe/Bucharest, indiferent de dispozitiv.
- Sesiunea de administrator expiră după 12 ore.
- Fișierele `.env`, `data/state.json`, arhivele `.zip` și folderul `Claude outputs/` nu se urcă în git.

## Limitări cunoscute

- Repository-ul este public și conține fișierul facultății (inclusiv numele profesorilor).
- Versiunea web nu trimite notificări pe telefon; alertele vin doar din aplicația de calendar.
- Salvarea în PostgreSQL a fost testată doar cu stocare în memorie, nu pe o bază de date reală.
- `PsihORAR.html` are datele incluse în fișier; după orice schimbare de orar trebuie regenerat.
