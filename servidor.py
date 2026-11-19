#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Servidor local del calendario de guardias.

- Solo usa la biblioteca estándar de Python (sin instalar nada).
- Guarda todo en una base SQLite (datos/guardias.db): usuarios, sesiones, versiones del calendario y auditoría.
- Sirve guardias.html y una API JSON bajo /api/.
- Por defecto escucha SOLO en esta PC (127.0.0.1:8080). Para usarlo desde otras PCs de la red,
  cambiar "host" a "0.0.0.0" en config.json (ver plan.md).

Uso:  python servidor.py          (o doble clic en iniciar.bat)
"""
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import socket
import sqlite3
import sys
import tempfile
import threading
import time
import webbrowser
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import urllib.error
import urllib.request

# ------------------------------------------------------------------ rutas
FROZEN = bool(getattr(sys, "frozen", False))
APP_DIR = Path(sys.executable).parent if FROZEN else Path(__file__).resolve().parent   # junto al .exe / al script
RES_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR))                                       # recursos empaquetados (guardias.html)
HTML_PATH = (RES_DIR / "guardias.html") if (RES_DIR / "guardias.html").exists() else (APP_DIR / "guardias.html")
def _writable(d):
    try:
        t = d / ".escritura_prueba"
        t.write_text("x")
        t.unlink()
        return True
    except Exception:
        return False


# Los datos viven junto al programa; si esa carpeta no se puede escribir (p. ej. Archivos de programa), en %LOCALAPPDATA%
WORK_DIR = APP_DIR if _writable(APP_DIR) else Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "CalendarioGuardias"
WORK_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR = WORK_DIR / "datos"
BACKUP_DIR = DATA_DIR / "respaldos"
DB_PATH = DATA_DIR / "guardias.db"
CONFIG_PATH = WORK_DIR / "config.json"

DEFAULT_CONFIG = {
    "host": "127.0.0.1",
    "port": 8080,
    "abrir_navegador": True,
    "sesion_horas": 12,
    "respaldos_a_conservar": 30,
}

MAX_BODY = 5 * 1024 * 1024          # 5 MB
SOCKET_TIMEOUT = 30
MIN_PASS = 8
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 14, 8, 1
ROLES = ("admin", "editor")

WRITE_LOCK = threading.Lock()        # una sola escritura a la vez
BACKUP_LOCK = threading.Lock()
CONN_SLOTS = threading.BoundedSemaphore(80)   # tope de conexiones simultáneas (contra conexiones colgadas)
SESSION_TOUCH_SECS = 300             # cada cuánto se extiende la sesión por actividad real


def say(*a):
    """print que no falla si el programa corre sin consola (empaquetado sin ventana)."""
    try:
        print(*a)
    except Exception:
        pass


def pause(msg="Tocá Enter para salir…"):
    try:
        if sys.stdin and sys.stdin.isatty():
            input(msg)
    except Exception:
        pass
FAILS = {}                           # clave -> (cantidad, hasta_cuando) para limitar intentos de login
FAILS_LOCK = threading.Lock()


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except Exception as e:  # config rota: avisar y seguir con los valores por defecto
            say("AVISO: no pude leer config.json (%s). Uso los valores por defecto." % e)
    else:
        try:
            CONFIG_PATH.write_text(json.dumps(DEFAULT_CONFIG, indent=2, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass
    return cfg


CFG = load_config()

# La ventana (host) arranca este motor con variables de entorno: puerto y host (tienen prioridad sobre
# config.json, que no se toca) y un token secreto de esta instancia. Con el token la ventana comprueba que
# el servidor al que se conecta es el suyo, y puede pedirle un apagado ordenado.
if os.environ.get("GUARDIAS_PORT", "").isdigit():
    CFG["port"] = int(os.environ["GUARDIAS_PORT"])
if os.environ.get("GUARDIAS_HOST"):
    CFG["host"] = os.environ["GUARDIAS_HOST"]
if os.environ.get("GUARDIAS_SIN_NAVEGADOR"):
    CFG["abrir_navegador"] = False
INSTANCE_TOKEN = os.environ.get("GUARDIAS_TOKEN", "")
HTTPD = None
BIND_HOST = "127.0.0.1"        # en qué dirección escucha ahora (127.0.0.1 = solo esta PC; 0.0.0.0 = también la red)
STOP = threading.Event()      # se activa para apagar el programa
REBIND_LOCK = threading.Lock()


# ------------------------------------------------------------------ base de datos
def db():
    c = sqlite3.connect(str(DB_PATH), timeout=10, isolation_level=None)   # autocommit; transacciones manuales
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA busy_timeout=5000")
    c.execute("PRAGMA foreign_keys=ON")
    return c


def init_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    c = db()
    c.execute("PRAGMA journal_mode=WAL")
    c.executescript("""
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS users(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        pass_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'editor',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_login TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions(
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS versions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        user_id INTEGER REFERENCES users(id),
        username TEXT,
        note TEXT,
        json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        user_id INTEGER,
        username TEXT,
        action TEXT NOT NULL,
        detail TEXT
    );
    """)
    c.close()


def now_s():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def get_setting(c, key, default=None):
    r = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return r["value"] if r else default


def set_setting(c, key, value):
    c.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))


def is_loopback_host(h):
    return h in ("127.0.0.1", "localhost", "::1")


def local_addresses():
    """Direcciones de esta PC dentro de la red (la principal primero), para armar el enlace que se le manda a los demás."""
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))     # no envía nada: solo averigua por qué placa saldría
        ips.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.append(info[4][0])
    except Exception:
        pass
    out = []
    for ip in ips:
        if ip not in out and not ip.startswith("127.") and not ip.startswith("169.254.") and ip != "0.0.0.0":
            out.append(ip)
    return out


def audit(c, user, action, detail=""):
    try:
        c.execute("INSERT INTO audit(at,user_id,username,action,detail) VALUES(?,?,?,?,?)",
                  (now_s(), user["id"] if user else None, user["username"] if user else None, action, str(detail)[:500]))
    except Exception:
        pass


# ------------------------------------------------------------------ contraseñas y sesiones
def hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    h = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32)
    return base64.b64encode(h).decode(), base64.b64encode(salt).decode()


def check_password(password, pass_hash, salt_b64):
    h, _ = hash_password(password, base64.b64decode(salt_b64))
    return hmac.compare_digest(h, pass_hash)


DUMMY_HASH, DUMMY_SALT = hash_password("contraseña-falsa-para-igualar-tiempos")


def sha(token):
    return hashlib.sha256(token.encode()).hexdigest()


def valid_username(u):
    return isinstance(u, str) and re.fullmatch(r"[A-Za-z0-9._@-]{3,40}", u) is not None


def valid_password(p):
    return isinstance(p, str) and MIN_PASS <= len(p) <= 200


def throttle_check(key):
    with FAILS_LOCK:
        n, until = FAILS.get(key, (0, 0))
        if until > time.time():
            return int(until - time.time())
        return 0


def throttle_fail(key):
    with FAILS_LOCK:
        if len(FAILS) > 5000:   # limpiar los vencidos
            for k in [k for k, (n_, u_) in FAILS.items() if u_ < time.time()]:
                FAILS.pop(k, None)
        n, until = FAILS.get(key, (0, 0))
        if until and until <= time.time():   # el bloqueo anterior ya venció: empezar de cero
            n = 0
        n += 1
        FAILS[key] = (n, (time.time() + 300) if n >= 5 else 0)


def throttle_ok(key):
    with FAILS_LOCK:
        FAILS.pop(key, None)


# ------------------------------------------------------------------ respaldos
def backup_now(tag=""):
    """Copia consistente de la base (API de backup de SQLite) + JSON del último estado."""
    with BACKUP_LOCK:
        return _backup_now(tag)


def _backup_now(tag=""):
    stamp = datetime.now().strftime("%Y-%m-%d")
    name = "guardias_%s%s" % (stamp, ("_" + tag) if tag else "")
    dst_db = BACKUP_DIR / (name + ".db")
    src = db()
    try:
        try:
            src.execute("PRAGMA wal_checkpoint(PASSIVE)")
        except Exception:
            pass
        tmp_db = BACKUP_DIR / (name + ".db." + secrets.token_hex(4) + ".tmp")   # nombre único: dos motores no chocan
        try:
            tmp_db.unlink()
        except FileNotFoundError:
            pass
        dst = sqlite3.connect(str(tmp_db))
        try:
            with dst:
                src.backup(dst)
        finally:
            dst.close()
        os.replace(str(tmp_db), str(dst_db))     # el respaldo aparece completo o no aparece
        row = src.execute("SELECT id,json FROM versions ORDER BY id DESC LIMIT 1").fetchone()
        if row:
            tmp_js = BACKUP_DIR / (name + ".json." + secrets.token_hex(4) + ".tmp")
            tmp_js.write_text(row["json"], encoding="utf-8")
            os.replace(str(tmp_js), str(BACKUP_DIR / (name + ".json")))
    finally:
        src.close()
    # restos de respaldos interrumpidos (más de un día)
    for old_tmp in BACKUP_DIR.glob("*.tmp"):
        try:
            if time.time() - old_tmp.stat().st_mtime > 86400:
                old_tmp.unlink()
        except Exception:
            pass
    # rotación: las diarias (una por fecha) se conservan N; las de inicio/cierre/manuales, las últimas 10 de cada tipo
    keep = int(CFG.get("respaldos_a_conservar", 30))
    allf = sorted(BACKUP_DIR.glob("guardias_*.db"))
    daily = [f for f in allf if re.fullmatch(r"guardias_\d{4}-\d\d-\d\d\.db", f.name)]
    groups = {"diaria": daily}
    for f in allf:
        if f in daily:
            continue
        t = re.sub(r"^guardias_\d{4}-\d\d-\d\d_", "", f.stem)
        t = "manual" if re.fullmatch(r"\d{6}", t) else t
        groups.setdefault(t, []).append(f)
    for g, files in groups.items():
        lim = keep if g == "diaria" else 10
        for old in (files[:-lim] if lim > 0 else []):
            for ext in (".db", ".json"):
                try:
                    old.with_suffix(ext).unlink()
                except Exception:
                    pass
    return dst_db.name


def backup_loop():
    while True:
        try:
            today = datetime.now().strftime("%Y-%m-%d")
            if not (BACKUP_DIR / ("guardias_%s.db" % today)).exists():
                backup_now()
        except Exception as e:
            say("AVISO: falló el respaldo automático:", e)
        time.sleep(3600)


# ------------------------------------------------------------------ servidor HTTP
def client_is_local(addr):
    try:
        return ipaddress.ip_address(addr.split("%")[0]).is_loopback
    except Exception:
        return False


def host_allowed(host_header):
    """Contra DNS rebinding: si el servidor escucha solo en esta PC, el Host debe ser local."""
    if not host_header:
        return False
    h = host_header.strip().lower()
    if h.startswith("["):
        name = h.split("]")[0] + "]"
    else:
        name = h.split(":")[0]
    if is_loopback_host(BIND_HOST):
        return name in ("localhost", "127.0.0.1", "[::1]")
    # compartido en la red: se aceptan direcciones IP y el nombre de esta PC (no nombres de internet: contra DNS rebinding)
    if name in ("localhost", "[::1]") or re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", name):
        return True
    pc = socket.gethostname().lower()
    return name == pc or name.startswith(pc + ".")


# ------------------------------------------------------------------ aviso de versión nueva
# Solo AVISA: consulta un archivo chico (version.json) y compara. No descarga ni instala nada.
# Dónde mirar: actualizaciones.json junto al programa (lo arma la entrega) o claves en config.json:
#   {"url_version": "https://.../version.json", "url_descarga": "https://... (carpeta o archivo del instalador)"}
UPD_CACHE = {"t": 0, "data": None}
UPD_LOCK = threading.Lock()


def update_cfg():
    cfg = {}
    for f in (RES_DIR / "actualizaciones.json", APP_DIR / "actualizaciones.json"):
        try:
            if f.is_file():
                cfg.update(json.loads(f.read_text(encoding="utf-8")))
                break
        except Exception:
            pass
    for k in ("url_version", "url_descarga"):
        if CFG.get(k):
            cfg[k] = CFG[k]
    # si se pegó el enlace «de compartir» de un archivo de Google Drive, se convierte al enlace de descarga directa
    u = cfg.get("url_version")
    if isinstance(u, str):
        m = re.match(r"https://drive\.google\.com/file/d/([A-Za-z0-9_-]{10,})", u) or re.match(r"https://drive\.google\.com/(?:open|uc)\?(?:[^#]*&)?id=([A-Za-z0-9_-]{10,})", u)
        if m:
            cfg["url_version"] = "https://drive.google.com/uc?export=download&id=" + m.group(1)
    return cfg


def ver_tuple(v):
    m = re.fullmatch(r"\s*(\d+(?:\.\d+){0,3})\s*", str(v or ""))
    return tuple(int(x) for x in m.group(1).split(".")) if m else None


def _url_ok(u):
    return isinstance(u, str) and re.match(r"https?://[^\s]+$", u) is not None and len(u) < 600


def check_update(actual, force=False):
    """Devuelve {"configurado": bool, "hay": bool, "version":..., "novedades":..., "descarga":..., "error":...}"""
    cfg = update_cfg()
    url = cfg.get("url_version")
    if not _url_ok(url):
        return {"configurado": False, "hay": False}
    with UPD_LOCK:
        fresh = UPD_CACHE["data"] is not None and (time.time() - UPD_CACHE["t"] < 6 * 3600)
        remote = UPD_CACHE["data"] if (fresh and not force) else None
    if remote is None:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "CalendarioGuardias"})
            with urllib.request.urlopen(req, timeout=6) as r:
                raw = r.read(20001)
            if len(raw) > 20000:
                raise ValueError("demasiado grande")
            remote = json.loads(raw.decode("utf-8-sig"))
            if not isinstance(remote, dict):
                raise ValueError("formato")
        except Exception as e:
            return {"configurado": True, "hay": False, "error": "sin_conexion"}
        with UPD_LOCK:
            UPD_CACHE.update(t=time.time(), data=remote)
    nuevo, mio = ver_tuple(remote.get("version")), ver_tuple(actual)
    if nuevo is None or mio is None:
        return {"configurado": True, "hay": False, "error": "formato"}
    enlace = remote.get("enlace") if _url_ok(remote.get("enlace")) else cfg.get("url_descarga")
    out = {"configurado": True, "hay": nuevo > mio, "version": ".".join(str(x) for x in nuevo),
           "novedades": str(remote.get("novedades") or "")[:400],
           "descarga": enlace if _url_ok(enlace) else None}
    return out


# ---- Grupo (sincronización entre PCs a través del buzón cifrado) ----
# La URL del buzón viene de un archivo `buzon.json` junto al motor ({"url": "https://..."}; no se versiona). La página no puede
# hablar directo con internet (CSP), así que el motor reenvía sus pedidos al buzón, solo a rutas conocidas y solo desde esta PC.
BUZON_PATH = re.compile(r"^/groups/[0-9a-f]{32}/(?:join|invites|log|snapshot|members(?:/(?:me|[0-9a-f]{16}))?)(?:\?after=\d{1,12})?$")
GRUPO_MSG = "Esta PC está conectada a un grupo. Para borrar datos o volver a una versión anterior, primero salí del grupo (Administración → Grupo)."


def buzon_url():
    cfg = {}
    for f in (RES_DIR / "buzon.json", APP_DIR / "buzon.json"):
        try:
            if f.is_file():
                cfg.update(json.loads(f.read_text(encoding="utf-8")))
                break
        except Exception:
            pass
    if CFG.get("url_buzon"):
        cfg["url"] = CFG["url_buzon"]
    u = cfg.get("url")
    return u.rstrip("/") if _url_ok(u) else None


def grupo_get(c):
    raw = get_setting(c, "grupo")
    if not raw:
        return None
    try:
        g = json.loads(raw)
        return g if isinstance(g, dict) else None
    except Exception:
        return None


def grupo_valido(g):
    """Controla el formato de lo que la página guarda como configuración del grupo."""
    return (isinstance(g, dict) and isinstance(g.get("g"), str) and re.fullmatch(r"[0-9a-f]{32}", g["g"]) is not None
            and isinstance(g.get("token"), str) and re.fullmatch(r"[0-9a-f]{16}\.[0-9a-f]{64}", g["token"]) is not None
            and isinstance(g.get("k"), str) and 20 < len(g["k"]) < 100
            and isinstance(g.get("epoch"), int) and not isinstance(g.get("epoch"), bool)
            and isinstance(g.get("base"), dict) and isinstance(g.get("seen"), int) and isinstance(g.get("adopt"), bool))


class Handler(BaseHTTPRequestHandler):
    server_version = "Guardias/1.0"
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.request.settimeout(SOCKET_TIMEOUT)

    def log_message(self, fmt, *args):   # silencioso
        pass

    # ---- utilidades de respuesta
    def _headers_common(self, api):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
                         "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        if api:
            self.send_header("Cache-Control", "no-store")

    def send_json(self, code, obj, extra_headers=None, raw=None):
        body = raw if raw is not None else json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._headers_common(True)
        for k, v in (extra_headers or []):
            self.send_header(k, v)
        tok = getattr(self, "_renew", None)
        if tok and not any(k == "Set-Cookie" for k, _ in (extra_headers or [])):
            for k, v in self.set_cookie_header(tok, CFG["sesion_horas"] * 3600):
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def fail(self, code, msg, **extra):
        d = {"error": msg}
        d.update(extra)
        # Después de un error se cierra la conexión: puede haber quedado sin leer el cuerpo del pedido
        self.close_connection = True
        self.send_json(code, d, [("Connection", "close")])

    def read_json(self):
        ct = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ct != "application/json":
            self.fail(415, "Se esperaba application/json.")
            return None
        try:
            return json.loads((self._raw or b"").decode("utf-8"))
        except Exception:
            self.fail(400, "JSON inválido.")
            return None

    def slurp_body(self):
        """Lee todo el cuerpo del pedido (con tope). Devuelve False si hay que rechazarlo."""
        self._raw = b""
        cl = self.headers.get("Content-Length")
        if cl is None:
            return True
        try:
            n = int(cl)
        except ValueError:
            self.fail(400, "Content-Length inválido.")
            return False
        if n < 0 or n > MAX_BODY:
            self.fail(413, "El contenido es demasiado grande.")
            return False
        self._raw = self.rfile.read(n) if n else b""
        return True

    # ---- seguridad común
    def guard(self, mutating):
        if not host_allowed(self.headers.get("Host")):
            self.fail(400, "Host no permitido.")
            return False
        if mutating:
            origin = self.headers.get("Origin")
            if origin:
                try:
                    if urlparse(origin).netloc.lower() != (self.headers.get("Host") or "").lower():
                        self.fail(403, "Origen no permitido.")
                        return False
                except Exception:
                    self.fail(403, "Origen no permitido.")
                    return False
            if self.headers.get("X-Requested-With") != "guardias":
                self.fail(403, "Falta la cabecera de seguridad.")
                return False
        return True

    def current_user(self, c, touch=True):
        ck = self.headers.get("Cookie") or ""
        m = re.search(r"(?:^|;\s*)gsid=([A-Za-z0-9_-]{20,})", ck)
        if not m:
            return None
        th = sha(m.group(1))
        row = c.execute("""SELECT u.id,u.username,u.role,u.active,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id
                           WHERE s.token_hash=?""", (th,)).fetchone()
        if not row or not row["active"] or row["expires_at"] < time.time():
            return None
        # sesión deslizante: solo con actividad real (no con el chequeo automático de versión) y como mucho cada 5 minutos
        full = CFG["sesion_horas"] * 3600
        if touch and (time.time() + full) - row["expires_at"] > SESSION_TOUCH_SECS:
            try:
                c.execute("UPDATE sessions SET expires_at=? WHERE token_hash=?", (time.time() + full, th))
                self._renew = m.group(1)
            except sqlite3.OperationalError:
                pass
        return {"id": row["id"], "username": row["username"], "role": row["role"], "token_hash": th}

    def need_user(self, c, admin=False, touch=True):
        u = self.current_user(c, touch)
        if not u:
            self.fail(401, "Tenés que iniciar sesión.")
            return None
        if admin and u["role"] != "admin":
            self.fail(403, "Solo el administrador puede hacer esto.")
            return None
        return u

    def set_cookie_header(self, token, max_age):
        return [("Set-Cookie", "gsid=%s; Path=/; HttpOnly; SameSite=Strict; Max-Age=%d" % (token, max_age))]

    # ---- despacho
    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_PATCH(self):
        self.route("PATCH")

    def do_DELETE(self):
        self.route("DELETE")

    def do_HEAD(self):
        self.fail(405, "Método no permitido.")

    def route(self, method):
        try:
            self._renew = None
            self._raw = b""
            u = urlparse(self.path)
            path = u.path
            if not self.guard(mutating=(method != "GET")):
                return
            if not self.slurp_body():
                return
            if method == "GET" and path in ("/", "/index.html", "/guardias.html"):
                return self.serve_html()
            if method == "GET" and path.startswith("/guias/"):
                return self.serve_guia(path[len("/guias/"):])
            if method == "GET" and path == "/favicon.ico":
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if not path.startswith("/api/"):
                return self.fail(404, "No encontrado.")
            q = parse_qs(u.query)
            self.api(method, path[5:], q)
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            self.close_connection = True
        except Exception as e:
            self.close_connection = True
            try:
                say("ERROR:", repr(e))
                self.fail(500, "Error interno del servidor.")
            except Exception:
                pass

    def serve_guia(self, name):
        """Guías de ayuda en PDF (instalación y uso). Solo estos dos nombres; no son datos del calendario."""
        if name not in ("guia-uso.pdf", "guia-instalacion.pdf"):
            return self.fail(404, "No encontrado.")
        for d in (APP_DIR / "guias", APP_DIR.parent / "guias", RES_DIR / "guias"):
            f = d / name
            if f.is_file():
                body = f.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/pdf")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Content-Disposition", 'inline; filename="%s"' % name)
                self.send_header("Cache-Control", "no-store")
                self._headers_common(False)
                self.end_headers()
                self.wfile.write(body)
                return
        return self.fail(404, "La guía no está instalada.")

    def serve_html(self):
        try:
            body = HTML_PATH.read_bytes()
        except Exception:
            return self.fail(500, "No encuentro guardias.html junto al servidor.")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._headers_common(False)
        self.end_headers()
        self.wfile.write(body)

    # ---- API
    def api(self, method, p, q):
        c = db()
        try:
            return self.api_inner(c, method, p, q)
        finally:
            c.close()

    def share_info(self, c):
        port = int(CFG["port"])
        on = not is_loopback_host(BIND_HOST)
        addrs = local_addresses()
        return {"enabled": on, "wanted": get_setting(c, "compartir", "0") == "1", "port": port,
                "links": ["http://%s:%d/" % (a, port) for a in addrs], "pc": socket.gethostname()}

    def api_inner(self, c, method, p, q):
        # --- públicos
        if method == "GET" and p == "status":
            n = c.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            u = self.current_user(c)
            out = {"server": True, "needs_setup": n == 0, "user": ({"username": u["username"], "role": u["role"]} if u else None)}
            if INSTANCE_TOKEN:
                out["instance"] = hashlib.sha256(("guardias-instancia:" + INSTANCE_TOKEN).encode()).hexdigest()
            return self.send_json(200, out)

        if method == "POST" and p == "shutdown":
            # apagado ordenado, solo para la ventana que arrancó este motor (token) y desde esta misma PC
            tk = self.headers.get("X-Shutdown-Token") or ""
            if not (INSTANCE_TOKEN and client_is_local(self.client_address[0]) and hmac.compare_digest(tk, INSTANCE_TOKEN)):
                return self.fail(403, "No autorizado.")
            self.send_json(200, {"ok": True})
            STOP.set()
            return

        if method == "POST" and p == "setup":
            if not client_is_local(self.client_address[0]):
                return self.fail(403, "El primer administrador solo se puede crear desde la propia PC del servidor.")
            d = self.read_json()
            if d is None:
                return
            if not valid_username(d.get("username")) or not valid_password(d.get("password")):
                return self.fail(400, "Usuario de 3 a 40 letras/números y contraseña de al menos %d caracteres." % MIN_PASS)
            ph, salt = hash_password(d["password"])
            with WRITE_LOCK:
                c.execute("BEGIN IMMEDIATE")
                try:
                    if c.execute("SELECT COUNT(*) FROM users").fetchone()[0] > 0:
                        c.execute("ROLLBACK")
                        return self.fail(409, "Ya existe un administrador.")
                    cur = c.execute("INSERT INTO users(username,pass_hash,salt,role,active,created_at) VALUES(?,?,?,'admin',1,?)",
                                    (d["username"], ph, salt, now_s()))
                    uid = cur.lastrowid
                    audit(c, {"id": uid, "username": d["username"]}, "setup", "Primer administrador")
                    c.execute("COMMIT")
                except Exception:
                    c.execute("ROLLBACK")
                    raise
            return self.start_session(c, uid, d["username"], "admin")

        if method == "POST" and p == "login":
            d = self.read_json()
            if d is None:
                return
            username, password = str(d.get("username") or ""), str(d.get("password") or "")
            kuser, kip = "u:" + self.client_address[0] + ":" + username.lower()[:40], "ip:" + self.client_address[0]
            wait = max(throttle_check(kuser), throttle_check(kip))
            if wait:
                return self.fail(429, "Demasiados intentos. Probá de nuevo en %d minutos." % (wait // 60 + 1))
            row = c.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone() if valid_username(username) else None
            if row and row["active"]:
                ok = check_password(password, row["pass_hash"], row["salt"])
            else:
                check_password(password, DUMMY_HASH, DUMMY_SALT)   # igualar tiempos
                ok = False
            if not ok:
                throttle_fail(kuser)
                throttle_fail(kip)
                with WRITE_LOCK:
                    audit(c, None, "login_fallido", username[:40])
                return self.fail(401, "Usuario o contraseña incorrectos.")
            throttle_ok(kuser)
            throttle_ok(kip)
            with WRITE_LOCK:
                c.execute("UPDATE users SET last_login=? WHERE id=?", (now_s(), row["id"]))
                audit(c, row, "login")
            return self.start_session(c, row["id"], row["username"], row["role"])

        # --- desde acá hace falta sesión
        user = self.need_user(c, touch=(p != "state/version"))
        if not user:
            return

        if method == "POST" and p == "logout":
            with WRITE_LOCK:
                c.execute("DELETE FROM sessions WHERE token_hash=?", (user["token_hash"],))
            return self.send_json(200, {"ok": True}, self.set_cookie_header("", 0))

        if method == "GET" and p == "me":
            return self.send_json(200, {"username": user["username"], "role": user["role"]})

        if method == "POST" and p == "me/password":
            d = self.read_json()
            if d is None:
                return
            row = c.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
            if not check_password(str(d.get("old") or ""), row["pass_hash"], row["salt"]):
                return self.fail(400, "La contraseña actual no es correcta.")
            if not valid_password(d.get("new")):
                return self.fail(400, "La contraseña nueva debe tener al menos %d caracteres." % MIN_PASS)
            ph, salt = hash_password(d["new"])
            with WRITE_LOCK:
                c.execute("UPDATE users SET pass_hash=?,salt=? WHERE id=?", (ph, salt, user["id"]))
                c.execute("DELETE FROM sessions WHERE user_id=? AND token_hash<>?", (user["id"], user["token_hash"]))
                audit(c, user, "cambio_contraseña_propia")
            return self.send_json(200, {"ok": True})

        # --- estado del calendario
        if method == "GET" and p == "state/version":
            r = c.execute("SELECT id FROM versions ORDER BY id DESC LIMIT 1").fetchone()
            return self.send_json(200, {"version": r["id"] if r else 0})

        if method == "GET" and p == "state":
            r = c.execute("SELECT id,created_at,username,note,json FROM versions ORDER BY id DESC LIMIT 1").fetchone()
            if not r:
                return self.send_json(200, {"version": 0, "state": None})
            head = json.dumps({"version": r["id"], "by": r["username"], "at": r["created_at"], "note": r["note"]}, ensure_ascii=False)
            raw = (head[:-1] + ',"state":' + r["json"] + "}").encode("utf-8")
            return self.send_json(200, None, raw=raw)

        if method == "PUT" and p == "state":
            d = self.read_json()
            if d is None:
                return
            st = d.get("state")
            if not isinstance(st, dict) or not isinstance(st.get("doctors"), list) or not isinstance(st.get("assign"), dict):
                return self.fail(400, "El estado no tiene el formato esperado.")
            try:
                base = int(d.get("base_version"))
            except (TypeError, ValueError):
                return self.fail(400, "Falta base_version.")
            force = bool(d.get("force"))
            note = str(d.get("note") or "")[:200] or None
            txt = json.dumps(st, ensure_ascii=False, separators=(",", ":"))
            meta = d.get("grupo_meta")      # punto de sincronización {base, seen, adopt, epoch}: se guarda JUNTO con el estado, o ninguno de los dos
            if user["role"] != "admin":
                meta = None                 # solo el administrador de esta PC sincroniza
            if meta is not None and not (isinstance(meta, dict) and isinstance(meta.get("base"), dict) and isinstance(meta.get("seen"), int)):
                return self.fail(400, "Los datos de sincronización no tienen el formato esperado.")
            with WRITE_LOCK:
                c.execute("BEGIN IMMEDIATE")
                try:
                    def guardar_meta():
                        if meta is None:
                            return
                        g = grupo_get(c)
                        if g:
                            g["base"], g["seen"] = meta["base"], meta["seen"]
                            if isinstance(meta.get("adopt"), bool):
                                g["adopt"] = meta["adopt"]
                            if isinstance(meta.get("epoch"), int) and not isinstance(meta.get("epoch"), bool):
                                g["epoch"] = meta["epoch"]
                            set_setting(c, "grupo", json.dumps(g, ensure_ascii=False, separators=(",", ":")))
                    cur = c.execute("SELECT id,created_at,username,json FROM versions ORDER BY id DESC LIMIT 1").fetchone()
                    curid = cur["id"] if cur else 0
                    if cur and cur["json"] == txt:
                        guardar_meta()
                        c.execute("COMMIT")
                        return self.send_json(200, {"version": curid, "unchanged": True})
                    if base != curid and not force:
                        c.execute("ROLLBACK")
                        return self.fail(409, "Otra persona guardó cambios mientras tanto.", current_version=curid, by=cur["username"] if cur else None, at=cur["created_at"] if cur else None)
                    if base != curid and force:
                        note = ((note + " · ") if note else "") + "Pisó la versión %d de %s" % (curid, cur["username"] if cur else "?")
                        audit(c, user, "pisar", "base %d, actual %d" % (base, curid))
                    cr = c.execute("INSERT INTO versions(created_at,user_id,username,note,json) VALUES(?,?,?,?,?)",
                                   (now_s(), user["id"], user["username"], note, txt))
                    newid = cr.lastrowid
                    guardar_meta()
                    c.execute("COMMIT")
                except Exception:
                    try:
                        c.execute("ROLLBACK")
                    except Exception:
                        pass
                    raise
            return self.send_json(200, {"version": newid})

        # --- grupo: configuración de esta PC y reenvío al buzón (solo administrador, solo desde esta PC)
        if p == "grupo" or p == "grupo/salir" or p == "buzon":
            if user["role"] != "admin" or not client_is_local(self.client_address[0]):
                return self.fail(403, "Solo el administrador, desde esta misma PC, puede usar el grupo.")
            if method == "GET" and p == "grupo":
                return self.send_json(200, {"grupo": grupo_get(c), "buzon": buzon_url() is not None})
            if method == "PUT" and p == "grupo":
                d = self.read_json()
                if d is None:
                    return
                if not grupo_valido(d.get("grupo")):
                    return self.fail(400, "Los datos del grupo no tienen el formato esperado.")
                if not is_loopback_host(BIND_HOST) or get_setting(c, "compartir", "0") == "1":
                    return self.fail(409, "Esta PC está compartida en la red. «Compartir en red» y «Grupo» no se usan a la vez: primero dejá de compartir.")
                with WRITE_LOCK:
                    set_setting(c, "grupo", json.dumps(d["grupo"], ensure_ascii=False, separators=(",", ":")))
                    audit(c, user, "grupo_guardado")
                return self.send_json(200, {"ok": True})
            if method == "POST" and p == "grupo/salir":
                with WRITE_LOCK:
                    c.execute("DELETE FROM settings WHERE key='grupo'")
                    audit(c, user, "grupo_salir")
                return self.send_json(200, {"ok": True})
            if method == "POST" and p == "buzon":
                d = self.read_json()
                if d is None:
                    return
                mth, path = d.get("method"), d.get("path")
                if mth not in ("GET", "POST", "PATCH", "DELETE") or not isinstance(path, str) or not BUZON_PATH.fullmatch(path):
                    return self.fail(400, "Pedido no válido.")
                base = buzon_url()
                if not base:
                    return self.send_json(200, {"s": 0, "j": {"error": "sin_buzon"}})
                hdr = {"User-Agent": "CalendarioGuardias", "Content-Type": "application/json"}
                tk = d.get("token")
                if isinstance(tk, str) and re.fullmatch(r"[0-9a-f]{16}\.[0-9a-f]{64}", tk):
                    hdr["Authorization"] = "Bearer " + tk
                body = None
                if d.get("body") is not None:
                    body = json.dumps(d["body"], separators=(",", ":")).encode("utf-8")
                    if len(body) > 1200000:
                        return self.fail(413, "El envío es demasiado grande.")
                try:
                    req = urllib.request.Request(base + "/v1" + path, data=body, method=mth, headers=hdr)
                    try:
                        with urllib.request.urlopen(req, timeout=15) as r:
                            raw, code = r.read(6 * 1024 * 1024), r.status
                    except urllib.error.HTTPError as e:
                        raw, code = e.read(6 * 1024 * 1024), e.code
                    j = json.loads(raw.decode("utf-8"))
                except Exception:
                    return self.send_json(200, {"s": 0, "j": {}})      # sin conexión o respuesta inválida: la página reintenta sola
                return self.send_json(200, {"s": code, "j": j})

        if method == "GET" and p == "update":
            if user["role"] != "admin":
                return self.fail(403, "Solo el administrador puede buscar actualizaciones.")
            actual = (q.get("actual") or [""])[0]
            return self.send_json(200, check_update(actual, force=((q.get("forzar") or ["0"])[0] == "1")))

        if p == "share":
            if user["role"] != "admin":
                return self.fail(403, "Solo el administrador puede compartir el calendario.")
            if method == "GET":
                return self.send_json(200, self.share_info(c))
            if method == "POST":
                d = self.read_json()
                if d is None:
                    return
                want = bool(d.get("enabled"))
                if want and grupo_get(c):
                    return self.fail(409, "Esta PC está conectada a un grupo. «Compartir en red» y «Grupo» no se usan a la vez: primero salí del grupo.")
                if want == (not is_loopback_host(BIND_HOST)) and want == (get_setting(c, "compartir", "0") == "1"):
                    return self.send_json(200, self.share_info(c))
                with WRITE_LOCK:
                    set_setting(c, "compartir", "1" if want else "0")
                    audit(c, user, "compartir_activado" if want else "compartir_desactivado")
                # el cambio de dirección se hace después de contestar (el servidor se reabre en la misma conexión)
                threading.Thread(target=rebind, args=("0.0.0.0" if want else "127.0.0.1",), daemon=True).start()
                info = self.share_info(c)
                info["enabled"] = want
                return self.send_json(200, info)

        if method == "POST" and p == "wipe":
            # Borrado de datos, solo administrador y protegido con SU contraseña (se pide de nuevo, aunque ya tenga sesión).
            if user["role"] != "admin":
                return self.fail(403, "Solo el administrador puede borrar datos.")
            if get_setting(c, "grupo"):
                return self.fail(409, GRUPO_MSG)       # borrar dejaría el calendario vacío para todo el grupo
            d = self.read_json()
            if d is None:
                return
            kw = "wipe:%s" % user["username"]
            wait = throttle_check(kw)
            if wait:
                return self.fail(429, "Demasiados intentos. Esperá %d segundos." % wait)
            row = c.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
            if not check_password(str(d.get("password") or ""), row["pass_hash"], row["salt"]):
                throttle_fail(kw)
                with WRITE_LOCK:
                    audit(c, user, "borrado_clave_incorrecta")
                return self.fail(403, "La contraseña no es correcta. No se borró nada.")
            throttle_ok(kw)
            mode = d.get("mode")
            if mode not in ("guardias", "todo", "todo_y_historial"):
                return self.fail(400, "Modo de borrado desconocido.")
            st = d.get("state")
            if not isinstance(st, dict) or not isinstance(st.get("doctors"), list) or not isinstance(st.get("assign"), dict):
                return self.fail(400, "El estado no tiene el formato esperado.")
            if mode != "todo_y_historial":
                try:
                    backup_now("antes_de_borrar")      # copia previa: se puede volver atrás desde Administración
                except Exception as e:
                    say("ERROR: copia previa al borrado:", repr(e))
                    return self.fail(500, "No pude hacer la copia previa; no se borró nada.")
            note = {"guardias": "Borradas todas las guardias",
                    "todo": "Base dejada en cero (guardias, médicos y configuración)",
                    "todo_y_historial": "Base dejada en cero y sin historial ni respaldos"}[mode]
            txt = json.dumps(st, ensure_ascii=False, separators=(",", ":"))
            with WRITE_LOCK:
                c.execute("BEGIN IMMEDIATE")
                try:
                    cr = c.execute("INSERT INTO versions(created_at,user_id,username,note,json) VALUES(?,?,?,?,?)",
                                   (now_s(), user["id"], user["username"], note, txt))
                    newid = cr.lastrowid
                    if mode == "todo_y_historial":
                        c.execute("DELETE FROM versions WHERE id<?", (newid,))
                    audit(c, user, "borrado", mode)
                    c.execute("COMMIT")
                except Exception:
                    try:
                        c.execute("ROLLBACK")
                    except Exception:
                        pass
                    raise
            if mode == "todo_y_historial":
                with BACKUP_LOCK:
                    for f in BACKUP_DIR.glob("guardias_*"):
                        try:
                            f.unlink()
                        except Exception:
                            pass
                try:
                    c.execute("VACUUM")
                except Exception:
                    pass
            return self.send_json(200, {"version": newid, "mode": mode})

        if method == "GET" and p == "versions":
            try:
                lim = max(1, min(200, int((q.get("limit") or ["60"])[0])))
            except ValueError:
                lim = 60
            rows = c.execute("SELECT id,created_at,username,note,LENGTH(json) AS bytes FROM versions ORDER BY id DESC LIMIT ?", (lim,)).fetchall()
            return self.send_json(200, {"versions": [dict(r) for r in rows]})

        m = re.fullmatch(r"versions/(\d+)", p)
        if method == "GET" and m:
            r = c.execute("SELECT id,created_at,username,note,json FROM versions WHERE id=?", (int(m.group(1)),)).fetchone()
            if not r:
                return self.fail(404, "No existe esa versión.")
            head = json.dumps({"version": r["id"], "by": r["username"], "at": r["created_at"], "note": r["note"]}, ensure_ascii=False)
            return self.send_json(200, None, raw=(head[:-1] + ',"state":' + r["json"] + "}").encode("utf-8"))

        m = re.fullmatch(r"restore/(\d+)", p)
        if method == "POST" and m:
            if get_setting(c, "grupo"):
                return self.fail(409, GRUPO_MSG)
            vid = int(m.group(1))
            with WRITE_LOCK:
                c.execute("BEGIN IMMEDIATE")
                try:
                    r = c.execute("SELECT id,json FROM versions WHERE id=?", (vid,)).fetchone()
                    if not r:
                        c.execute("ROLLBACK")
                        return self.fail(404, "No existe esa versión.")
                    cr = c.execute("INSERT INTO versions(created_at,user_id,username,note,json) VALUES(?,?,?,?,?)",
                                   (now_s(), user["id"], user["username"], "Restaurada la versión %d" % vid, r["json"]))
                    audit(c, user, "restaurar", "versión %d" % vid)
                    c.execute("COMMIT")
                except Exception:
                    try:
                        c.execute("ROLLBACK")
                    except Exception:
                        pass
                    raise
            return self.send_json(200, {"version": cr.lastrowid})

        # --- exportar y respaldos
        if method == "GET" and p == "export/json":
            r = c.execute("SELECT json FROM versions ORDER BY id DESC LIMIT 1").fetchone()
            raw = (r["json"] if r else "{}").encode("utf-8")
            with WRITE_LOCK:
                audit(c, user, "exportar_json")
            return self.send_json(200, None, [("Content-Disposition", 'attachment; filename="guardias_%s.json"' % datetime.now().strftime("%Y-%m-%d_%H%M"))], raw=raw)

        if method == "GET" and p == "export/db":
            if not self.need_user(c, admin=True):
                return
            tmp = Path(tempfile.gettempdir()) / ("guardias_exp_%s.db" % secrets.token_hex(6))
            try:
                dst = sqlite3.connect(str(tmp))
                with dst:
                    c.backup(dst)
                dst.execute("DELETE FROM sessions")
                dst.execute("DELETE FROM settings WHERE key='grupo'")      # la clave y el acceso al grupo no salen en una copia exportada
                dst.commit()
                dst.execute("VACUUM")
                dst.close()
                raw = tmp.read_bytes()
            finally:
                try:
                    tmp.unlink()
                except Exception:
                    pass
            with WRITE_LOCK:
                audit(c, user, "exportar_db")
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Content-Disposition", 'attachment; filename="guardias_%s.db"' % datetime.now().strftime("%Y-%m-%d_%H%M"))
            self._headers_common(True)
            self.end_headers()
            self.wfile.write(raw)
            return

        if method == "POST" and p == "backup":
            if not self.need_user(c, admin=True):
                return
            name = backup_now(datetime.now().strftime("%H%M%S"))
            with WRITE_LOCK:
                audit(c, user, "respaldo_manual", name)
            return self.send_json(200, {"ok": True, "archivo": name, "carpeta": str(BACKUP_DIR)})

        if method == "GET" and p == "audit":
            if not self.need_user(c, admin=True):
                return
            rows = c.execute("SELECT at,username,action,detail FROM audit ORDER BY id DESC LIMIT 100").fetchall()
            return self.send_json(200, {"audit": [dict(r) for r in rows]})

        # --- usuarios (solo administrador)
        if p == "users" or p.startswith("users/"):
            admin = self.need_user(c, admin=True)
            if not admin:
                return
            if method == "GET" and p == "users":
                rows = c.execute("SELECT id,username,role,active,created_at,last_login FROM users ORDER BY username COLLATE NOCASE").fetchall()
                return self.send_json(200, {"users": [dict(r) for r in rows]})
            if method == "POST" and p == "users":
                d = self.read_json()
                if d is None:
                    return
                if not valid_username(d.get("username")):
                    return self.fail(400, "El usuario debe tener de 3 a 40 letras, números, punto, guion o @.")
                if not valid_password(d.get("password")):
                    return self.fail(400, "La contraseña debe tener al menos %d caracteres." % MIN_PASS)
                role = d.get("role") if d.get("role") in ROLES else "editor"
                ph, salt = hash_password(d["password"])
                with WRITE_LOCK:
                    try:
                        cr = c.execute("INSERT INTO users(username,pass_hash,salt,role,active,created_at) VALUES(?,?,?,?,1,?)",
                                       (d["username"], ph, salt, role, now_s()))
                    except sqlite3.IntegrityError:
                        return self.fail(409, "Ya existe un usuario con ese nombre.")
                    audit(c, admin, "usuario_alta", "%s (%s)" % (d["username"], role))
                return self.send_json(200, {"id": cr.lastrowid})
            m = re.fullmatch(r"users/(\d+)", p)
            if method == "PATCH" and m:
                uid = int(m.group(1))
                d = self.read_json()
                if d is None:
                    return
                newpw = None
                if "password" in d:
                    if not valid_password(d["password"]):
                        return self.fail(400, "La contraseña debe tener al menos %d caracteres." % MIN_PASS)
                    newpw = hash_password(d["password"])
                with WRITE_LOCK:
                    c.execute("BEGIN IMMEDIATE")
                    try:
                        row = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
                        if not row:
                            c.execute("ROLLBACK")
                            return self.fail(404, "No existe ese usuario.")
                        new_role = d.get("role", row["role"])
                        new_active = int(bool(d.get("active"))) if "active" in d else row["active"]
                        if new_role not in ROLES:
                            c.execute("ROLLBACK")
                            return self.fail(400, "Rol inválido.")
                        # nunca dejar el sistema sin un administrador activo
                        if row["role"] == "admin" and row["active"] and (new_role != "admin" or not new_active):
                            others = c.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND active=1 AND id<>?", (uid,)).fetchone()[0]
                            if others == 0:
                                c.execute("ROLLBACK")
                                return self.fail(400, "Tiene que quedar al menos un administrador activo.")
                        changes = []
                        if newpw:
                            ph, salt = newpw
                            c.execute("UPDATE users SET pass_hash=?,salt=? WHERE id=?", (ph, salt, uid))
                            c.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
                            changes.append("contraseña")
                        if new_role != row["role"]:
                            c.execute("UPDATE users SET role=? WHERE id=?", (new_role, uid))
                            changes.append("rol=" + new_role)
                        if new_active != row["active"]:
                            c.execute("UPDATE users SET active=? WHERE id=?", (new_active, uid))
                            if not new_active:
                                c.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
                            changes.append("activo=%d" % new_active)
                        audit(c, admin, "usuario_cambio", "%s: %s" % (row["username"], ", ".join(changes) or "sin cambios"))
                        c.execute("COMMIT")
                    except Exception:
                        try:
                            c.execute("ROLLBACK")
                        except Exception:
                            pass
                        raise
                return self.send_json(200, {"ok": True})

        return self.fail(404, "No encontrado.")

    def start_session(self, c, uid, username, role):
        token = secrets.token_urlsafe(32)
        with WRITE_LOCK:
            c.execute("DELETE FROM sessions WHERE expires_at<?", (time.time(),))
            c.execute("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)",
                      (sha(token), uid, now_s(), time.time() + CFG["sesion_horas"] * 3600))
        self.send_json(200, {"username": username, "role": role}, self.set_cookie_header(token, CFG["sesion_horas"] * 3600))


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def process_request(self, request, client_address):
        if not CONN_SLOTS.acquire(blocking=False):   # demasiadas conexiones abiertas: se rechaza esta
            try:
                request.close()
            except Exception:
                pass
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            CONN_SLOTS.release()


def install_close_handler(callback):
    """En Windows, cerrar la ventana de la consola no lanza KeyboardInterrupt: se engancha el evento de cierre."""
    if os.name != "nt":
        return None
    try:
        import ctypes
        Handler_t = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_uint)

        def _h(ev):
            if ev in (2, 5, 6):   # cierre de ventana, cierre de sesión, apagado
                try:
                    callback()
                except Exception:
                    pass
            return False
        h = Handler_t(_h)
        ctypes.windll.kernel32.SetConsoleCtrlHandler(h, True)
        return h   # hay que conservar la referencia
    except Exception:
        return None


def start_listener(host, port):
    httpd = Server((host, port), Handler)
    threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.3}, daemon=True).start()
    return httpd


def rebind(new_host):
    """Cambia en caliente la dirección en la que escucha el servidor (solo esta PC <-> toda la red)."""
    global HTTPD, BIND_HOST
    time.sleep(0.4)    # deja terminar de contestar el pedido que lo originó
    with REBIND_LOCK:
        if new_host == BIND_HOST:
            return
        port = int(CFG["port"])
        old, old_host = HTTPD, BIND_HOST
        try:
            old.shutdown()
            old.server_close()
        except Exception:
            pass
        try:
            HTTPD = start_listener(new_host, port)
            BIND_HOST = new_host
            say(" Ahora escucha en:", new_host)
        except OSError as e:
            say("AVISO: no pude abrir %s:%d (%s). Vuelvo a %s." % (new_host, port, e, old_host))
            try:
                HTTPD = start_listener(old_host, port)
                BIND_HOST = old_host
            except OSError as e2:
                say("ERROR: no pude reabrir el servidor:", e2)
                STOP.set()


def main():
    global HTTPD, BIND_HOST
    init_db()
    if not HTML_PATH.exists():
        say("ERROR: no encuentro guardias.html (buscado en %s)." % HTML_PATH)
        pause()
        return 1
    host, port = CFG["host"], int(CFG["port"])
    # ¿el administrador dejó activado «compartir»? entonces escucha en toda la red
    try:
        c0 = db()
        try:
            if get_setting(c0, "compartir", "0") == "1" and is_loopback_host(host):
                host = "0.0.0.0"
        finally:
            c0.close()
    except Exception:
        pass
    try:
        HTTPD = start_listener(host, port)
        BIND_HOST = host
    except OSError as e:
        if not is_loopback_host(host):    # no se pudo abrir en la red: al menos en esta PC
            try:
                HTTPD = start_listener("127.0.0.1", port)
                BIND_HOST = "127.0.0.1"
            except OSError:
                HTTPD = None
        if HTTPD is None:
            say("ERROR: no pude abrir el puerto %d (%s)." % (port, e))
            say("Puede que el programa ya esté abierto, o que otro programa use ese puerto.")
            say("Podés cambiar el puerto en config.json.")
            pause()
            return 1
    threading.Thread(target=backup_loop, daemon=True).start()
    try:
        backup_now("inicio")
    except Exception as e:
        say("AVISO: falló el respaldo de inicio:", e)
    keep_ref = install_close_handler(lambda: backup_now("cierre"))
    url = "http://%s:%d/" % ("localhost" if BIND_HOST in ("127.0.0.1", "0.0.0.0", "::1") else BIND_HOST, port)
    say("=" * 60)
    say(" Calendario de guardias — servidor en marcha")
    say(" Abrí:", url)
    if BIND_HOST == "0.0.0.0":
        say(" Compartido con la red. Las contraseñas viajan sin cifrar (red interna, sin proxy).")
    say(" Datos:", DATA_DIR)
    say(" Para cerrarlo: cerrá esta ventana (o Ctrl+C).")
    say("=" * 60)
    if CFG.get("abrir_navegador", True):
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        while not STOP.wait(0.5):
            pass
    except KeyboardInterrupt:
        pass
    finally:
        try:
            with REBIND_LOCK:
                if HTTPD is not None:
                    HTTPD.shutdown()
        except Exception:
            pass
        try:
            backup_now("cierre")
        except Exception:
            pass
        try:
            if HTTPD is not None:
                HTTPD.server_close()
        except Exception:
            pass
    del keep_ref
    return 0


if __name__ == "__main__":
    sys.exit(main())
