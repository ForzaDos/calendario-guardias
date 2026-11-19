"""Prueba de «Actualizar con un clic» en el motor (servidor.py): descarga con verificación desde un «Drive» falso local.

Uso (desde la carpeta del proyecto):   py -3 tests/servidor-actualizar.py
Trabaja en una carpeta temporal y otro puerto: nunca toca los datos reales ni baja nada de internet.
"""
import hashlib, http.client, json, os, shutil, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = tempfile.mkdtemp(prefix="guardias_act_")
ACT = os.path.join(D, "actualizacion")
FID = "A" * 33
EXE = b"MZ" + os.urandom(300000)          # un «instalador» falso de ~300 KB
SHA = hashlib.sha256(EXE).hexdigest()
ESTADO = {"modo": "bien", "hits": 0, "version": "9.9.9", "con_hash": True, "sha": SHA}


class Falso(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/version.json":
            j = {"version": ESTADO["version"], "novedades": "prueba"}
            if ESTADO["con_hash"]:
                j.update(sha256=ESTADO["sha"], bytes=len(EXE))
            return self._send(200, json.dumps(j).encode(), "application/json")
        if u.path == "/modo":
            ESTADO["modo"] = parse_qs(u.query)["m"][0]
            return self._send(200, b"ok", "text/plain")
        if u.path == "/download":
            q = parse_qs(u.query)
            ESTADO["hits"] += 1
            m = ESTADO["modo"]
            if q.get("id", [""])[0] != FID:
                return self._send(404, b"no", "text/plain")
            if m == "cuota":
                return self._send(200, b"<html>Quota exceeded: too many users have viewed or downloaded this file</html>", "text/html")
            if m == "aviso" and "uuid" not in q:
                form = ('<html><form action="http://127.0.0.1:%d/download" method="get">'
                        '<input type="hidden" name="id" value="%s"><input type="hidden" name="export" value="download">'
                        '<input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-123"></form></html>' % (PORT_F, FID))
                return self._send(200, form.encode(), "text/html")
            if m == "lento":
                time.sleep(1.2)
            cuerpo = EXE[:150000] if m == "corto" else EXE
            return self._send(200, cuerpo, "application/octet-stream", largo=len(EXE) if m == "corto" else None)
        self._send(404, b"no", "text/plain")

    def _send(self, code, body, ctype, largo=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(largo if largo is not None else len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass


falso = ThreadingHTTPServer(("127.0.0.1", 0), Falso)
PORT_F = falso.server_address[1]
threading.Thread(target=falso.serve_forever, daemon=True).start()

shutil.copy(os.path.join(RAIZ, "servidor.py"), D)
shutil.copy(os.path.join(RAIZ, "guardias.html"), D)
json.dump({"url_version": "http://127.0.0.1:%d/version.json" % PORT_F, "url_instalador": FID,
           "url_descarga": "https://ejemplo.test/carpeta"}, open(os.path.join(D, "actualizaciones.json"), "w"))
PORT = 18241
env = dict(os.environ, GUARDIAS_PORT=str(PORT), GUARDIAS_SIN_NAVEGADOR="1", GUARDIAS_ACT_DIR=ACT,
           GUARDIAS_DRIVE_BASE="http://127.0.0.1:%d/download" % PORT_F)
os.makedirs(ACT, exist_ok=True)
open(os.path.join(ACT, "nuevo.part"), "wb").write(b"resto de una descarga cortada")      # debe limpiarse al arrancar
proc = subprocess.Popen([sys.executable, "-I", os.path.join(D, "servidor.py")], cwd=D, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
ok = True


def chk(n, c, x=None):
    global ok
    print(("OK  " if c else "FAIL") + " " + n + ("" if c or x is None else " -> " + str(x)))
    if not c:
        ok = False


def req(method, path, body=None, cookie=None):
    c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=30)
    h = {"X-Requested-With": "guardias"}
    if body is not None:
        h["Content-Type"] = "application/json"
    if cookie:
        h["Cookie"] = cookie
    c.request(method, path, json.dumps(body) if body is not None else None, h)
    r = c.getresponse()
    data = r.read()
    ck = r.getheader("Set-Cookie")
    try:
        j = json.loads(data)
    except Exception:
        j = None
    return r.status, j, ck


def modo(m):
    http.client.HTTPConnection("127.0.0.1", PORT_F).request("GET", "/modo?m=" + m)
    time.sleep(0.2)


def esperar(estados, tmax=40):
    t0 = time.time()
    while time.time() - t0 < tmax:
        s, j, _ = req("GET", "/api/actualizar", None, A)
        if j and j["estado"] in estados:
            return j
        time.sleep(0.15)
    return j


try:
    time.sleep(2.5)
    chk("al arrancar se limpió el resto de la descarga cortada", not os.path.exists(os.path.join(ACT, "nuevo.part")))
    req("POST", "/api/setup", {"username": "admin_a", "password": "PruebaSandbox-2026"})
    s, j, ck = req("POST", "/api/login", {"username": "admin_a", "password": "PruebaSandbox-2026"})
    A = ck.split(";")[0]
    req("POST", "/api/users", {"username": "editor_a", "password": "ClaveEditor-2026", "role": "editor"}, A)
    s, j, ck2 = req("POST", "/api/login", {"username": "editor_a", "password": "ClaveEditor-2026"})
    E = ck2.split(";")[0]

    s, j, _ = req("GET", "/api/update?actual=1.1.1&forzar=1", None, A)
    chk("hay versión nueva y se puede bajar sola (auto)", s == 200 and j["hay"] and j["auto"] and j["version"] == "9.9.9", (s, j))
    s, j, _ = req("GET", "/api/update?actual=9.9.9&forzar=1", None, A)
    chk("si ya tiene la última: no hay y no es auto", j["hay"] is False and j["auto"] is False, j)
    s, j, _ = req("POST", "/api/actualizar", {"actual": "9.9.9"}, A)
    chk("sin versión nueva no baja nada (409)", s == 409, (s, j))
    s, j, _ = req("POST", "/api/actualizar", {"actual": "1.1.1"}, E)
    chk("un editor no puede actualizar (403)", s == 403, (s, j))
    s, j, _ = req("POST", "/api/actualizar", {"actual": "1.1.1"})
    chk("sin sesión no puede (401)", s == 401, (s, j))
    ESTADO["con_hash"] = False
    s, j, _ = req("GET", "/api/update?actual=1.1.1&forzar=1", None, A)
    chk("si version.json no trae sha256 y tamaño: no es auto", j["hay"] and j["auto"] is False, j)
    s, j, _ = req("POST", "/api/actualizar", {"actual": "1.1.1"}, A)
    chk("…y no se descarga (400)", s == 400, (s, j))
    ESTADO["con_hash"] = True

    # camino feliz, con dos clics seguidos
    ESTADO["hits"] = 0
    modo("lento")
    s1, j1, _ = req("POST", "/api/actualizar", {"actual": "1.1.1"}, A)
    s2, j2, _ = req("POST", "/api/actualizar", {"actual": "1.1.1"}, A)
    chk("el primer clic empieza a bajar", s1 == 200 and j1["estado"] == "bajando", (s1, j1))
    chk("el segundo clic no empieza otra descarga", s2 == 200 and j2["estado"] == "bajando", (s2, j2))
    fin = esperar(("listo", "error"))
    chk("la descarga termina bien", fin["estado"] == "listo" and fin["pct"] == 100, fin)
    chk("se bajó UNA sola vez", ESTADO["hits"] == 1, ESTADO["hits"])
    exe = os.path.join(ACT, "Instalar.exe")
    chk("queda Instalar.exe idéntico", os.path.exists(exe) and open(exe, "rb").read() == EXE)
    okf = open(os.path.join(ACT, "Instalar.ok")).read().split()
    chk("queda Instalar.ok con el hash y la versión", okf[0] == SHA and okf[1] == "9.9.9", okf)
    chk("no queda archivo a medias", not os.path.exists(os.path.join(ACT, "nuevo.part")))

    # página de aviso de Drive para archivos grandes
    modo("aviso")
    req("POST", "/api/actualizar", {"actual": "1.1.1"}, A)
    fin = esperar(("listo", "error"))
    chk("con la página de aviso de Drive (formulario) igual baja", fin["estado"] == "listo", fin)
    # cuota
    modo("cuota")
    req("POST", "/api/actualizar", {"actual": "1.1.1"}, A)
    fin = esperar(("listo", "error"))
    chk("cuota de Drive superada: error «cuota», sin archivos", fin["estado"] == "error" and fin["error"] == "cuota" and not os.path.exists(exe), fin)
    # archivo cortado
    modo("corto")
    req("POST", "/api/actualizar", {"actual": "1.1.1"}, A)
    fin = esperar(("listo", "error"))
    chk("descarga cortada: error «incompleta», sin archivos", fin["estado"] == "error" and fin["error"] == "incompleta" and not os.path.exists(exe) and not os.path.exists(os.path.join(ACT, "nuevo.part")), fin)
    # hash distinto
    modo("bien")
    ESTADO["sha"] = "0" * 64
    req("POST", "/api/actualizar", {"actual": "1.1.1"}, A)
    fin = esperar(("listo", "error"))
    chk("hash distinto: error y nada para ejecutar", fin["estado"] == "error" and not os.path.exists(exe) and not os.path.exists(os.path.join(ACT, "Instalar.ok")), fin)
    ESTADO["sha"] = SHA
    # y vuelve a andar
    req("POST", "/api/actualizar", {"actual": "1.1.1"}, A)
    fin = esperar(("listo", "error"))
    chk("después de un error, se puede reintentar y anda", fin["estado"] == "listo", fin)
finally:
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()
    falso.shutdown()
    shutil.rmtree(D, ignore_errors=True)
print("TODO OK" if ok else "HAY FALLOS")
sys.exit(0 if ok else 1)
