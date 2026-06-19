"""
Ciro Monitor — Backend Flask
Endpoint per stato PC, utente loggato (WMI) e Wake-on-LAN
Configurazione centralizzata in config.json
"""

import os
import re
import json as json_lib
import socket
import sqlite3
import subprocess
import platform
import threading
import time
import shutil
import tempfile
import urllib.request
import zipfile
from datetime import datetime, timezone, timedelta
from functools import wraps
from flask import Flask, jsonify, request, send_file, send_from_directory, Response
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

BASE_DIR       = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE    = os.path.join(BASE_DIR, "config.json")
POSITIONS_FILE = os.path.join(BASE_DIR, "positions.json")
STATIC_DIR     = os.path.join(BASE_DIR, "static")
FLOORPLAN_PATH = os.path.join(BASE_DIR, "..", "piantina.png")
VERSION_FILE   = os.path.join(BASE_DIR, "..", "version.txt")
LOGIN_DB_FILE  = os.path.join(BASE_DIR, "login_history.db")
GITHUB_REPO    = "lucasjbx/pc-monitor"
SERVICE_NAME   = "PcMonitor"
PRESERVE_ON_UPDATE = {"config.json", "positions.json"}

# ── Registry segreti ──────────────────────────────────────────────────────────
# I segreti (password WMI, auth token) vengono salvati in una chiave Registry
# protetta SYSTEM-only, separata da config.json che contiene solo dati non sensibili.
SECRETS_REG_PATH  = r"SOFTWARE\PcMonitor\Secrets"
SECRET_WMI_PASS   = "WmiPass"
SECRET_AUTH_TOKEN = "AuthToken"


def get_secret(name: str) -> str:
    """
    Legge un segreto dalla chiave Registry HKLM\\SOFTWARE\\PcMonitor\\Secrets.
    Fallback a config.json se il Registry non è disponibile o il valore è vuoto
    (garantisce retrocompatibilità e gestisce il caso in cui install.ps1 non è
    ancora stato eseguito dopo un aggiornamento via UI).
    """
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, SECRETS_REG_PATH, 0, winreg.KEY_READ)
        val, _ = winreg.QueryValueEx(key, name)
        winreg.CloseKey(key)
        if val:
            return val
    except Exception:
        pass
    # Fallback: legge da config.json (install non ancora eseguito, o ambienti non-Windows)
    _fallback = {SECRET_WMI_PASS: ("wmi", "pass"), SECRET_AUTH_TOKEN: ("auth", "token")}
    if name in _fallback:
        section, key_name = _fallback[name]
        return get_cfg().get(section, {}).get(key_name, "")
    return ""


def set_secret(name: str, value: str) -> bool:
    """
    Scrive o cancella un segreto nella chiave Registry.
    Crea la chiave se non esiste (CreateKeyEx).
    Ritorna True se l'operazione è riuscita, False altrimenti.
    NOTA: winreg.CreateKeyEx in Python ritorna un handle singolo (non una tupla
    come la C API) — non fare tuple unpacking.
    """
    try:
        import winreg
        # CreateKeyEx crea la chiave se non esiste (a differenza di OpenKey)
        # Restituisce un PyHKEY handle — NON una tupla
        key = winreg.CreateKeyEx(winreg.HKEY_LOCAL_MACHINE, SECRETS_REG_PATH,
                                 0, winreg.KEY_SET_VALUE)
        if value:
            winreg.SetValueEx(key, name, 0, winreg.REG_SZ, value)
        else:
            try:
                winreg.DeleteValue(key, name)
            except OSError:
                pass
        winreg.CloseKey(key)
        return True
    except Exception:
        return False   # non-Windows, accesso negato o Registry non disponibile


# ── Autenticazione ────────────────────────────────────────────────────────────
def require_auth(f):
    """
    Decorator — verifica X-Api-Key se auth token è configurato nel Registry.
    Se il token è vuoto, l'endpoint è aperto senza autenticazione (retrocompatibile).
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        token = get_secret(SECRET_AUTH_TOKEN)
        if token:
            key = request.headers.get("X-Api-Key", "")
            if key != token:
                return jsonify({"error": "Non autorizzato"}), 401
        return f(*args, **kwargs)
    return decorated


# ── Config globale ────────────────────────────────────────────────────────────
_config      = {}
_config_lock = threading.Lock()

# ── Cache fullname AD (username → fullname, calcolato una sola volta) ─────────
_fullname_cache      = {}
_fullname_cache_lock = threading.Lock()


def lookup_fullname_ad(username: str) -> str:
    """
    Cerca nome e cognome dell'utente AD interrogando il domain controller via WMI.
    Usa le credenziali WMI e dc_ip dalla config. Risultato cachato.
    """
    with _fullname_cache_lock:
        if username in _fullname_cache:
            return _fullname_cache[username]

    fullname = ""
    cfg      = get_cfg()
    dc_ip    = cfg.get("network", {}).get("dc_ip", "")
    wmi_user = cfg.get("wmi", {}).get("user", "")
    wmi_pass = get_secret(SECRET_WMI_PASS)

    if username:
        try:
            import wmi
            import pythoncom
            pythoncom.CoInitialize()
            try:
                # Prima prova locale: se siamo sul DC, Win32_UserAccount
                # restituisce tutti gli utenti di dominio senza credenziali
                c        = wmi.WMI()
                accounts = c.Win32_UserAccount(Name=username)
                if accounts and accounts[0].FullName:
                    fullname = accounts[0].FullName

                # Fallback: connessione remota al DC con credenziali
                if not fullname and dc_ip and wmi_user and wmi_pass:
                    c2       = wmi.WMI(computer=dc_ip, user=wmi_user, password=wmi_pass)
                    accounts = c2.Win32_UserAccount(Name=username)
                    if accounts and accounts[0].FullName:
                        fullname = accounts[0].FullName
            finally:
                pythoncom.CoUninitialize()
        except Exception:
            pass

    with _fullname_cache_lock:
        _fullname_cache[username] = fullname
    return fullname


_DEFAULT_CONFIG = {
    "sede":    {"name": "PC Monitor", "poll_interval": 10, "login_history_interval": 30},
    "network": {"wol_broadcast": "", "gateway_ip": "", "dc_ip": ""},
    "wmi":     {"user": "", "pass": ""},
    "auth":    {"token": ""},
    "pcs":     [],
}


def load_config() -> dict:
    """
    Carica config.json da disco. Se non esiste (primo avvio / installazione fresca)
    crea il file con i valori di default e lo ritorna.
    """
    if not os.path.exists(CONFIG_FILE):
        save_config(_DEFAULT_CONFIG)
        return dict(_DEFAULT_CONFIG)
    with open(CONFIG_FILE, encoding="utf-8-sig") as f:  # utf-8-sig rimuove BOM se presente (scritto da PowerShell 5.1)
        return json_lib.load(f)


def save_config(cfg: dict) -> None:
    """Salva config.json su disco (indentato per leggibilità)"""
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json_lib.dump(cfg, f, indent=2, ensure_ascii=False)


def apply_config(cfg: dict) -> None:
    """Applica la config in memoria — thread-safe"""
    global _config
    with _config_lock:
        _config = cfg


def get_cfg() -> dict:
    """Legge snapshot thread-safe della config corrente"""
    with _config_lock:
        return dict(_config)


# Carica all'avvio
apply_config(load_config())


def _migrate_secrets_to_registry():
    """
    Migrazione una-tantum: se config.json contiene ancora wmi.pass o auth.token in chiaro,
    li sposta nel Registry e li azzera nel file.  Eseguita ad ogni avvio ma è idempotente.
    IMPORTANTE: azzera il valore nel file SOLO se la scrittura nel Registry è riuscita,
    altrimenti il segreto rimane in config.json come fallback finché install.ps1 non viene
    eseguito (es. aggiornamento via UI senza bootstrap).
    """
    cfg     = get_cfg()
    changed = False
    if cfg.get("wmi", {}).get("pass"):
        if set_secret(SECRET_WMI_PASS, cfg["wmi"]["pass"]):
            cfg["wmi"]["pass"] = ""
            changed = True
    if cfg.get("auth", {}).get("token"):
        if set_secret(SECRET_AUTH_TOKEN, cfg["auth"]["token"]):
            cfg["auth"]["token"] = ""
            changed = True
    if changed:
        save_config(cfg)
        apply_config(cfg)


_migrate_secrets_to_registry()


# ── Helpers di rete ───────────────────────────────────────────────────────────
def get_wmi_target(pc: dict) -> str:
    """
    Restituisce il target (IP) per ping e WMI.
    - Se pc["ip"] è valorizzato lo usa direttamente (retrocompatibilità)
    - Altrimenti risolve l'hostname via DNS per ottenere l'IP corrente:
      su Windows AD con DDNS il record viene aggiornato ad ogni rinnovo DHCP,
      quindi gethostbyname restituisce sempre l'IP attuale senza doverlo configurare.
    - Fallback finale: l'hostname stesso (DCOM può risolverlo via NetBIOS su reti locali).
    """
    ip = pc.get("ip", "")
    if ip:
        return ip
    hostname = pc.get("hostname", "")
    if not hostname:
        return ""
    try:
        return socket.gethostbyname(hostname)
    except Exception:
        return hostname   # DCOM su rete locale può usare il nome diretto


def get_local_ip(gateway_ip: str) -> str:
    """Trova l'IP locale sull'interfaccia che raggiunge il gateway"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect((gateway_ip, 80))
            return s.getsockname()[0]
    except Exception:
        return "0.0.0.0"


