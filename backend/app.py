"""
Ciro Monitor — Backend Flask
Endpoint per stato PC, utente loggato (WMI) e Wake-on-LAN
Configurazione centralizzata in config.json
"""

import os
import json as json_lib
import socket
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


def load_config() -> dict:
    """Carica config.json da disco e ritorna il dict"""
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


# ── Cache dati statici per PC (hostname → dict, svuotata quando il PC va offline) ──
_pc_static_cache      = {}
_pc_static_cache_lock = threading.Lock()


def get_static_wmi(pc: dict) -> dict:
    """
    Dati che non cambiano mai: OS, modello, RAM totale, disco totale+tipo, velocità rete.
    Chiamata una sola volta per PC; il risultato viene cachato fino a quando va offline.
    """
    result = {"os": "", "model": "", "ram_gb": None, "disk_total": None,
              "disk_type": "", "net_speed": None}
    ip = pc.get("ip", "")
    if not ip:
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
            c = wmilib.WMI(computer=ip, user=wmi_user, password=wmi_pass)

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
                    result["model"] = getattr(cs[0], "Model", "") or ""
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
                stor = wmilib.WMI(computer=ip, user=wmi_user, password=wmi_pass,
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


def get_dynamic_wmi(ip: str) -> dict:
    """
    Dati che cambiano ad ogni poll: utente loggato, CPU%, RAM%, uptime, spazio disco libero.
    """
    result = {"user": "", "since": None, "cpu": None, "ram_pct": None,
              "uptime": None, "disk_free": None}
    if not ip:
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
            c = wmilib.WMI(computer=ip, user=wmi_user, password=wmi_pass)

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

        finally:
            pythoncom.CoUninitialize()
    except Exception:
        pass
    return result


def check_pc(pc: dict) -> dict:
    """Controlla stato di un PC: ping + WMI dinamico ogni poll, WMI statico una volta sola."""
    online = ping(pc["ip"])

    if not online:
        # Svuota la cache statica: al prossimo avvio verrà riletta
        with _pc_static_cache_lock:
            _pc_static_cache.pop(pc["hostname"], None)
        empty = {"user": "", "fullname": "", "since": None, "cpu": None,
                 "ram_pct": None, "uptime": None, "disk_free": None,
                 "os": "", "model": "", "ram_gb": None, "disk_total": None,
                 "disk_type": "", "net_speed": None}
        return {**pc, "online": False, **empty}

    dynamic  = get_dynamic_wmi(pc["ip"])
    fullname = lookup_fullname_ad(dynamic["user"]) if dynamic["user"] else ""

    with _pc_static_cache_lock:
        static = _pc_static_cache.get(pc["hostname"])
    if static is None:
        static = get_static_wmi(pc)
        with _pc_static_cache_lock:
            _pc_static_cache[pc["hostname"]] = static

    return {**pc, "online": True, **static, **dynamic, "fullname": fullname}


# ── Cache in background ───────────────────────────────────────────────────────
_pc_cache   = []
_cache_lock = threading.Lock()
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
        except Exception:
            pass  # Il loop non deve mai fermarsi

        # Aspetta interval secondi o fino a che la config non viene aggiornata
        _poll_event.clear()
        _poll_event.wait(timeout=interval)


# Avvia il polling una sola volta
if os.environ.get("WERKZEUG_RUN_MAIN") == "true" or not os.environ.get("WERKZEUG_RUN_MAIN"):
    _bg_thread = threading.Thread(target=_poll_loop, daemon=True, name="poll-loop")
    _bg_thread.start()


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
    if not pc.get("ip"):
        return jsonify({"error": "IP non disponibile"}), 400
    wmi_user = cfg.get("wmi", {}).get("user", "")
    wmi_pass = get_secret(SECRET_WMI_PASS)
    if not wmi_user or not wmi_pass:
        return jsonify({"error": "Credenziali WMI non configurate"}), 400
    try:
        import wmi
        import pythoncom
        pythoncom.CoInitialize()
        try:
            c = wmi.WMI(computer=pc["ip"], user=wmi_user, password=wmi_pass)
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
    if not pc.get("ip"):
        return jsonify({"error": "IP non disponibile"}), 400
    content = (
        f"full address:s:{pc['ip']}\r\n"
        f"prompt for credentials:i:1\r\n"
        f"administrative session:i:1\r\n"
    )
    return Response(
        content,
        mimetype="application/rdp",
        headers={"Content-Disposition": f'attachment; filename="{hostname}.rdp"'}
    )

@app.route("/api/ping/<hostname>", methods=["GET"])
@require_auth
def ping_single(hostname: str):
    """Ping rapido su un singolo PC"""
    cfg = get_cfg()
    pc  = next((p for p in cfg.get("pcs", []) if p["hostname"] == hostname), None)
    if not pc:
        return jsonify({"error": "PC non trovato"}), 404
    online = ping(pc["ip"])
    return jsonify({"hostname": hostname, "online": online})


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
