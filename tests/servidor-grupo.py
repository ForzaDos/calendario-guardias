"""Prueba del motor (servidor.py) con el grupo: configuración, guardado atómico con el punto de sincronización,
bloqueos (borrar / restaurar / compartir en red) y el reenvío al buzón.

Uso (desde la carpeta del proyecto):
    py -3 tests/servidor-grupo.py [URL_DEL_BUZON] [CODIGO_DE_CREACION]
Con URL y código prueba también el reenvío contra un buzón real (p. ej. `npx wrangler dev --local --var SETUP_CODE:x` en buzon/).
Trabaja en una carpeta temporal y otro puerto: nunca toca los datos reales.
"""
import json, os, shutil, subprocess, sys, tempfile, time, http.client, urllib.request

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUZON = sys.argv[1] if len(sys.argv) > 1 else None
CODIGO = sys.argv[2] if len(sys.argv) > 2 else None
D = tempfile.mkdtemp(prefix="guardias_grupo_")
shutil.copy(os.path.join(RAIZ, "servidor.py"), D)
shutil.copy(os.path.join(RAIZ, "guardias.html"), D)
if BUZON:
    json.dump({"url": BUZON}, open(os.path.join(D, "buzon.json"), "w"))
PORT = 18231
env = dict(os.environ, GUARDIAS_PORT=str(PORT), GUARDIAS_SIN_NAVEGADOR="1")
proc = subprocess.Popen([sys.executable, "-I", os.path.join(D, "servidor.py")], cwd=D, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
ok = True


def chk(n, c, x=None):
    global ok
    print(("OK  " if c else "FAIL") + " " + n + ("" if c or x is None else " -> " + str(x)))
    if not c:
        ok = False


def req(method, path, body=None, cookie=None):
    c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=20)
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