def send_wol(mac: str) -> None:
    """
    Invia magic packet WOL via socket UDP raw, legato all'interfaccia corretta.
    Formato: 6 byte 0xFF + MAC ripetuto 16 volte = 102 byte.
    """
    cfg = get_cfg()
    wol_broadcast = cfg.get("network", {}).get("wol_broadcast", "192.168.70.255")
    gateway_ip    = cfg.get("network", {}).get("gateway_ip",    "192.168.70.1")

    mac_clean = mac.replace(":", "").replace("-", "")
    magic     = bytes.fromhex("FF" * 6 + mac_clean * 16)
    local_ip  = get_local_ip(gateway_ip)

    targets = [
        ("255.255.255.255", 9),
        ("255.255.255.255", 7),
        (wol_broadcast,    9),
        (wol_broadcast,    7),
    ]
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        s.bind((local_ip, 0))
        for addr, port in targets:
            s.sendto(magic, (addr, port))


def ping(ip: str) -> bool:
    """Ping ICMP — funziona su Windows e Linux/macOS"""
    if not ip:
        return False
    if platform.system().lower() == "windows":
        cmd = ["ping", "-n", "1", "-w", "1000", ip]
    else:
        cmd = ["ping", "-c", "1", "-W", "1", ip]
    try:
        result = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
        return result.returncode == 0
    except Exception:
        return False


def is_os_running(ip: str) -> bool:
    """
    Verifica se Windows è effettivamente in esecuzione controllando la porta 135
    (RPC Endpoint Mapper). Se il ping risponde ma questa porta no, la NIC è
    alimentata in S5 per WOL (comune su Lenovo e altri) ma il sistema è spento.
    """
    try:
        with socket.create_connection((ip, 135), timeout=0.8):
            return True
    except Exception:
        return False


def parse_wmi_dt(s: str):
    """Converte datetime WMI '20250522083022.000000+120' → ISO string"""
    if not s:
        return None
    try:
        dt  = datetime.strptime(s[:14], "%Y%m%d%H%M%S")
        ofs = int(s[21:]) if len(s) > 21 else 0
        return dt.replace(tzinfo=timezone(timedelta(minutes=ofs))).isoformat()
    except Exception:
        return None


# ── Cronologia accessi (login/logout) — SQLite locale ───────────────────────────
_login_db_lock = threading.Lock()

# Account di sistema/macchina da escludere dalla cronologia accessi
_LOGIN_IGNORE_USERS = {
    "SYSTEM", "LOCAL SERVICE", "NETWORK SERVICE", "ANONYMOUS LOGON",
    "DWM-1", "DWM-2", "DWM-3", "UMFD-0", "UMFD-1", "UMFD-2", "UMFD-3",
}


def _login_db_init() -> None:
    """Crea le tabelle del DB cronologia accessi se non esistono. Chiamata all'avvio."""
    with _login_db_lock:
        conn = sqlite3.connect(LOGIN_DB_FILE)
        try:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS login_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    hostname   TEXT NOT NULL,
                    username   TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    timestamp  TEXT NOT NULL,
                    logon_type INTEGER
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_login_events_hostname
                ON login_events (hostname, timestamp DESC)
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS login_scan_state (
                    hostname           TEXT PRIMARY KEY,
                    last_record_number INTEGER NOT NULL DEFAULT 0,
                    last_scan_at       TEXT,
                    last_error         TEXT
                )
            """)
            # Migrazione: aggiunge le colonne se il DB esiste già da una versione precedente
            cols = {row[1] for row in conn.execute("PRAGMA table_info(login_scan_state)")}
            if "last_scan_at" not in cols:
                conn.execute("ALTER TABLE login_scan_state ADD COLUMN last_scan_at TEXT")
            if "last_error" not in cols:
                conn.execute("ALTER TABLE login_scan_state ADD COLUMN last_error TEXT")
            conn.commit()
        finally:
            conn.close()


def _login_db_get_last_record(hostname: str) -> int:
    """Ritorna l'ultimo RecordNumber del Security log già processato per questo PC."""
    with _login_db_lock:
        conn = sqlite3.connect(LOGIN_DB_FILE)
        try:
            row = conn.execute(
                "SELECT last_record_number FROM login_scan_state WHERE hostname = ?",
                (hostname,)
            ).fetchone()
            return row[0] if row else 0
        finally:
            conn.close()


def _login_db_set_last_record(hostname: str, record_number: int) -> None:
    with _login_db_lock:
        conn = sqlite3.connect(LOGIN_DB_FILE)
        try:
            conn.execute("""
                INSERT INTO login_scan_state (hostname, last_record_number)
                VALUES (?, ?)
                ON CONFLICT(hostname) DO UPDATE SET last_record_number = excluded.last_record_number
            """, (hostname, record_number))
            conn.commit()
        finally:
            conn.close()


def _login_db_set_scan_status(hostname: str, error: str | None) -> None:
    """Registra l'esito (ok/errore) e l'orario dell'ultima scansione per questo PC,
    senza modificare last_record_number."""
    now = datetime.utcnow().isoformat()
    with _login_db_lock:
        conn = sqlite3.connect(LOGIN_DB_FILE)
        try:
            conn.execute("""
                INSERT INTO login_scan_state (hostname, last_record_number, last_scan_at, last_error)
                VALUES (?, 0, ?, ?)
                ON CONFLICT(hostname) DO UPDATE SET
                    last_scan_at = excluded.last_scan_at,
                    last_error   = excluded.last_error
            """, (hostname, now, error))
            conn.commit()
        finally:
            conn.close()


def _login_db_get_scan_status(hostname: str) -> dict:
    """Ritorna {'last_scan_at': str|None, 'last_error': str|None} per questo PC."""
    with _login_db_lock:
        conn = sqlite3.connect(LOGIN_DB_FILE)
        try:
            row = conn.execute(
                "SELECT last_scan_at, last_error FROM login_scan_state WHERE hostname = ?",
                (hostname,)
            ).fetchone()
            if not row:
                return {"last_scan_at": None, "last_error": None}
            return {"last_scan_at": row[0], "last_error": row[1]}
        finally:
            conn.close()


def _login_db_insert_events(hostname: str, events: list) -> None:
    with _login_db_lock:
        conn = sqlite3.connect(LOGIN_DB_FILE)
        try:
            conn.executemany("""
                INSERT INTO login_events (hostname, username, event_type, timestamp, logon_type)
                VALUES (?, ?, ?, ?, ?)
            """, [
                (hostname, e["username"], e["event_type"], e["timestamp"], e["logon_type"])
                for e in events
            ])
            conn.commit()
        finally:
            conn.close()


def _login_db_get_history(hostname: str, limit: int = 100) -> list:
    with _login_db_lock:
        conn = sqlite3.connect(LOGIN_DB_FILE)
        try:
            conn.row_factory = sqlite3.Row
            rows = conn.execute("""
                SELECT username, event_type, timestamp, logon_type
                FROM login_events
                WHERE hostname = ?
                ORDER BY timestamp DESC, id DESC
                LIMIT ?
            """, (hostname, limit)).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()


