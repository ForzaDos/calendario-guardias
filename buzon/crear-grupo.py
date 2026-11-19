"""Crea un grupo nuevo en el buzón y escribe la INVITACIÓN DE LA DUEÑA (se la manda quien instala el programa).

Uso:
    py -3 buzon/crear-grupo.py URL_DEL_BUZON [ARCHIVO_CON_EL_CODIGO_DE_CREACION]

Por defecto lee el código de creación de buzon/codigo-creacion.txt (ese archivo no va al repositorio).
La persona que recibe la invitación la pega en Administración → Grupo → «Unirme al grupo»: su programa
genera la clave de cifrado (que nunca sale de su computadora) y sube su calendario como primera versión.
La invitación NO lleva ninguna clave y vale una sola vez, durante 48 horas.
"""
import base64, json, os, sys, urllib.request

if len(sys.argv) < 2:
    sys.exit(__doc__)
url = sys.argv[1].rstrip("/")
archivo = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "codigo-creacion.txt")
codigo = open(archivo, encoding="utf-8").read().strip()
req = urllib.request.Request(url + "/v1/groups", method="POST", headers={"x-setup-code": codigo, "Content-Type": "application/json", "User-Agent": "CalendarioGuardias"})
r = json.loads(urllib.request.urlopen(req, timeout=30).read())
inv = json.dumps({"g": r["group"], "c": r["code"], "f": 1}, separators=(",", ":"))
print("GRD1." + base64.urlsafe_b64encode(inv.encode()).decode().rstrip("="))