TOK = "0123456789abcdef." + "a" * 64
GID = "b" * 32
GRUPO = {"g": GID, "token": TOK, "k": "A" * 43 + "=", "epoch": 1, "base": {}, "seen": 0, "adopt": False}
ST = {"doctors": [], "assign": {}}
try:
    time.sleep(2.5)
    s, j, _ = req("POST", "/api/setup", {"username": "admin_g", "password": "PruebaSandbox-2026"})
    chk("crear administrador", s == 200, (s, j))
    s, j, ck = req("POST", "/api/login", {"username": "admin_g", "password": "PruebaSandbox-2026"})
    A = ck.split(";")[0]
    s, j, _ = req("POST", "/api/users", {"username": "editor_g", "password": "ClaveEditor-2026", "role": "editor"}, A)
    s, j, ck2 = req("POST", "/api/login", {"username": "editor_g", "password": "ClaveEditor-2026"})
    E = ck2.split(";")[0]

    s, j, _ = req("GET", "/api/grupo", None, A)
    chk("sin grupo al principio", s == 200 and j["grupo"] is None, (s, j))
    s, j, _ = req("GET", "/api/grupo", None, E)
    chk("un editor no puede ver el grupo (403)", s == 403, (s, j))
    s, j, _ = req("PUT", "/api/grupo", {"grupo": dict(GRUPO, token="mal")}, A)
    chk("grupo con token mal formado: 400", s == 400, (s, j))
    s, j, _ = req("PUT", "/api/grupo", {"grupo": dict(GRUPO, base="x")}, A)
    chk("grupo con base inválida: 400", s == 400, (s, j))
    s, j, _ = req("PUT", "/api/grupo", {"grupo": GRUPO}, A)
    chk("guardar el grupo", s == 200, (s, j))
    s, j, _ = req("GET", "/api/grupo", None, A)
    chk("el grupo queda guardado", j["grupo"] and j["grupo"]["g"] == GID and j["grupo"]["seen"] == 0, j)

    # estado + punto de sincronización, juntos
    s, j, _ = req("GET", "/api/state/version", None, A)
    v0 = j["version"]
    meta = {"base": {"T|2026-12-01|1.h24": {"doc": 3}}, "seen": 7, "adopt": False, "epoch": 1}
    s, j, _ = req("PUT", "/api/state", {"state": ST, "base_version": v0, "grupo_meta": meta}, A)
    chk("guardar estado con el punto de sincronización", s == 200, (s, j))
    v1 = j["version"]
    s, j, _ = req("GET", "/api/grupo", None, A)
    chk("el punto quedó guardado junto con el estado", j["grupo"]["seen"] == 7 and "T|2026-12-01|1.h24" in j["grupo"]["base"], j)
    meta2 = dict(meta, seen=9)
    s, j, _ = req("PUT", "/api/state", {"state": ST, "base_version": v1, "grupo_meta": meta2}, A)
    chk("estado sin cambios: igual se guarda el punto (atajo «unchanged»)", s == 200 and j.get("unchanged") is True, (s, j))
    s, j, _ = req("GET", "/api/grupo", None, A)
    chk("…y seen avanzó a 9", j["grupo"]["seen"] == 9, j)
    s, j, _ = req("PUT", "/api/state", {"state": {"doctors": [], "assign": {"2026-12-01": {"1.h24": 3}}}, "base_version": 999, "grupo_meta": dict(meta, seen=50)}, A)
    chk("si hay choque de versión (409) el punto NO se guarda", s == 409, (s, j))
    s, j, _ = req("GET", "/api/grupo", None, A)
    chk("…seen sigue en 9", j["grupo"]["seen"] == 9, j)
    s, j, _ = req("PUT", "/api/state", {"state": ST, "base_version": v1, "grupo_meta": {"base": "x", "seen": 1}}, A)
    chk("punto con formato inválido: 400", s == 400, (s, j))

    # bloqueos mientras hay grupo
    s, j, _ = req("POST", "/api/wipe", {"password": "PruebaSandbox-2026", "mode": "guardias", "state": ST}, A)
    chk("borrar datos estando en un grupo: 409 con aviso claro", s == 409 and "grupo" in json.dumps(j), (s, j))
    s, j, _ = req("POST", "/api/restore/%d" % v1, None, A)
    chk("restaurar una versión estando en un grupo: 409", s == 409, (s, j))
    s, j, _ = req("POST", "/api/share", {"enabled": True}, A)
    chk("compartir en red estando en un grupo: 409", s == 409, (s, j))

    # reenvío al buzón: validaciones
    s, j, _ = req("POST", "/api/buzon", {"method": "GET", "path": "/ping"}, A)
    chk("el reenvío solo acepta rutas de grupos conocidas (400)", s == 400, (s, j))
    s, j, _ = req("POST", "/api/buzon", {"method": "POST", "path": "/groups"}, A)
    chk("no se puede crear un grupo desde la página (400)", s == 400, (s, j))
    s, j, _ = req("POST", "/api/buzon", {"method": "PUT", "path": "/groups/" + GID + "/log"}, A)
    chk("método no permitido (400)", s == 400, (s, j))
    s, j, _ = req("POST", "/api/buzon", {"method": "GET", "path": "/groups/" + GID + "/log?after=0"}, E)
    chk("un editor no puede usar el reenvío (403)", s == 403, (s, j))
    if not BUZON:
        s, j, _ = req("POST", "/api/buzon", {"method": "GET", "path": "/groups/" + GID + "/log?after=0"}, A)
        chk("sin buzón configurado: responde «sin_buzon» (no se cuelga)", s == 200 and j["s"] == 0, (s, j))
    else:
        r0 = urllib.request.Request(BUZON.rstrip("/") + "/v1/groups", method="POST", headers={"x-setup-code": CODIGO, "Content-Type": "application/json"})
        cr = json.loads(urllib.request.urlopen(r0, timeout=20).read())
        s, j, _ = req("POST", "/api/buzon", {"method": "POST", "path": "/groups/" + cr["group"] + "/join", "body": {"code": cr["code"], "label": "x"}}, A)
        chk("canjear la invitación a través del motor", s == 200 and j["s"] == 200 and j["j"]["role"] == "owner", (s, j))
        tk = j["j"]["token"]
        s, j, _ = req("POST", "/api/buzon", {"method": "POST", "token": tk, "path": "/groups/" + cr["group"] + "/log", "body": {"after": 0, "kind": "s", "epoch": 1, "blob": "Zm9v"}}, A)
        chk("subir un envío a través del motor", s == 200 and j["s"] == 200 and j["j"]["seq"] == 1, (s, j))
        s, j, _ = req("POST", "/api/buzon", {"method": "GET", "token": tk, "path": "/groups/" + cr["group"] + "/log?after=0"}, A)
        chk("bajarlo a través del motor", s == 200 and j["s"] == 200 and j["j"]["entries"][0]["blob"] == "Zm9v", (s, j))
        s, j, _ = req("POST", "/api/buzon", {"method": "GET", "path": "/groups/" + cr["group"] + "/log?after=0"}, A)
        chk("sin token: 401 del buzón, devuelto tal cual", s == 200 and j["s"] == 401, (s, j))

    # salir del grupo
    s, j, _ = req("POST", "/api/grupo/salir", None, A)
    chk("salir del grupo", s == 200, (s, j))
    s, j, _ = req("GET", "/api/grupo", None, A)
    chk("ya no hay grupo", j["grupo"] is None, j)
    s, j, _ = req("POST", "/api/wipe", {"password": "mala", "mode": "guardias", "state": ST}, A)
    chk("sin grupo, borrar vuelve a funcionar (pide la contraseña: 403)", s == 403, (s, j))
    s, j, _ = req("POST", "/api/restore/%d" % v1, None, A)
    chk("sin grupo, restaurar vuelve a funcionar", s == 200, (s, j))
finally:
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()
    shutil.rmtree(D, ignore_errors=True)
print("TODO OK" if ok else "HAY FALLOS")
sys.exit(0 if ok else 1)
