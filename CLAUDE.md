# Ciro Monitor — Mappa PC Sala 1

## Scopo
App web per monitorare le postazioni della sede di Ciro Marina (192.168.70.x).
Mostra una piantina interattiva con stato online/offline di ogni PC, utente loggato in tempo reale, e Wake-on-LAN per accendere i PC spenti.

## Architettura
- **Backend**: Python (Flask) — gira su laptop o AD04 nella rete locale 192.168.70.x
- **Frontend**: React (Vite) — si connette al backend via HTTP
- **Rete**: tutto locale, nessuna VPN richiesta quando si è in sede Ciro

## Backend (Flask)
- `GET /api/pcs` — restituisce stato di tutti i PC (ping + WMI per utente loggato)
- `POST /api/wol/<hostname>` — invia magic packet WOL tramite MAC address
- Ping: usa `ping` di sistema (ICMP) per rilevare online/offline
- WMI: usa `impacket` o `wmi` (Windows) per query `Win32_ComputerSystem.UserName`
- Credenziali WMI: STAGIT\Administrator (configurabili via .env)
- CORS abilitato per sviluppo locale

## Frontend (React + Vite)
- Piantina SVG della Sala 1, posizioni fisse per ogni PC
- Ogni PC mostra: hostname, stato (online/offline/unknown), utente loggato
- Click su PC apre pannello laterale con dettagli + pulsante WOL (se offline)
- Auto-refresh ogni 30 secondi
- Colori: verde = online, rosso = offline, grigio = sconosciuto

## Dati PC Sala 1

```json
[
  {"hostname":"CI0032","ip":"192.168.70.129","mac":"00:19:99:94:21:C9","manufacturer":"Fujitsu"},
  {"hostname":"CI0034","ip":"192.168.70.142","mac":"64:31:50:20:B8:ED","manufacturer":"Engineering Corp"},
  {"hostname":"CI0016","ip":"192.168.70.148","mac":"00:24:81:97:FF:42","manufacturer":"HP"},
  {"hostname":"CI0026","ip":"192.168.70.136","mac":"3C:D9:2B:63:45:BD","manufacturer":"HP"},
  {"hostname":"CI0033","ip":"192.168.70.143","mac":"00:19:99:93:BE:B7","manufacturer":"Fujitsu"},
  {"hostname":"CI0045","ip":"192.168.70.105","mac":"B8:AC:6F:28:0A:B4","manufacturer":"Dell"},
  {"hostname":"CI0042","ip":"192.168.70.153","mac":"00:23:7D:B7:26:9D","manufacturer":"HP"},
  {"hostname":"CI0027","ip":"192.168.70.138","mac":"00:23:24:0D:6F:8D","manufacturer":"G-Pro"},
  {"hostname":"CI0044","ip":"192.168.70.158","mac":"F8:BC:12:71:B3:36","manufacturer":"Dell"},
  {"hostname":"CI0041","ip":"192.168.70.154","mac":"00:23:7D:BA:FA:7E","manufacturer":"HP"},
  {"hostname":"CI0022","ip":"192.168.70.132","mac":"00:19:99:94:AE:11","manufacturer":"Fujitsu"},
  {"hostname":"CI0037","ip":"","mac":"","manufacturer":""},
  {"hostname":"CI0039","ip":"192.168.70.146","mac":"00:23:7D:BB:33:0C","manufacturer":"HP"},
  {"hostname":"CI0020","ip":"192.168.70.133","mac":"00:19:99:94:26:68","manufacturer":"Fujitsu"},
  {"hostname":"CI0023","ip":"192.168.70.151","mac":"00:19:99:9B:97:CB","manufacturer":"Fujitsu"},
  {"hostname":"CI0024","ip":"192.168.70.159","mac":"00:19:99:9A:C3:78","manufacturer":"Fujitsu"},
  {"hostname":"CI0018","ip":"192.168.70.106","mac":"00:19:99:6F:A9:D5","manufacturer":"Fujitsu"},
  {"hostname":"CI0025","ip":"192.168.70.135","mac":"78:E3:B5:CB:9D:58","manufacturer":"HP"},
  {"hostname":"CI0030","ip":"192.168.70.141","mac":"00:23:7D:BF:46:25","manufacturer":"HP"},
  {"hostname":"CI0001","ip":"192.168.70.114","mac":"6C:4B:90:75:32:F2","manufacturer":"LiteON"},
  {"hostname":"CI0002","ip":"192.168.70.124","mac":"6C:4B:90:75:34:F6","manufacturer":"LiteON"},
  {"hostname":"CI0003","ip":"192.168.70.118","mac":"6C:4B:90:5D:27:67","manufacturer":"LiteON"},
  {"hostname":"CI0005","ip":"192.168.70.121","mac":"6C:4B:90:75:33:F1","manufacturer":"LiteON"},
  {"hostname":"CI0006","ip":"192.168.70.116","mac":"6C:4B:90:75:36:26","manufacturer":"LiteON"},
  {"hostname":"CI0007","ip":"192.168.70.122","mac":"6C:4B:90:79:B9:DD","manufacturer":"LiteON"},
  {"hostname":"CI0008","ip":"192.168.70.115","mac":"6C:4B:90:75:3D:C6","manufacturer":"LiteON"},
  {"hostname":"CI0009","ip":"192.168.70.123","mac":"6C:4B:90:75:41:C2","manufacturer":"LiteON"},
  {"hostname":"CI0011","ip":"192.168.70.126","mac":"F8:BC:12:65:6C:3C","manufacturer":"Dell"},
  {"hostname":"CI0028","ip":"192.168.70.137","mac":"00:24:81:98:72:F8","manufacturer":"HP"},
  {"hostname":"CI0035","ip":"192.168.70.104","mac":"00:19:99:6F:87:FC","manufacturer":"Fujitsu"},
  {"hostname":"CI0036","ip":"192.168.70.144","mac":"00:19:99:9B:98:27","manufacturer":"Fujitsu"},
  {"hostname":"CI0047","ip":"192.168.70.120","mac":"6C:4B:90:75:34:C7","manufacturer":"LiteON"}
]
```

## Layout Piantina Sala 1
Basato sulla piantina fisica (file piantina_hostname.png):

```
PARETE SUPERIORE
  [CI0032][CI0034]     porta     [CI0027][CI0044][CI0041]

  [CI0016]                [CI0022][CI0037][CI0039][CI0020]
[CI0045][CI0042][CI0026][CI0033]  [CI0023][CI0024]

ZONA INFERIORE (tavoli grandi senza PC visibili in Sala1)
                              [CI0018][CI0025]
```

## Convenzioni
- Documentazione e commenti nel codice: italiano
- Variabili e funzioni: inglese (standard)
- File .env per credenziali (non committare)

## Dipendenze Backend
```
flask
flask-cors
wakeonlan
pywin32      # WMI nativo Windows
wmi          # wrapper pywin32 per query WMI
python-dotenv
```

## Dipendenze Frontend
```
react
vite
axios
```

## Avvio sviluppo
```bash
# Backend
cd backend && pip install -r requirements.txt && python app.py

# Frontend
cd frontend && npm install && npm run dev
```

## Note importanti
- CI0037: non ha IP/MAC nei dati disponibili — mostrare come "sconosciuto" senza WOL
- Il broadcast WOL è 192.168.70.255
- Quando si fa il deploy su AD04, il backend gira su Windows: usare `wmi` (pywin32) invece di impacket per le query WMI locali/remote
- Per query WMI remote da laptop (non-Windows), usare impacket `wmiquery`