def scan_login_events(pc: dict) -> dict:
    """
    Legge i nuovi eventi di logon/logoff (LogonType 2 o 7) dal Security log
    del PC remoto e li salva nel DB cronologia accessi. Va chiamata periodicamente
    da _login_history_loop(), solo per PC online.

    Ritorna un dict con esito/diagnostica: {"ok": bool, "error": str|None,
    "scanned": int, "matched": int, "last_record": int}
    """
    hostname = pc.get("hostname", "")
    target   = get_wmi_target(pc)
    if not hostname or not target:
        return {"ok": False, "error": "hostname o target WMI mancante"}
    cfg      = get_cfg()
    wmi_user = cfg.get("wmi", {}).get("user", "")
    wmi_pass = get_secret(SECRET_WMI_PASS)
    if not wmi_user or not wmi_pass:
        return {"ok": False, "error": "credenziali WMI non configurate"}

    last_record = _login_db_get_last_record(hostname)

    try:
        import wmi as wmilib
        import pythoncom
        pythoncom.CoInitialize()
        try:
            c = wmilib.WMI(computer=target, user=wmi_user, password=wmi_pass)

            # Limita la finestra alle ultime 24h per evitare scansioni lunghe del log
            since = (datetime.utcnow() - timedelta(hours=24)).strftime("%Y%m%d%H%M%S.000000+000")
            query = (
                "SELECT * FROM Win32_NTLogEvent WHERE Logfile='Security' "
                f"AND TimeGenerated >= '{since}' "
                "AND (EventCode=4624 OR EventCode=4634 OR EventCode=4647)"
            )
            events = list(c.query(query))

            new_events = []
            max_record = last_record
            scanned    = len(events)
            for ev in events:
                try:
                    rec = int(ev.RecordNumber)
                except Exception:
                    continue
                max_record = max(max_record, rec)
                if rec <= last_record:
                    continue

                ins  = ev.InsertionStrings or []
                code = int(ev.EventCode)

                # LogonType interessanti: 2=interattivo (login completo), 7=sblocco schermo
                if code == 4624:      # logon — TargetUserName=ins[5], LogonType=ins[8]
                    username   = ins[5] if len(ins) > 5 else ""
                    logon_type = int(ins[8]) if len(ins) > 8 and str(ins[8]).isdigit() else None
                    if logon_type not in (2, 7):
                        continue
                    event_type = "logon"
                elif code == 4634:    # logoff — TargetUserName=ins[1], LogonType=ins[4]
                    username   = ins[1] if len(ins) > 1 else ""
                    logon_type = int(ins[4]) if len(ins) > 4 and str(ins[4]).isdigit() else None
                    if logon_type not in (2, 7):
                        continue
                    event_type = "logoff"
                elif code == 4647:    # logoff esplicito utente — TargetUserName=ins[1]
                    username   = ins[1] if len(ins) > 1 else ""
                    logon_type = 2
                    event_type = "logoff"
                else:
                    continue

                if not username or username.endswith("$") or username.upper() in _LOGIN_IGNORE_USERS:
                    continue

                ts = parse_wmi_dt(ev.TimeGenerated)
                if not ts:
                    continue

                new_events.append({
                    "username":   username,
                    "event_type": event_type,
                    "timestamp":  ts,
                    "logon_type": logon_type,
                })

            if new_events:
                _login_db_insert_events(hostname, new_events)
            if max_record > last_record:
                _login_db_set_last_record(hostname, max_record)

            _login_db_set_scan_status(hostname, None)
            return {
                "ok": True, "error": None,
                "scanned": scanned, "matched": len(new_events),
                "last_record": max_record,
            }
        finally:
            pythoncom.CoUninitialize()
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
        _login_db_set_scan_status(hostname, error)
        return {"ok": False, "error": error}


# ── Cache dati statici per PC (hostname → dict, svuotata quando il PC va offline) ──
_pc_static_cache      = {}
_pc_static_cache_lock = threading.Lock()


def get_static_wmi(pc: dict) -> dict:
    """
    Dati che non cambiano mai: OS, modello, RAM totale, disco totale+tipo, velocità rete.
    Chiamata una sola volta per PC; il risultato viene cachato fino a quando va offline.
    """
    result = {"os": "", "model": "", "manufacturer": "", "ram_gb": None,
              "disk_total": None, "disk_type": "", "net_speed": None}
    target = get_wmi_target(pc)
    if not target:
        return result
    cfg      = get_cfg()
    wmi_user = cfg.get("wmi", {}).get("user", "")
    wmi_pass = get_secret(SECRET_WMI_PASS)
    # Se le credenziali WMI non sono configurate, salta la query per evitare
    # auth fallite in loop che potrebbero bloccare l'account AD
    if not wmi_user or not wmi_pass:
        return result
    try:
        import wmi as wmilib
        import pythoncom
        pythoncom.CoInitialize()
        try:
            c = wmilib.WMI(computer=target, user=wmi_user, password=wmi_pass)

            try:
                os_objs = c.Win32_OperatingSystem()
                if os_objs:
                    o = os_objs[0]
                    result["os"] = getattr(o, "Caption", "") or ""
                    total = getattr(o, "TotalVisibleMemorySize", None)
                    if total:
                        result["ram_gb"] = round(int(total) / 1048576)
            except Exception:
                pass

            try:
                cs = c.Win32_ComputerSystem()
                if cs:
                    result["model"]        = getattr(cs[0], "Model",        "") or ""
                    result["manufacturer"] = getattr(cs[0], "Manufacturer", "") or ""
            except Exception:
                pass

            try:
                for d in c.Win32_LogicalDisk(DriveType=3):
                    if (d.DeviceID or "").upper().startswith("C"):
                        result["disk_total"] = int(d.Size) if d.Size else None
                        break
            except Exception:
                pass

            # Tipo disco: prova namespace storage, fallback su nome modello
            disk_type = ""
            try:
                stor = wmilib.WMI(computer=target, user=wmi_user, password=wmi_pass,
                                  namespace="root\\microsoft\\windows\\storage")
                for d in stor.MSFT_PhysicalDisk():
                    media = getattr(d, "MediaType", None)
                    if media == 4:
                        disk_type = "SSD"
                    elif media == 3:
                        disk_type = "HDD"
                    if disk_type:
                        break
            except Exception:
                pass
            if not disk_type:
                try:
                    for d in c.Win32_DiskDrive():
                        m = (d.Model or "").upper()
                        disk_type = "SSD" if any(x in m for x in ["SSD", "NVME", "NVM", "SOLID"]) else "HDD"
                        break
                except Exception:
                    pass
            result["disk_type"] = disk_type

            # Velocità connessione: primo adattatore fisico attivo
            try:
                for a in c.Win32_NetworkAdapter():
                    if getattr(a, "PhysicalAdapter", False) and getattr(a, "NetEnabled", False):
                        speed = getattr(a, "Speed", None)
                        if speed:
                            result["net_speed"] = int(speed)
                            break
            except Exception:
                pass

        finally:
            pythoncom.CoUninitialize()
    except Exception:
        pass
    return result


def _ps_err(stderr: str) -> str:
    """Estrae il messaggio leggibile dallo stderr PowerShell (gestisce formato CLIXML)."""
    if not stderr:
        return ""
    s = stderr.strip()
    if s.startswith("#< CLIXML"):
        m = re.search(r'<S S="Error">(.*?)</S>', s, re.DOTALL)
        if m:
            txt = m.group(1)
            txt = re.sub(r'_x[0-9A-Fa-f]{4}_', ' ', txt)
            return txt.strip().splitlines()[0]
        return "Errore PowerShell non decodificabile"
    return s.splitlines()[0]


def _wmi_friendly_error(exc: Exception) -> str:
    """
    Converte le eccezioni WMI/COM in messaggi leggibili.
    I codici HRESULT comuni vengono tradotti; gli altri mostrano solo il tipo.
    """
    s = str(exc)
    _known = {
        "-2147023174": "Server RPC non disponibile (firewall WMI bloccato?)",
        "0x800706ba":  "Server RPC non disponibile (firewall WMI bloccato?)",
        "-2147024891": "Accesso negato — verificare utente/password WMI",
        "0x80070005":  "Accesso negato — verificare utente/password WMI",
        "-2147024893": "Percorso non trovato — WMI non risponde",
        "-2147217405": "Query WMI fallita",
        "-2147023170": "Nessuna risposta dal PC (timeout RPC)",
        "0x800706be":  "Chiamata RPC fallita",
    }
    sl = s.lower()
    for code, msg in _known.items():
        if code in sl:
            return msg
    # Fallback: estrae solo il messaggio tra virgolette singole se presente
    import re as _re
    parts = _re.findall(r"'([^']{4,})'", s)
    readable = next((p for p in parts if not p.startswith("0x") and len(p) > 6), "")
    return readable or f"{type(exc).__name__}: {exc}"


def get_dynamic_wmi(target: str) -> dict:
    """
    Dati che cambiano ad ogni poll: utente loggato, CPU%, RAM%, uptime, spazio disco libero.
    Scopre anche l'IP corrente del PC via Win32_NetworkAdapterConfiguration (aggiornato con DHCP).
    """
    result = {"user": "", "since": None, "cpu": None, "ram_pct": None,
              "uptime": None, "disk_free": None, "ip": "", "mac": "", "wmi_error": ""}
    if not target:
        result["wmi_error"] = "Target non disponibile (hostname/IP mancante)"
        return result
    cfg      = get_cfg()
    wmi_user = cfg.get("wmi", {}).get("user", "")
    wmi_pass = get_secret(SECRET_WMI_PASS)
    # Se le credenziali WMI non sono configurate, salta la query per evitare
    # auth fallite in loop che potrebbero bloccare l'account AD
    if not wmi_user or not wmi_pass:
        result["wmi_error"] = "Credenziali WMI non configurate (Impostazioni → WMI)"
        return result
    try:
        import wmi as wmilib
        import pythoncom
        pythoncom.CoInitialize()
        try:
            c = wmilib.WMI(computer=target, user=wmi_user, password=wmi_pass)

            for proc in c.Win32_Process(Name="explorer.exe"):
                owner = proc.GetOwner()
                if owner[1] == 0 and owner[2]:
                    result["user"]  = owner[2]
                    result["since"] = parse_wmi_dt(proc.CreationDate)
                    break

            try:
                procs = c.Win32_Processor()
                if procs:
                    loads = [p.LoadPercentage for p in procs if p.LoadPercentage is not None]
                    if loads:
                        result["cpu"] = round(sum(loads) / len(loads))
            except Exception:
                pass
            # Fallback: contatori performance (più affidabile di LoadPercentage)
            if result["cpu"] is None:
                try:
                    perf = c.Win32_PerfFormattedData_PerfOS_Processor(Name="_Total")
                    if perf:
                        result["cpu"] = int(perf[0].PercentProcessorTime)
                except Exception:
                    pass

            try:
                os_objs = c.Win32_OperatingSystem()
                if os_objs:
                    o     = os_objs[0]
                    total = getattr(o, "TotalVisibleMemorySize", None)
                    free  = getattr(o, "FreePhysicalMemory", None)
                    if total and free and int(total) > 0:
                        result["ram_pct"] = round((1 - int(free) / int(total)) * 100)
                    result["uptime"] = parse_wmi_dt(getattr(o, "LastBootUpTime", None))
            except Exception:
                pass

            try:
                for d in c.Win32_LogicalDisk(DriveType=3):
                    if (d.DeviceID or "").upper().startswith("C"):
                        result["disk_free"] = int(d.FreeSpace) if d.FreeSpace else None
                        break
            except Exception:
                pass

            # Scopre l'IP e MAC correnti del PC — aggiornati automaticamente ad ogni poll (DHCP)
            try:
                for nic in c.Win32_NetworkAdapterConfiguration(IPEnabled=True):
                    addrs = nic.IPAddress or []
                    for addr in addrs:
                        # IPv4, esclude APIPA (169.254.x.x) e loopback
                        if "." in addr and not addr.startswith("169.254") and addr != "127.0.0.1":
                            result["ip"]  = addr
                            result["mac"] = (nic.MACAddress or "").upper()
                            break
                    if result["ip"]:
                        break
            except Exception:
                pass

        finally:
            pythoncom.CoUninitialize()
    except Exception as e:
        result["wmi_error"] = _wmi_friendly_error(e)
    return result


