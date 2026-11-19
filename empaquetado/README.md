# Empaquetado para Windows

Arma el instalador del calendario de guardias para Windows 10/11:

- **`Instalar-Calendario-Guardias-<versión>.exe`**: un solo archivo con todo adentro (ventana, motor, base SQLite y página). No pide permisos de administrador: instala en `%LOCALAPPDATA%\Programs\CalendarioGuardias`, crea los accesos del Escritorio y del Menú Inicio, abre el programa y avisa que quedó instalado. Si ya había una versión, la actualiza sin tocar los datos (antes hace una copia de la base).
- **`Guardias-Setup-1.0.0.msi`**: el paquete de Windows Installer que va dentro del `.exe` (instalación silenciosa, por usuario).
- **Instalación limpia**: el paquete no lleva base de datos, médicos ni guardias (el script lo comprueba y se frena si encuentra datos). El primer inicio pide crear el administrador.

## Qué hay acá

| Archivo | Para qué |
|---|---|
| `build.ps1` | Arma todo: motor (PyInstaller), ventana (.NET), MSI (WiX) y las guías en PDF. |
| `crear-instalador-exe.ps1` | Arma el instalador de un solo archivo con el MSI adentro y genera `dist\version.json`. |
| `instalador/Instalar.cs` + `.manifest` | El instalador `.exe` (se compila con el `csc.exe` de .NET Framework 4 que trae Windows). |
| `host/Program.cs`, `host/CalendarioGuardias.csproj` | La ventana de escritorio (WinForms + WebView2): arranca su propio motor y muestra la página. |
| `wix/instalador.wxs` | Definición del MSI (WiX 5). |
| `guia/` | Guías de instalación y de uso (HTML + capturas) que se imprimen a PDF con Chrome. |
| `VERSION`, `NOVEDADES.txt` | Número de versión y frase de novedades de cada entrega. |
| `actualizaciones.ejemplo.json` | Modelo de la configuración del aviso de versión nueva (copiar a `actualizaciones.json`, que no se versiona). |
| `buzon.ejemplo.json` | Modelo de la dirección del buzón del grupo (copiar a `buzon.json`, que no se versiona; se incluye en el motor al compilar). Ver [`../buzon/GUIA-CLOUDFLARE.md`](../buzon/GUIA-CLOUDFLARE.md). |
| `icono.py` / `icono.ico` | Genera el ícono. |

## Requisitos para compilar (solo en la máquina de desarrollo)

- Python 3.9+ con un venv que tenga `pyinstaller` y `pillow` (para el ícono).
- .NET SDK 8.
- WiX 5 como herramienta local: `dotnet tool install --tool-path tools\wix wix --version 5.0.2`.
- Google Chrome (para imprimir las guías a PDF).
- No hace falta Inno Setup ni NSIS.

## Cómo compilar

```powershell
cd empaquetado
.\build.ps1                      # motor + ventana + MSI + guías
.\crear-instalador-exe.ps1       # instalador de un solo archivo + dist\version.json
```

El resultado queda en `dist\`.

## Aviso de versión nueva y actualización con un clic (opcional)

El programa puede avisarle al administrador cuando hay una versión más nueva (cartel grande + barra) y actualizarse con un clic en «Actualizar ahora»: baja el instalador, cierra el calendario guardando todo, lo actualiza y lo vuelve a abrir solo. Nunca hace nada sin que la persona lo pida.

1. Copiá `actualizaciones.ejemplo.json` a `actualizaciones.json` (no se versiona; se incluye en el motor al compilar) y poné: `url_version` (enlace público a un `version.json`), `url_descarga` (dónde se baja el instalador a mano) y `url_instalador` (enlace de compartir del archivo del instalador en Google Drive; de ahí sale el id para bajarlo solo).
2. En cada entrega, `crear-instalador-exe.ps1` genera `dist\version.json` con la versión de `VERSION`, la frase de `NOVEDADES.txt` y el `sha256` y `bytes` del instalador. Publicá **primero el instalador** y **después** `version.json` (en el mismo lugar, para que los enlaces no cambien: en Drive, «Administrar versiones» → «Subir versión nueva»).
3. Las instalaciones anteriores a esta función se actualizan una vez a mano; desde ahí es con un clic.

## Detalles que importan

- **Datos**: el motor los crea en `{app}\motor\datos` (base SQLite + respaldos). El desinstalador no los borra.
- **Puerto**: la ventana busca el puerto 8080 y, si está ocupado, el siguiente libre. Siempre arranca su propio motor y comprueba que sea el suyo (token); nunca usa un servidor ajeno.
- **Acceso del Escritorio**: lo crea el programa al terminar de instalarse (no el MSI), para no tocar otras unidades; se quita al desinstalar.
- **Cierre**: la ventana espera a que se guarde el último cambio y pide al motor un apagado ordenado con respaldo. Si la ventana se cae, el motor se apaga solo.
- **Log de diagnóstico**: `{app}\app\host.log`.
- El programa no está firmado: Windows puede mostrar SmartScreen la primera vez (está explicado en la guía de instalación).
