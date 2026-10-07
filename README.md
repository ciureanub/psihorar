# PsihORAR

Orar pentru Facultatea de Psihologie: aplicație iOS (SwiftUI + SwiftData) și backend (Node.js 22, Fastify, PostgreSQL, Prisma).

## Stadiu

| Pas | Conținut | Stare |
|---|---|---|
| 1 | Modele backend, paritate, parser xlsx, diff | gata, testat |
| 2 | CLI: import, publish, editare ore | scris, netestat cap-coadă (cere server + DB) |
| 3 | API public, login Admin, push APNs | gata, testat cu stocare în memorie |
| 3b | Stocarea PostgreSQL (`src/store/prisma.ts`) | scrisă, NETESTATĂ: rulează pașii de mai jos |
| 4+ | iOS: modele, orar, cache, notificări, push, calendar, ecrane Admin | urmează |

## Pornire locală (backend)

```
cd backend
npm install
npm test                      # 31 de teste, fără bază de date
docker compose up -d db       # PostgreSQL pe localhost:5432
npm run db:push               # creează tabelele
npm run typecheck             # generează clientul Prisma și verifică tipurile
npm run dev                   # API pe http://localhost:3000
```

Totul în Docker: `docker compose up --build`.

## Variabile de mediu

Fișierul `.env` stă în rădăcina proiectului (`psihorar\.env`), lângă `backend\`. Modelul este `backend\.env.example`. Nu se urcă în git.

| Variabilă | Rol |
|---|---|
| `DATABASE_URL` | conexiunea PostgreSQL |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | contul de Admin; se creează sau se actualizează la pornirea serverului |
| `ADMIN_TOKEN_SECRET` | semnează sesiunea de Admin; minimum 32 de caractere aleatorii |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_P8`, `APNS_BUNDLE_ID` | push; fără ele serverul pornește, dar nu trimite notificări |

## Actualizarea orarului (CLI)

```
npm run cli -- import test/fixtures/PSIH.xlsx    # arată diferențele și erorile, nu scrie nimic
npm run cli -- publish <importId>                # aplică și trimite push
npm run cli -- groups                            # ani și grupe, cu id-uri
npm run cli -- sessions <groupId>                # orele unei grupe, cu id-uri
npm run cli -- session edit <sessionId> --room D1
npm run cli -- session add --group <groupId> --weekday 5 --start 16:00 --end 18:00 --name "Consultații" --type seminar --professor "..." --room D2
npm run cli -- session remove <sessionId>
```

## Reguli

- Semestrul începe la 2026-09-28 și are 20 de săptămâni (ultima zi: 2027-02-14). Săptămâna 1 este impară.
- Contractul API: `docs/openapi.yaml`.
- Tipuri de ore: `curs`, `seminar`, `practica` (practica pedagogică din anul III, cu intervalul orar luat din textul celulei).