def check_pc(pc: dict) -> dict:
    """Controlla stato di un PC: ping + WMI dinamico ogni poll, WMI statico una volta sola."""
    target = get_wmi_target(pc)   # hostname (o IP se ancora in config per retrocompatibilità)
    online = ping(target)

    # Alcune NIC (Lenovo e altri) rimangono alimentate in S5 per WOL e rispondono al ping
    # anche a PC spento. Verificiamo la porta 135 (RPC) per confermare che Windows sia attivo.
    if online:
        online = is_os_running(target)

    if not online:
        # Svuota la cache statica: al prossimo avvio verrà riletta
        with _pc_static_cache_lock:
            _pc_static_cache.pop(pc["hostname"], None)
        # Preserva l'ultimo IP scoperto da WMI (dal poll precedente):
        # così il marker resta rosso "offline" invece di grigio "N/D"
        with _cache_lock:
            prev = next((p for p in _pc_cache if p.get("hostname") == pc.get("hostname")), None)
        last_ip = (prev or {}).get("ip", "") or pc.get("ip", "")
        empty = {"user": "", "fullname": "", "since": None, "cpu": None,
                 "ram_pct": None, "uptime": None, "disk_free": None,
                 "os": "", "model": "", "ram_gb": None, "disk_total": None,
                 "disk_type": "", "net_speed": None}
        return {**pc, "ip": last_ip, "online": False, **empty}

    dynamic        = get_dynamic_wmi(target)
    discovered_ip  = dynamic.pop("ip",        "")   # IP scoperto da Win32_NetworkAdapterConfiguration
    discovered_mac = dynamic.pop("mac",       "")   # MAC scoperto da Win32_NetworkAdapterConfiguration
    wmi_error      = dynamic.pop("wmi_error", "")   # errore di connessione WMI (per debug)
    ip_for_result  = discovered_ip or pc.get("ip", "")    # preferisce WMI, fallback config
    mac_for_result = pc.get("mac", "") or discovered_mac  # config ha precedenza, fallback WMI

    fullname = lookup_fullname_ad(dynamic["user"]) if dynamic["user"] else ""

    with _pc_static_cache_lock:
        static = _pc_static_cache.get(pc["hostname"])
    if static is None:
        static = get_static_wmi(pc)   # get_static_wmi usa get_wmi_target internamente
        with _pc_static_cache_lock:
            _pc_static_cache[pc["hostname"]] = static

    return {**pc, "ip": ip_for_result, "mac": mac_for_result, "wmi_error": wmi_error,
            "online": True, **static, **dynamic, "fullname": fullname}


# ── Cache in background ───────────────────────────────────────────────────────
_pc_cache   = []
_cache_lock = threading.Lock()

# Risultati screenshot in attesa (hostname → {token, done, data})
_screenshot_results      = {}
_screenshot_lock         = threading.Lock()
_poll_event = threading.Event()   # segnala al loop di ripartire subito dopo cambio config


def _poll_worker(i, pc, results):
    results[i] = check_pc(pc)


def _poll_loop():
    """Thread daemon: aggiorna la cache ogni poll_interval secondi"""
    while True:
        try:
            cfg     = get_cfg()
            pc_data = cfg.get("pcs", [])
            interval = cfg.get("sede", {}).get("poll_interval", 10)

            results = [None] * len(pc_data)
            threads = [
                threading.Thread(target=_poll_worker, args=(i, pc, results))
                for i, pc in enumerate(pc_data)
            ]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=12)
            for i, pc in enumerate(pc_data):
                if results[i] is None:
                    results[i] = {**pc, "online": False, "user": ""}
            with _cache_lock:
                _pc_cache.clear()
                _pc_cache.extend(results)

            # Auto-save MAC scoperti via WMI per PC che non lo avevano in config
            try:
                cfg_current = get_cfg()
                cfg_map     = {p["hostname"]: p for p in cfg_current.get("pcs", [])}
                mac_changed = False
                for r in results:
                    hn  = r.get("hostname", "")
                    mac = r.get("mac",      "")
                    if hn and mac and hn in cfg_map and not cfg_map[hn].get("mac", ""):
                        cfg_map[hn]["mac"] = mac
                        mac_changed = True
                if mac_changed:
                    cfg_current["pcs"] = list(cfg_map.values())
                    save_config(cfg_current)
                    apply_config(cfg_current)
            except Exception:
                pass

        except Exception:
            pass  # Il loop non deve mai fermarsi

        # Aspetta interval secondi o fino a che la config non viene aggiornata
        _poll_event.clear()
        _poll_event.wait(timeout=interval)


def _login_history_loop():
    """Thread daemon: ogni N minuti (configurabile) legge il Security log dei PC online
    e salva i nuovi eventi di logon/logoff interattivo nel DB cronologia accessi."""
    while True:
        try:
            with _cache_lock:
                online_pcs = [dict(p) for p in _pc_cache if p.get("online")]
            for pc in online_pcs:
                try:
                    scan_login_events(pc)
                except Exception:
                    pass
        except Exception:
            pass  # Il loop non deve mai fermarsi

        cfg     = get_cfg()
        minutes = cfg.get("sede", {}).get("login_history_interval", 30)
        time.sleep(max(int(minutes or 30), 1) * 60)


# Avvia il polling una sola volta
if os.environ.get("WERKZEUG_RUN_MAIN") == "true" or not os.environ.get("WERKZEUG_RUN_MAIN"):
    _login_db_init()
    _bg_thread = threading.Thread(target=_poll_loop, daemon=True, name="poll-loop")
    _bg_thread.start()
    _login_thread = threading.Thread(target=_login_history_loop, daemon=True, name="login-history-loop")
    _login_thread.start()


# ── Endpoint Auth ────────────────────────────────────────────────────────────
@app.route("/api/auth/status")
def auth_status():
    """Indica se l'autenticazione è abilitata — non richiede token"""
    token = get_secret(SECRET_AUTH_TOKEN)
    return jsonify({"auth_enabled": bool(token)})


@app.route("/api/auth/verify", methods=["POST"])
def auth_verify():
    """Verifica un token inviato dal frontend — non richiede token nell'header"""
    token = get_secret(SECRET_AUTH_TOKEN)
    if not token:
        return jsonify({"ok": True})   # auth disabilitata: tutto aperto
    key = (request.get_json(force=True) or {}).get("token", "")
    if key == token:
        return jsonify({"ok": True})
    return jsonify({"ok": False}), 401


# ── Endpoint PC ───────────────────────────────────────────────────────────────
@app.route("/api/pcs", methods=["GET"])
@require_auth
def get_pcs():
    """Restituisce la cache aggiornata in background — risposta istantanea"""
    with _cache_lock:
        return jsonify(list(_pc_cache))


@app.route("/api/wol/<hostname>", methods=["POST"])
@require_auth
def wake_on_lan(hostname: str):
    """Invia magic packet WOL"""
    cfg = get_cfg()
    pc  = next((p for p in cfg.get("pcs", []) if p["hostname"] == hostname), None)
    if not pc:
        return jsonify({"error": "PC non trovato"}), 404
    if not pc.get("mac"):
        return jsonify({"error": "MAC address non disponibile"}), 400
    try:
        send_wol(pc["mac"])
        return jsonify({"ok": True, "hostname": hostname, "mac": pc["mac"]})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/shutdown/<hostname>", methods=["POST"])
