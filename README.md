# Ciro Monitor

Mappa interattiva delle postazioni Sala 1 — sede Ciro Marina (192.168.70.x).

## Avvio rapido

### 1. Backend (Flask)
```bash
cd backend
cp .env.example .env
# Modifica .env con la password di STAGIT\Administrator
pip install -r requirements.txt
python app.py
```
Il backend parte su `http://localhost:5000`

### 2. Frontend (React)
```bash
cd frontend
npm install
npm run dev
```
L'app è disponibile su `http://localhost:3000`

## Funzionalità
- **Piantina SVG** fedele al layout fisico della Sala 1
- **Stato real-time**: verde = online, rosso = offline, grigio = N/D
- **Utente loggato**: query WMI remota su ogni PC acceso
- **Wake-on-LAN**: pulsante per accendere i PC spenti (richiede MAC)
- **Auto-refresh** ogni 30 secondi

## Note
- Il backend fa ping ICMP + query WMI in parallelo su tutti i PC
- CI0037 non ha IP/MAC nei dati disponibili — appare come N/D senza WOL
- Per deploy su AD04 (Windows): usare `wmi` (pywin32) al posto di `impacket`
