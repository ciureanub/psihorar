# Versiuni

Numerotare semantică (MAJOR.MINOR.PATCH): PATCH = corecturi, MINOR = funcții noi compatibile, MAJOR = schimbări care cer pași noi la instalare.

## 1.1.0 — 2026-10-12

- Glisare cu două degete pe ecranele tactile:
  - pe orar (zona săptămânii și titlul cu datele): spre stânga = săptămâna următoare, spre dreapta = cea anterioară; nu trece înainte de săptămâna 1, la fel ca săgeata ‹;
  - în calendarul mic: spre stânga = luna următoare, spre dreapta = cea anterioară.
- Nu reacționează pe comutatoare, butoane sau în zona de Administrare. Glisarea cu un deget derulează ca înainte; ciupirea pentru zoom rămâne a browserului.
- Confirmare: conținutul nou alunecă din partea din care vine; la săptămâna 1, o mică săritură arată că nu se mai poate merge înapoi. Cu „reducere mișcare” activă în sistem, doar o estompare scurtă.

## 1.0.0 — 2026-10-12

Prima versiune stabilă (copie: `backups/psihorar-v1.0.0.zip`, eticheta git `v1.0.0`).

- Orar săptămânal pe an și grupă, impară / pară, stări gri / albastru / verde, „Urmează 1h3m”.
- Opționale An I (AMPAC, TAA, CAP, CFRD) ca comutatoare.
- Ancorare la ora curentă, butonul „Acum”, zilele trecute restrânse pe ecrane înguste, weekend = săptămâna viitoare.
- Săgeți ‹ › pentru săptămâni (limită la săptămâna 1), calendar mic.
- Calendar `.ics` per grupă și abonare.
- Administrare: setări, editare ore, import .xlsx cu previzualizare, sincronizare fail-safe cu fișierul Google Sheets al facultății.
- `PsihORAR.html` generat din același cod (`npm run build:html`).