@require_auth
def shutdown_pc(hostname: str):
    """Spegne il PC remoto tramite WMI (Win32Shutdown flag=12 = force power off)"""
    cfg = get_cfg()
    pc  = next((p for p in cfg.get("pcs", []) if p["hostname"] == hostname), None)
    if not pc:
        return jsonify({"error": "PC non trovato"}), 404
    target = get_wmi_target(pc)
    if not target:
        return jsonify({"error": "Hostname non configurato"}), 400
    wmi_user = cfg.get("wmi", {}).get("user", "")
    wmi_pass = get_secret(SECRET_WMI_PASS)
    if not wmi_user or not wmi_pass:
        return jsonify({"error": "Credenziali WMI non configurate"}), 400
    try:
        import wmi
        import pythoncom
        pythoncom.CoInitialize()
        try:
            c = wmi.WMI(computer=target, user=wmi_user, password=wmi_pass)
            for os_obj in c.Win32_OperatingSystem():
                os_obj.Win32Shutdown(12)  # 12 = force power off
        finally:
            pythoncom.CoUninitialize()
        return jsonify({"ok": True, "hostname": hostname})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/rdp/<hostname>", methods=["GET"])
@require_auth
def rdp_file(hostname: str):
    """Genera e restituisce un file .rdp per aprire Remote Desktop sul PC indicato."""
    cfg = get_cfg()
    pc  = next((p for p in cfg.get("pcs", []) if p["hostname"] == hostname), None)
    if not pc:
        return jsonify({"error": "PC non trovato"}), 404
    # Cerca l'IP scoperto via WMI nel poll precedente
    with _cache_lock:
        cached = next((p for p in _pc_cache if p.get("hostname") == hostname), None)
    ip = (cached or {}).get("ip", "") or pc.get("ip", "")
    if not ip:
        return jsonify({"error": "IP non ancora scoperto — attendere il prossimo poll o assicurarsi che il PC sia online"}), 400
    content = (
        f"full address:s:{ip}\r\n"
        f"prompt for credentials:i:1\r\n"
        f"administrative session:i:1\r\n"
    )
    return Response(
        content,
        mimetype="application/rdp",
        headers={"Content-Disposition": f'attachment; filename="{hostname}.rdp"'}
    )

@app.route("/api/shadow/<hostname>", methods=["POST"])
@require_auth
def shadow_rdp(hostname: str):
    """Avvia mstsc /shadow sulla sessione attiva del PC remoto, lanciandolo
    nella sessione interattiva locale tramite Task Scheduler."""
    cfg  = get_cfg()
    pc   = next((p for p in cfg.get("pcs", []) if p["hostname"] == hostname), None)
    if not pc:
        return jsonify({"error": "PC non trovato"}), 404

    with _cache_lock:
        cached = next((p for p in _pc_cache if p.get("hostname") == hostname), None)
    target = (cached or {}).get("ip", "") or pc.get("ip", "") or get_wmi_target(pc)
    if not target:
        return jsonify({"error": "IP non disponibile"}), 400

    consent = request.get_json(silent=True, force=True) or {}
    consent = bool(consent.get("consent", True))

    # Trova la sessione attiva sul PC remoto
    # Il servizio gira come SYSTEM (senza credenziali di rete): usa net use per
    # autenticarsi prima con le credenziali WMI, poi esegue qwinsta /server
    wmi_user = cfg.get("wmi", {}).get("user", "")
    wmi_pass = get_secret(SECRET_WMI_PASS)
    # Usa hostname per qwinsta (Kerberos); l'IP forza NTLM che può essere bloccato
    ipc = f"\\\\{hostname}\\IPC$"
    try:
        subprocess.run(
            ["net", "use", ipc, f"/user:{wmi_user}", wmi_pass],
            capture_output=True, timeout=10,
            creationflags=subprocess.CREATE_NO_WINDOW
        )
        qw = subprocess.run(
            ["qwinsta", f"/server:{hostname}"],
            capture_output=True, text=True, timeout=10,
            creationflags=subprocess.CREATE_NO_WINDOW
        )
        # Parole chiave per "sessione attiva" nelle varie lingue di Windows
        _ACTIVE_STATES = {"active", "attivo", "actif", "aktiv"}
        session_id = None
        for line in qw.stdout.splitlines():
            parts = line.split()
            for i, part in enumerate(parts):
                if part.lower() in _ACTIVE_STATES and i > 0:
                    candidate = parts[i - 1]
                    if candidate.isdigit():
                        session_id = candidate
                        break
            if session_id:
                break
        if not session_id:
            # Fallback: su workstation Windows la sessione console è quasi sempre ID 1
            session_id = "1"
    except Exception:
        session_id = "1"
    finally:
        subprocess.run(["net", "use", f"\\\\{hostname}\\IPC$", "/delete"],
                       capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)

    # Lancia mstsc nella sessione interattiva locale via Task Scheduler
    # Nota: la policy Shadow=2 (senza consenso) deve essere configurata manualmente
    # via Group Policy sul PC remoto: Computer Config → Admin Templates →
    # Windows Components → Remote Desktop Services → Remote Session Environment →
    # "Set rules for remote control" → "Full Control without user's permission"
    try:
        import win32com.client
        cmd_args = f"/shadow:{session_id} /v:{target} /control"
        if not consent:
            cmd_args += " /noConsentPrompt"

        sched    = win32com.client.Dispatch("Schedule.Service")
        sched.Connect()
        folder   = sched.GetFolder("\\")
        task_def = sched.NewTask(0)
        task_def.Settings.Hidden = False
        task_def.Principal.LogonType = 3   # TASK_LOGON_INTERACTIVE_TOKEN

        act           = task_def.Actions.Create(0)   # TASK_ACTION_EXEC
        act.Path      = "mstsc.exe"
        act.Arguments = cmd_args

        folder.RegisterTaskDefinition(
            "PcMonitorShadow", task_def, 6, None, None, 0
        )
        folder.GetTask("\\PcMonitorShadow").Run(None)
    except Exception as exc:
        return jsonify({"error": f"Impossibile avviare mstsc: {exc}"}), 500

    return jsonify({"ok": True})


@app.route("/api/processes/<hostname>")
@require_auth
def get_processes(hostname: str):
    """Restituisce i top 15 processi per CPU tramite WMI (Win32_PerfFormattedData_PerfProc_Process)."""
    cfg      = get_cfg()
    pc       = next((p for p in cfg.get("pcs", []) if p["hostname"] == hostname), None)
    if not pc:
        return jsonify({"error": "PC non trovato"}), 404
    target   = get_wmi_target(pc)
    wmi_user = cfg.get("wmi", {}).get("user", "")
    wmi_pass = get_secret(SECRET_WMI_PASS)
    if not wmi_user or not wmi_pass:
        return jsonify({"error": "Credenziali WMI non configurate"}), 400
    try:
        import wmi as wmilib
        import pythoncom
        pythoncom.CoInitialize()
        try:
            c = wmilib.WMI(computer=target, user=wmi_user, password=wmi_pass)
            result = []

            # Prova prima con Win32_PerfFormattedData (ha CPU%) — non disponibile su tutti i sistemi
            use_fallback = False
            try:
                procs = c.Win32_PerfFormattedData_PerfProc_Process()
                for p in procs:
                    name = p.Name or ""
                    if name in ("_Total", "Idle", ""):
                        continue
                    result.append({
                        "name": name,
                        "pid":  int(p.IDProcess or 0),
                        "cpu":  int(p.PercentProcessorTime or 0),
                        "mem":  round(int(p.WorkingSetPrivate or 0) / 1048576, 1),
                    })
            except (Exception, AttributeError) as perf_err:
                app.logger.warning("Win32_PerfFormattedData non disponibile su %s (%s: %s) — fallback Win32_Process",
                                   hostname, type(perf_err).__name__, perf_err)
                use_fallback = True

            if use_fallback:
                # Fallback: Win32_Process — universale, ma senza CPU% in tempo reale
                result = []
                procs = c.Win32_Process()
                for p in procs:
                    name = p.Name or ""
                    if name in ("", "System Idle Process"):
                        continue
                    result.append({
                        "name": name,
                        "pid":  int(p.ProcessId or 0),
                        "cpu":  0,
                        "mem":  round(int(p.WorkingSetSize or 0) / 1048576, 1),
                    })

            result.sort(key=lambda x: (x["cpu"], x["mem"]), reverse=True)
            cpu_available = any(p["cpu"] > 0 for p in result)
            return jsonify({"processes": result[:15], "cpu_available": cpu_available})
        finally:
            pythoncom.CoUninitialize()
    except Exception as e:
        return jsonify({"error": _wmi_friendly_error(e)}), 500


@app.route("/api/login-history/<hostname>")
@require_auth
def get_login_history(hostname: str):
    """Restituisce la cronologia login/logout (interattivi) salvata per questo PC."""
    cfg = get_cfg()
    pc  = next((p for p in cfg.get("pcs", []) if p["hostname"] == hostname), None)
    if not pc:
        return jsonify({"error": "PC non trovato"}), 404
    limit = request.args.get("limit", 100, type=int)
    return jsonify({
        "events": _login_db_get_history(hostname, limit),
        "scan_status": _login_db_get_scan_status(hostname),
    })


@app.route("/api/login-history/<hostname>/scan", methods=["POST"])
@require_auth
def force_login_history_scan(hostname: str):
    """Forza una scansione immediata del Security log per questo PC (debug/test)."""
    cfg = get_cfg()
    pc  = next((p for p in cfg.get("pcs", []) if p["hostname"] == hostname), None)
    if not pc:
        return jsonify({"error": "PC non trovato"}), 404
    result = scan_login_events(pc)
    return jsonify(result)


