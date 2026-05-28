# PC Monitor

Monitoraggio in tempo reale delle postazioni di lavoro in rete locale.
Piantina interattiva con stato online/offline, utente loggato, dati hardware e Wake-on-LAN.

## Installazione

Eseguire come **Administrator** sul Windows Server della sede:

```powershell
irm https://raw.githubusercontent.com/lucasjbx/pc-monitor/main/bootstrap.ps1 | iex
```

Lo script scarica l'ultima release, installa il servizio Windows e apre la porta 5000.
Al termine: `http://<IP-server>:5000`

**Requisiti:** Python 3.x installato e nel PATH.

## Configurazione per la sede

Dopo l'installazione aprire `http://<IP-server>:5000` → ⚙ Impostazioni:

| Tab | Cosa configurare |
|-----|-----------------|
| Generale | Nome sede, intervallo polling |
| Rete | IP broadcast WOL, gateway, IP domain controller |
| WMI | Credenziali per query remote (utente loggato, CPU, RAM…) |
| PC | Aggiungere/modificare/rimuovere PC monitorati |
| Piantina | Caricare l'immagine della planimetria |

Posizionare i PC sulla piantina: **Modifica posizioni**.

## Aggiornamenti

Quando è disponibile una nuova versione appare un badge `↑ vX.X` nel titolo.
Click sul badge → **Aggiorna ora** — il servizio si riavvia automaticamente.

`config.json` e `positions.json` vengono sempre preservati durante l'aggiornamento.

## Funzionalità

- Piantina interattiva con zoom e pan
- Stato real-time: verde = online, rosso = offline, grigio = N/D
- Dati per PC online: utente loggato (nome completo da AD), sessione, CPU%, RAM, disco C:, modello, OS, tipo disco, velocità rete
- Wake-on-LAN per accendere i PC spenti
- Spegnimento remoto via WMI
- Sidebar con PC non ancora posizionati sulla piantina
- Tutte le impostazioni configurabili dall'UI senza toccare file

## Sviluppo locale

```bash
cd backend
pip install -r requirements.txt
python app.py
```

App disponibile su `http://localhost:5000`.

## Deploy nuova release

```bash
git tag v1.x.x
git push origin v1.x.x
```

Poi su GitHub: **Releases → Draft a new release** → seleziona il tag → pubblica.
Le installazioni attive riceveranno la notifica di aggiornamento entro un'ora.
