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
from flask import Flask, jsonify, request, send_file, send_from_directory
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
    wmi_pass = cfg.get("wmi", {}).get("pass", "")

    if dc_ip and username:
        try:
            import wmi
            import pythoncom
            pythoncom.CoInitialize()
            try:
                c        = wmi.WMI(computer=dc_ip, user=wmi_user, password=wmi_pass)
                accounts = c.Win32_UserAccount(Name=username)
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
    wmi_pass = cfg.get("wmi", {}).get("pass", "")
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
    wmi_pass = cfg.get("wmi", {}).get("pass", "")
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


# ── Endpoint PC ───────────────────────────────────────────────────────────────
@app.route("/api/pcs", methods=["GET"])
def get_pcs():
    """Restituisce la cache aggiornata in background — risposta istantanea"""
    with _cache_lock:
        return jsonify(list(_pc_cache))


@app.route("/api/wol/<hostname>", methods=["POST"])
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
def shutdown_pc(hostname: str):
    """Spegne il PC remoto tramite WMI (Win32Shutdown flag=12 = force power off)"""
    cfg = get_cfg()
    pc  = next((p for p in cfg.get("pcs", []) if p["hostname"] == hostname), None)
    if not pc:
        return jsonify({"error": "PC non trovato"}), 404
    if not pc.get("ip"):
        return jsonify({"error": "IP non disponibile"}), 400
    wmi_user = cfg.get("wmi", {}).get("user", "")
    wmi_pass = cfg.get("wmi", {}).get("pass", "")
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


@app.route("/api/ping/<hostname>", methods=["GET"])
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
def get_config():
    """Ritorna la config corrente — password mascherata"""
    cfg  = get_cfg()
    safe = json_lib.loads(json_lib.dumps(cfg))   # deep copy
    if "wmi" in safe and "pass" in safe["wmi"]:
        safe["wmi"]["pass"] = "***"
    return jsonify(safe)


@app.route("/api/config", methods=["POST"])
def post_config():
    """
    Salva e applica una nuova config.
    Se il campo wmi.pass è "***" mantiene la password esistente.
    Riavvia il ciclo di polling immediatamente.
    """
    data = request.get_json(force=True)
    if not data:
        return jsonify({"error": "JSON non valido"}), 400

    # Preserva la password se il frontend ha inviato il placeholder
    if data.get("wmi", {}).get("pass") == "***":
        old_cfg = get_cfg()
        data["wmi"]["pass"] = old_cfg.get("wmi", {}).get("pass", "")

    save_config(data)
    apply_config(data)
    with _pc_static_cache_lock:
        _pc_static_cache.clear()
    with _fullname_cache_lock:
        _fullname_cache.clear()
    _poll_event.set()
    return jsonify({"ok": True})


@app.route("/api/config/test-wmi", methods=["POST"])
def test_wmi():
    """
    Testa le credenziali WMI su un IP specifico.
    Body: {"ip": "192.168.x.x", "user": "...", "pass": "..."}
    """
    data     = request.get_json(force=True) or {}
    ip       = data.get("ip", "")
    wmi_user = data.get("user", "")
    wmi_pass = data.get("pass", "")

    # Se pass è placeholder usa quella salvata
    if wmi_pass == "***":
        wmi_pass = get_cfg().get("wmi", {}).get("pass", "")

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
def get_positions():
    """Legge le posizioni salvate dei PC sulla piantina"""
    if os.path.exists(POSITIONS_FILE):
        with open(POSITIONS_FILE, encoding="utf-8") as f:
            return jsonify(json_lib.load(f))
    return jsonify({})


@app.route("/api/positions", methods=["POST"])
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

        # 4. Copia file preservando config.json e positions.json
        install_root = os.path.normpath(os.path.join(BASE_DIR, ".."))
        for root, dirs, files in os.walk(inner):
            rel_root = os.path.relpath(root, inner)
            dest_root = os.path.join(install_root, rel_root)
            os.makedirs(dest_root, exist_ok=True)
            for fname in files:
                if fname in PRESERVE_ON_UPDATE:
                    continue
                src  = os.path.join(root, fname)
                dest = os.path.join(dest_root, fname)
                shutil.copy2(src, dest)

        # 5. Aggiorna version.txt
        with open(VERSION_FILE, "w", encoding="utf-8") as f:
            f.write(new_ver + "\n")

        # 6. Riavvia servizio in thread separato (dopo aver risposto al client)
        def _restart():
            time.sleep(3)
            subprocess.Popen(
                ["powershell", "-Command", f"Restart-Service {SERVICE_NAME}"],
                creationflags=subprocess.DETACHED_PROCESS
            )
        threading.Thread(target=_restart, daemon=True).start()

        shutil.rmtree(tmp_dir, ignore_errors=True)
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