@app.route("/api/kill-process/<hostname>/<int:pid>", methods=["POST"])
@require_auth
def kill_process(hostname: str, pid: int):
    """Termina un processo sul PC remoto tramite WMI (Win32_Process.Terminate)."""
    cfg      = get_cfg()
    pc       = next((p for p in cfg.get("pcs", []) if p["hostname"] == hostname), None)
    if not pc:
        return jsonify({"error": "PC non trovato"}), 404
    target   = get_wmi_target(pc)
    wmi_user = cfg.get("wmi", {}).get("user", "")
    wmi_pass = get_secret(SECRET_WMI_PASS)
    if not wmi_user or not wmi_pass:
        return jsonify({"error": "Credenziali WMI non configurate"}), 400
    try:
        import wmi as wmilib
        import pythoncom
        pythoncom.CoInitialize()
        try:
            c = wmilib.WMI(computer=target, user=wmi_user, password=wmi_pass)
            procs = c.Win32_Process(ProcessId=pid)
            if not procs:
                return jsonify({"error": f"Processo {pid} non trovato"}), 404
            procs[0].Terminate()
            return jsonify({"ok": True, "pid": pid})
        finally:
            pythoncom.CoUninitialize()
    except Exception as e:
        return jsonify({"error": _wmi_friendly_error(e)}), 500


@app.route("/api/screenshot-receive", methods=["POST"])
def screenshot_receive():
    """
    Endpoint chiamato dal PC remoto per consegnare lo screenshot catturato.
    Non richiede auth: è chiamato internamente dal PC, protetto da token one-time.
    """
    data  = request.get_json(force=True) or {}
    token = data.get("token", "")
    b64   = data.get("data",  "")
    if not token or not b64:
        return jsonify({"ok": False}), 400
    with _screenshot_lock:
        for entry in _screenshot_results.values():
            if entry.get("token") == token and not entry.get("done"):
                entry["data"] = b64
                entry["done"] = True
                break
    return jsonify({"ok": True})


@app.route("/api/screenshot/<hostname>")
@require_auth
def get_screenshot(hostname: str):
    """
    Cattura lo schermo del PC remoto via Schedule.Service COM.
    Nessun WinRM, nessun Win32_Process.Create.

    Vincolo principale: l'EDR (Bitdefender ATC) decodifica -EncodedCommand
    via AMSI e blocca qualunque pattern che somigli a un dropper multi-stadio
    — sia "scarica ed esegui in memoria" (DownloadString | iex) sia "scrivi
    su disco un lanciatore .vbs che richiama un altro comando PowerShell
    codificato" (la tecnica wscript.exe + WshShell.Run(...,0,False) che
    garantirebbe finestra zero, ma è strutturalmente identica a un dropper
    e viene bloccata indipendentemente da come gira il task).

    L'unico schema che supera l'EDR è l'esecuzione diretta e autonoma dello
    script — al prezzo di un breve lampeggio della console PowerShell
    (-WindowStyle Hidden nasconde la finestra ma non evita il primo frame).

    Flusso:
      1. WMI trova l'utente loggato (explorer.exe)
      2. Python si connette al Task Scheduler remoto via Schedule.Service.Connect
         usando le credenziali WMI
      3. Crea un task InteractiveToken con lo script di cattura incorporato
         (-EncodedCommand): nessun file su disco, nessuna richiesta HTTP
         all'avvio
      4. Lo script posta il JPEG a /api/screenshot-receive
    """
    import base64 as _b64
    import secrets as _sec

    cfg      = get_cfg()
    pc       = next((p for p in cfg.get("pcs", []) if p["hostname"] == hostname), None)
    if not pc:
        return jsonify({"error": "PC non trovato"}), 404
    target   = get_wmi_target(pc)
    wmi_user = cfg.get("wmi", {}).get("user", "")
    wmi_pass = get_secret(SECRET_WMI_PASS)
    if not wmi_user or not wmi_pass:
        return jsonify({"error": "Credenziali WMI non configurate"}), 400

    gateway   = cfg.get("network", {}).get("gateway_ip", "")
    server_ip = get_local_ip(gateway) if gateway else ""
    if not server_ip or server_ip == "0.0.0.0":
        return jsonify({"error": "IP server non determinabile (configura gateway_ip)"}), 500
    server_url = f"http://{server_ip}:5000/api/screenshot-receive"

    token = _sec.token_hex(16)
    with _screenshot_lock:
        _screenshot_results[hostname] = {"token": token, "done": False, "data": None}

    # ------------------------------------------------------------------
    # 1. Script di cattura: gira nella sessione interattiva dell'utente,
    #    cattura lo schermo e posta il JPEG via HTTP all'app server.
    #    -EncodedCommand vuole UTF-16LE in Base64: viaggia incorporato
    #    nell'azione del task, senza alcuna richiesta HTTP al momento
    #    dell'esecuzione (niente "download cradle" che fa scattare l'EDR).
    # ------------------------------------------------------------------
    inner_lines = [
        f"$url   = '{server_url}'",
        f"$token = '{token}'",
        "try {",
        "    Add-Type -AssemblyName System.Windows.Forms",
        "    Add-Type -AssemblyName System.Drawing",
        "    $s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
        "    $b = New-Object System.Drawing.Bitmap($s.Width, $s.Height)",
        "    $g = [System.Drawing.Graphics]::FromImage($b)",
        "    $g.CopyFromScreen($s.Location, [System.Drawing.Point]::Empty, $s.Size)",
        "    $m = New-Object System.IO.MemoryStream",
        "    $b.Save($m, [System.Drawing.Imaging.ImageFormat]::Jpeg)",
        '    $b64  = [Convert]::ToBase64String($m.ToArray())',
        '    $body = "{""token"":""$token"",""data"":""$b64""}"',
        "    $req  = [System.Net.WebRequest]::Create($url)",
        "    $req.Method      = 'POST'",
        "    $req.ContentType = 'application/json'",
        "    $req.Proxy       = New-Object System.Net.WebProxy",
        "    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)",
        "    $req.ContentLength = $bytes.Length",
        "    $stream = $req.GetRequestStream()",
        "    $stream.Write($bytes, 0, $bytes.Length)",
        "    $stream.Close()",
        "    $req.GetResponse().Close()",
        "} catch {}",
    ]
    inner_script  = "\n".join(inner_lines)
    inner_encoded = _b64.b64encode(inner_script.encode("utf-16-le")).decode("ascii")

    # NB: la tecnica "wscript.exe + lanciatore .vbs con WshShell.Run(...,0,False)"
    # garantirebbe zero finestre visibili (SW_HIDE reale a livello Win32), ma
    # richiede scrivere su disco uno script che racchiude un altro comando
    # PowerShell codificato — pattern strutturalmente identico a un dropper
    # multi-stadio. Bitdefender ATC lo blocca sempre (decodifica -EncodedCommand
    # via AMSI e analizza il contenuto), indipendentemente da come viene lanciato
    # il task. Si resta quindi sull'esecuzione diretta — un breve lampeggio della
    # console è il compromesso minimo che supera l'EDR.

    # Separa dominio e utente WMI (es. STAGIT\user → domain=STAGIT, user=user)
    if "\\" in wmi_user:
        wmi_domain, wmi_user_only = wmi_user.split("\\", 1)
    else:
        wmi_domain, wmi_user_only = "", wmi_user

    task_name = None
    try:
        import wmi as wmilib, pythoncom, win32com.client
        pythoncom.CoInitialize()
        try:
            # Trova utente loggato tramite WMI
            c = wmilib.WMI(computer=target, user=wmi_user, password=wmi_pass)
            logged_user = ""
            for proc in c.Win32_Process(Name="explorer.exe"):
                owner = proc.GetOwner()
                if owner[1] == 0 and owner[2]:
                    dom = owner[0] or ""
                    logged_user = f"{dom}\\{owner[2]}" if dom else owner[2]
                    break
            if not logged_user:
                return jsonify({"error": "Nessun utente loggato sul PC"}), 400

            # Connessione diretta al Task Scheduler remoto con credenziali WMI.
            # Ogni chiamata COM è isolata in un proprio try/except: l'eccezione
            # generica di pywin32 non indica il punto di fallimento, quindi la
            # ripacchettiamo con un prefisso che identifica lo step (utile per
            # distinguere "non riesco a connettermi" da "non ho i permessi per
            # registrare il task", es. utente WMI senza diritti di admin locale).
            def _step(name, fn):
                try:
                    return fn()
                except Exception as step_exc:
                    raise RuntimeError(f"Schedule.Service [{name}]: {step_exc}") from step_exc

            sched  = _step("Dispatch", lambda: win32com.client.Dispatch("Schedule.Service"))
            _step("Connect", lambda: sched.Connect(target, wmi_user_only, wmi_domain, wmi_pass))
            folder = _step("GetFolder", lambda: sched.GetFolder("\\"))

            # Task che esegue lo script di cattura incorporato (-EncodedCommand):
            # nessun file scritto su disco, nessuna richiesta HTTP all'avvio —
            # il minimo indispensabile che Bitdefender lascia passare.
            rnd        = _sec.token_hex(6)
            task_name  = f"PcMonSS_{rnd}"
            task_def   = _step("NewTask", lambda: sched.NewTask(0))
            task_def.Settings.Hidden     = True
            task_def.Principal.UserId    = logged_user
            task_def.Principal.LogonType = 3   # TASK_LOGON_INTERACTIVE_TOKEN
            task_def.Principal.RunLevel  = 0   # TASK_RUNLEVEL_LUA
            act = task_def.Actions.Create(0)   # TASK_ACTION_EXEC
            act.Path      = "powershell.exe"
            act.Arguments = (
                f"-NoProfile -NonInteractive -WindowStyle Hidden "
                f"-EncodedCommand {inner_encoded}"
            )
            _step("RegisterTaskDefinition",
                  lambda: folder.RegisterTaskDefinition(task_name, task_def, 6, None, None, 3))
            task = _step("GetTask", lambda: folder.GetTask(f"\\{task_name}"))
            _step("Run", lambda: task.Run(None))
        finally:
            pythoncom.CoUninitialize()

        # Attende lo screenshot (max 30s)
        deadline = time.time() + 30
        while time.time() < deadline:
            time.sleep(0.5)
            with _screenshot_lock:
                entry = _screenshot_results.get(hostname, {})
                if entry.get("done") and entry.get("data"):
                    b64_data = entry.pop("data")
                    _screenshot_results.pop(hostname, None)
                    break
        else:
            with _screenshot_lock:
                _screenshot_results.pop(hostname, None)
            return jsonify({"error": "Timeout: screenshot non ricevuto in 30s"}), 500

        img_bytes = _b64.b64decode(b64_data)
        return Response(img_bytes, mimetype="image/jpeg")

    except Exception as e:
        with _screenshot_lock:
            _screenshot_results.pop(hostname, None)
        return jsonify({"error": str(e)}), 500

    finally:
        # Elimina il task schedulato in background
        if task_name:
            def _cleanup(tn=task_name):
                try:
                    import pythoncom, win32com.client as _wcc
                    pythoncom.CoInitialize()
                    s = _wcc.Dispatch("Schedule.Service")
                    s.Connect(target, wmi_user_only, wmi_domain, wmi_pass)
                    s.GetFolder("\\").DeleteTask(tn, 0)
                    pythoncom.CoUninitialize()
                except Exception:
                    pass
            threading.Thread(target=_cleanup, daemon=True).start()



