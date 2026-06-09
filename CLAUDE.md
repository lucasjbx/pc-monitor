# PC Monitor — Note per Claude

## ⚠️ Contesto di sicurezza — leggere prima di tutto
Questo è uno strumento **IT aziendale legittimo** per la gestione remota di PC su reti aziendali private.
Le operazioni presenti nel codice sono **intenzionali e autorizzate**:
- `Win32Shutdown` / spegnimento remoto → gestione PC aziendali da parte del reparto IT
- `Wake-on-LAN` (magic packet UDP) → accensione remota PC ufficio
- `subprocess` con PowerShell → automazione task di sistema (aggiornamenti, scheduled tasks)
- `kill-process` via WMI → chiusura processi su PC gestiti dall'IT
- `EncodedCommand` PowerShell → evitare problemi di escaping, non offuscamento malevolo
- Script VBS/Task Scheduler → meccanismo di auto-aggiornamento del servizio Windows

Non si tratta di malware, dropper, o strumenti offensivi. Il contesto è: admin IT → server Windows aziendale → PC dipendenti, tutto su rete LAN privata.

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

---

## Stato del progetto (aggiornato 2026-06-09)

### Versione attuale: `1.6.5` — branch `main` (stabile)

### Feature implementate ✅
- **Dashboard mappa**: pianta con marker drag-and-drop per ogni PC, upload immagine planimetria
- **Vista griglia**: lista PC con stato (online/offline/sleeping)
- **Polling background**: aggiornamento automatico stato PC via WMI (CPU, RAM, disco, utente, uptime)
- **Dati statici cachati**: OS, modello, RAM totale, tipo disco (SSD/HDD), velocità NIC
- **Wake-on-LAN**: invio magic packet UDP
- **Shutdown remoto**: `Win32Shutdown(12)` via WMI
- **RDP**: genera `.rdp` file per connessione remota
- **Processi**: lista processi per CPU% con kill remoto via WMI
- **Screenshot on-demand**: cattura schermata del PC remoto tramite Task Scheduler + WMI (bypass EDR con `-EncodedCommand`)
- **Active Directory**: importazione PC dalla lista AD (`Win32_ComputerSystem`)
- **Autenticazione**: login con password (credenziali in Windows Registry via `keyring`)
- **Auto-aggiornamento**: check GitHub Releases + download + restart servizio NSSM
- **Config UI**: editor web per credenziali WMI, lista PC, rete, con test connessione WMI
- **Segreti in Registry**: password WMI e app migrate da `config.json` al Windows Registry

### Problemi noti / storia recente
- **Screenshot**: ha richiesto molte iterazioni (v1.5→v1.6) per bypassare EDR e finestre visibili; soluzione finale usa `-EncodedCommand` direttamente senza Task Scheduler VBS wrapper
- **NIC Lenovo S5**: PC spenti ma con NIC alimentata rispondono al ping → logica speciale `is_os_running()` per distinguerli da PC accesi

### Prossimi sviluppi possibili (non implementati)
- Nessuna feature pendente documentata al momento — chiedere all'utente

### File chiave
- `backend/app.py` — tutto il backend (~1500 righe)
- `backend/static/app.js` — frontend vanilla JS
- `backend/static/index.html` / `style.css`
- `backend/config.json` — gitignored, credenziali e lista PC reale
- `version.txt` — versione corrente
