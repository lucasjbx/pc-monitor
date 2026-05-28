# PC Monitor — Note per Claude

## Architettura
- **Backend**: Python (Flask) — serve anche il frontend statico
- **Frontend**: vanilla JS/HTML/CSS in `backend/static/` (il frontend React in `frontend/` è obsoleto)
- **Deploy**: Windows Server (AD04 di ogni sede) come servizio Windows via NSSM
- **Config**: tutto in `backend/config.json` (gitignored) — credenziali WMI, lista PC, rete

## Endpoints principali
- `GET /api/pcs` — stato PC dalla cache di background
- `POST /api/wol/<hostname>` — Wake-on-LAN
- `POST /api/shutdown/<hostname>` — spegnimento via WMI
- `GET/POST /api/config` — lettura/scrittura config (password mascherata in GET)
- `GET /api/update/check` — confronta versione locale con ultima GitHub Release
- `POST /api/update/apply` — scarica release, aggiorna file, riavvia servizio

## WMI — dati raccolti
**Dinamici** (ogni poll): utente loggato (`explorer.exe`), CPU%, RAM%, disco C: libero, uptime
**Statici** (una volta, cachati per hostname): OS, modello PC, RAM totale, tipo disco (SSD/HDD), velocità rete

## Configurazioni sede
I dati reali delle sedi sono in `configs/` (gitignored, solo locale).
Template vuoto: `backend/config.example.json`.

## Convenzioni
- Commenti nel codice: italiano
- Variabili e funzioni: inglese

## Workflow
- **Branch di sviluppo**: lavorare sempre su `dev` (o `feature/*`), mai su `main` direttamente
- **`main` = stabile**: i colleghi aggiornano dall'UI che scarica l'ultima GitHub Release
- **Test locale prima del merge**: avviare `python app.py`, aprire il browser e verificare manualmente le funzionalità toccate; poi fare PR `dev → main`
- **Release solo da `main`**: dopo il merge, bumpa `version.txt` e crea la GitHub Release
- **Checklist test manuale veloce**:
  - [ ] Mappa carica e mostra marker
  - [ ] Editor posizioni: drag-and-drop funziona, salvataggio OK
  - [ ] Pannello PC laterale: lista, selezione, WOL/shutdown
  - [ ] Impostazioni: salvataggio e reload

## Dipendenze Backend
```
flask, flask-cors, pywin32, wmi, python-dotenv
```

## Avvio sviluppo
```bash
cd backend && pip install -r requirements.txt && python app.py
```