@app.route("/api/ping/<hostname>", methods=["GET"])
@require_auth
def ping_single(hostname: str):
    """Ping rapido su un singolo PC"""
    cfg = get_cfg()
    pc  = next((p for p in cfg.get("pcs", []) if p["hostname"] == hostname), None)
    if not pc:
        return jsonify({"error": "PC non trovato"}), 404
    target = get_wmi_target(pc)
    online = ping(target)
    return jsonify({"hostname": hostname, "online": online, "ip": target})


@app.route("/api/ad/computers")
@require_auth
def ad_computers():
    """
    Restituisce la lista dei computer presenti in Active Directory.
    Strategia 1: Get-ADComputer con -Server e -Credential (RSAT, funziona anche da PC non-dominio).
    Strategia 2: System.DirectoryServices.DirectoryEntry con LDAP esplicito + credenziali.
    Entrambe usano dc_ip e le credenziali WMI dalla config.
    """
    import base64

    cfg      = get_cfg()
    dc_ip    = cfg.get("network", {}).get("dc_ip", "")
    wmi_user = cfg.get("wmi", {}).get("user", "")
    wmi_pass = get_secret(SECRET_WMI_PASS)

    if not dc_ip:
        return jsonify({
            "error": "IP Domain Controller non configurato (Impostazioni → Rete → IP Domain Controller)",
            "computers": []
        })

    # Le credenziali sono opzionali: se disponibili vengono passate esplicitamente,
    # altrimenti PowerShell usa l'identità Windows corrente del processo
    # (funziona su AD04/AD03 dove il servizio gira come account di dominio).
    use_creds = bool(wmi_user and wmi_pass)

    def _esc(s):
        """Escape single quotes per stringhe letterali PowerShell."""
        return (s or "").replace("'", "''")


    def _run_ps(script: str):
        """Esegue uno script PowerShell via EncodedCommand (evita problemi di escaping)."""
        enc = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
        return subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", enc],
            capture_output=True, text=True, timeout=30
        )

    try:
        # Strategia 1: Get-ADComputer (con credenziali esplicite se disponibili)
        if use_creds:
            ps1 = (
                f"$pass = ConvertTo-SecureString '{_esc(wmi_pass)}' -AsPlainText -Force\n"
                f"$cred = New-Object PSCredential('{_esc(wmi_user)}', $pass)\n"
                f"Get-ADComputer -Filter * -Server '{_esc(dc_ip)}' -Credential $cred -Properties Name "
                f"| Select-Object -ExpandProperty Name | Sort-Object"
            )
        else:
            ps1 = (
                f"Get-ADComputer -Filter * -Server '{_esc(dc_ip)}' -Properties Name "
                f"| Select-Object -ExpandProperty Name | Sort-Object"
            )
        r1 = _run_ps(ps1)
        if r1.returncode == 0 and r1.stdout.strip():
            names = [n.strip() for n in r1.stdout.splitlines() if n.strip()]
        else:
            # Strategia 2: DirectoryEntry LDAP (con o senza credenziali esplicite)
            if use_creds:
                ps2 = (
                    f"$de = New-Object System.DirectoryServices.DirectoryEntry(\n"
                    f"  'LDAP://{_esc(dc_ip)}', '{_esc(wmi_user)}', '{_esc(wmi_pass)}')\n"
                )
            else:
                ps2 = f"$de = New-Object System.DirectoryServices.DirectoryEntry('LDAP://{_esc(dc_ip)}')\n"
            ps2 += (
                f"$s  = New-Object System.DirectoryServices.DirectorySearcher($de)\n"
                f"$s.Filter    = '(&(objectClass=computer))'\n"
                f"$s.SizeLimit = 1000\n"
                f"$s.PropertiesToLoad.Add('name') | Out-Null\n"
                f"$s.FindAll() | ForEach-Object {{ $_.Properties['name'][0] }} | Sort-Object"
            )
            r2 = _run_ps(ps2)
            if r2.returncode != 0 or not r2.stdout.strip():
                err = _ps_err(r2.stderr) or _ps_err(r1.stderr) or "Nessun risultato da AD"
                return jsonify({"error": err, "computers": []})
            names = [n.strip() for n in r2.stdout.splitlines() if n.strip()]

        # Filtra i computer già presenti in config
        existing  = {p["hostname"].upper() for p in cfg.get("pcs", [])}
        computers = [n for n in names if n.upper() not in existing]
        return jsonify({"computers": sorted(computers)})

    except Exception as e:
        return jsonify({"error": str(e), "computers": []})


# ── Endpoint Config ───────────────────────────────────────────────────────────
@app.route("/api/config", methods=["GET"])
@require_auth
def get_config():
    """Ritorna la config corrente — password e auth token mascherati"""
    cfg  = get_cfg()
    safe = json_lib.loads(json_lib.dumps(cfg))   # deep copy
    # Mostra *** se il segreto è impostato nel Registry, "" altrimenti
    safe.setdefault("wmi",  {})["pass"]  = "***" if get_secret(SECRET_WMI_PASS)   else ""
    safe.setdefault("auth", {})["token"] = "***" if get_secret(SECRET_AUTH_TOKEN) else ""
    return jsonify(safe)


@app.route("/api/config", methods=["POST"])
@require_auth
def post_config():
    """
    Salva e applica una nuova config.
    I segreti (wmi.pass, auth.token) vengono scritti nel Registry e rimossi dal JSON.
    Se il valore è "***" (placeholder frontend) il segreto esistente non viene modificato.
    Riavvia il ciclo di polling immediatamente.
    """
    data = request.get_json(force=True)
    if not data:
        return jsonify({"error": "JSON non valido"}), 400

    # Segreti → Registry; azzerali nel file solo se la scrittura è riuscita
    wmi_pass = data.get("wmi", {}).get("pass", "")
    if wmi_pass != "***":       # "***" = mantieni segreto esistente
        if set_secret(SECRET_WMI_PASS, wmi_pass) or not wmi_pass:
            data.setdefault("wmi", {})["pass"] = ""   # rimosso dal file
        # se set_secret fallisce e la password non è vuota: la lascia in config.json
        # come fallback (get_secret() la troverà lì finché il Registry non è disponibile)
    else:
        data.setdefault("wmi", {})["pass"] = ""

    auth_token = data.get("auth", {}).get("token", "")
    if auth_token != "***":
        if set_secret(SECRET_AUTH_TOKEN, auth_token) or not auth_token:
            data.setdefault("auth", {})["token"] = ""
    else:
        data.setdefault("auth", {})["token"] = ""

    save_config(data)
    apply_config(data)
    with _pc_static_cache_lock:
        _pc_static_cache.clear()
    with _fullname_cache_lock:
        _fullname_cache.clear()

    # Aggiorna _pc_cache immediatamente: rimuove PC eliminati, aggiunge nuovi come offline.
    # Così il frontend vede i cambiamenti entro 1.2s senza aspettare il ciclo di polling.
    new_hostnames = {pc["hostname"] for pc in data.get("pcs", []) if pc.get("hostname")}
    offline_template = {
        "online": False, "user": "", "fullname": "", "since": None,
        "cpu": None, "ram_pct": None, "uptime": None, "disk_free": None,
        "os": "", "model": "", "manufacturer": "", "ram_gb": None,
        "disk_total": None, "disk_type": "", "net_speed": None
    }
    with _cache_lock:
        _pc_cache[:] = [p for p in _pc_cache if p.get("hostname") in new_hostnames]
        cached_hostnames = {p.get("hostname") for p in _pc_cache}
        for pc in data.get("pcs", []):
            hn = pc.get("hostname")
            if hn and hn not in cached_hostnames:
                _pc_cache.append({**pc, **offline_template})

    _poll_event.set()
    return jsonify({"ok": True})


@app.route("/api/config/test-wmi", methods=["POST"])
@require_auth
def test_wmi():
    """
    Testa le credenziali WMI su un IP specifico.
    Body: {"ip": "192.168.x.x", "user": "...", "pass": "..."}
    """
    data     = request.get_json(force=True) or {}
    ip       = data.get("ip", "")
    wmi_user = data.get("user", "")
    # Ignora "***" (placeholder) e usa sempre il segreto dal Registry
    raw_pass = data.get("pass", "")
    wmi_pass = get_secret(SECRET_WMI_PASS) if raw_pass == "***" or not raw_pass else raw_pass

    if not ip:
        return jsonify({"error": "IP mancante"}), 400
    try:
        import wmi
        import pythoncom
        pythoncom.CoInitialize()
        try:
            c    = wmi.WMI(computer=ip, user=wmi_user, password=wmi_pass)
            info = c.Win32_ComputerSystem()[0]
            return jsonify({"ok": True, "hostname": info.Name})
        finally:
            pythoncom.CoUninitialize()
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 200


# ── Endpoint Piantina ─────────────────────────────────────────────────────────
@app.route("/api/floorplan")
def get_floorplan():
    """Serve l'immagine della piantina"""
    return send_file(FLOORPLAN_PATH, mimetype="image/png")


@app.route("/api/floorplan/upload", methods=["POST"])
@require_auth
def upload_floorplan():
    """
    Carica una nuova immagine piantina (jpg/png).
    La salva come piantina.png sovrascrivendo quella esistente.
    """
    if "file" not in request.files:
        return jsonify({"error": "Nessun file"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "Nome file vuoto"}), 400
    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in (".png", ".jpg", ".jpeg"):
        return jsonify({"error": "Solo PNG o JPG supportati"}), 400
    try:
        f.save(FLOORPLAN_PATH)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Endpoint Posizioni ────────────────────────────────────────────────────────
@app.route("/api/positions", methods=["GET"])
@require_auth
def get_positions():
    """Legge le posizioni salvate dei PC sulla piantina"""
    if os.path.exists(POSITIONS_FILE):
        with open(POSITIONS_FILE, encoding="utf-8-sig") as f:  # utf-8-sig rimuove BOM se presente
            return jsonify(json_lib.load(f))
    return jsonify({})


@app.route("/api/positions", methods=["POST"])
@require_auth
def save_positions():
    """Salva le posizioni dei PC sulla piantina"""
    data = request.get_json()
    with open(POSITIONS_FILE, "w", encoding="utf-8") as f:
        json_lib.dump(data, f, indent=2)
    return jsonify({"ok": True})


# ── Endpoint Aggiornamenti ────────────────────────────────────────────────────
def _read_version() -> str:
    try:
        with open(VERSION_FILE, encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return "0.0.0"


def _normalize_version(tag: str) -> str:
    """Rimuove il prefisso 'v' dal tag GitHub (es. 'v1.2.0' → '1.2.0')"""
    return tag.lstrip("v")


@app.route("/api/update/check")
def update_check():
    """Confronta la versione locale con l'ultima GitHub Release"""
    current = _read_version()
    try:
        url = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
        req = urllib.request.Request(url, headers={"User-Agent": "pc-monitor"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json_lib.loads(resp.read())
        latest     = _normalize_version(data.get("tag_name", "0.0.0"))
        notes      = data.get("body", "")
        zipball    = data.get("zipball_url", "")
        available  = latest != current
        return jsonify({
            "current":          current,
            "latest":           latest,
            "update_available": available,
            "release_notes":    notes,
            "zipball_url":      zipball,
        })
    except Exception as e:
        return jsonify({"current": current, "latest": None,
                        "update_available": False, "error": str(e)})


@app.route("/api/update/apply", methods=["POST"])
@require_auth
def update_apply():
    """Scarica l'ultima release, aggiorna i file e riavvia il servizio"""
    try:
        # 1. Recupera URL zip
        url = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
        req = urllib.request.Request(url, headers={"User-Agent": "pc-monitor"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json_lib.loads(resp.read())
        zipball = data.get("zipball_url", "")
        new_ver = _normalize_version(data.get("tag_name", "0.0.0"))
        if not zipball:
            return jsonify({"error": "zipball_url non trovato"}), 500

        # 2. Scarica zip in cartella temp
        tmp_dir = tempfile.mkdtemp(prefix="pcmonitor_update_")
        zip_path = os.path.join(tmp_dir, "release.zip")
        req2 = urllib.request.Request(zipball, headers={"User-Agent": "pc-monitor"})
        with urllib.request.urlopen(req2, timeout=60) as resp2:
            with open(zip_path, "wb") as f:
                f.write(resp2.read())

        # 3. Estrai
        extract_dir = os.path.join(tmp_dir, "extracted")
        with zipfile.ZipFile(zip_path, "r") as z:
            z.extractall(extract_dir)

        # La root dello zip GitHub ha una cartella con nome owner-repo-hash
        inner = next(
            (os.path.join(extract_dir, d) for d in os.listdir(extract_dir)
             if os.path.isdir(os.path.join(extract_dir, d))),
            extract_dir
        )

        # 4. Genera script PowerShell: ferma servizio, copia file, riavvia.
        install_root = os.path.normpath(os.path.join(BASE_DIR, ".."))
        version_file = os.path.normpath(VERSION_FILE)
        # NOTA: virgole obbligatorie nell'array PowerShell
        preserve_str = ", ".join(f"'{p}'" for p in PRESERVE_ON_UPDATE)
        log_path     = os.path.join(install_root, "logs", "update.log")
        ps_script = f"""
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference    = 'SilentlyContinue'
function Log($m) {{ Add-Content '{log_path}' "$(Get-Date -f 'HH:mm:ss') $m" }}
Log "=== Update avviato -> v{new_ver} ==="

Start-Sleep 5
Stop-Service '{SERVICE_NAME}' -Force
Log "Servizio fermato"
Start-Sleep 5

$inner    = '{inner}'
$destRoot = '{install_root}'
$preserve = @({preserve_str})
$n = 0

Get-ChildItem -Path $inner -Recurse -File | ForEach-Object {{
    if ($preserve -contains $_.Name) {{ Log "SKIP: $($_.Name)"; return }}
    $rel  = $_.FullName.Substring($inner.Length).TrimStart('\\')
    $dest = Join-Path $destRoot $rel
    $dir  = Split-Path $dest -Parent
    if (-not (Test-Path $dir)) {{ New-Item -ItemType Directory -Force $dir | Out-Null }}
    Copy-Item $_.FullName $dest -Force
    $n++
}}
Log "Copiati $n file"

[System.IO.File]::WriteAllText('{version_file}', '{new_ver}')
Log "version.txt aggiornato"

Start-Service '{SERVICE_NAME}'
Log "=== Update completato ==="

Unregister-ScheduledTask -TaskName 'PcMonitorUpdate' -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item '{tmp_dir}' -Recurse -Force -ErrorAction SilentlyContinue
"""
        ps_path = os.path.join(tmp_dir, "do_update.ps1")
        with open(ps_path, "w", encoding="utf-8") as f:
            f.write(ps_script)

        # 5. Registra un Scheduled Task come SYSTEM e avvialo subito.
        #    Cosi' lo script sopravvive allo stop del servizio (NSSM non puo' killarlo).
        from datetime import datetime, timedelta
        run_at   = (datetime.now() + timedelta(minutes=5)).strftime("%H:%M")
        task_cmd = f'powershell.exe -NonInteractive -ExecutionPolicy Bypass -File "{ps_path}"'
        subprocess.run(["schtasks", "/delete", "/tn", "PcMonitorUpdate", "/f"],
                       capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        subprocess.run(["schtasks", "/create",
                        "/tn", "PcMonitorUpdate",
                        "/tr", task_cmd,
                        "/sc", "ONCE", "/st", run_at,
                        "/ru", "SYSTEM", "/f", "/rl", "HIGHEST"],
                       capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        subprocess.run(["schtasks", "/run", "/tn", "PcMonitorUpdate"],
                       capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        return jsonify({"ok": True, "version": new_ver})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Serve Frontend ────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/static/<path:filename>")
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
