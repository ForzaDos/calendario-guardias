# Plan: guardias con servidor local, usuarios y base SQL

Estado (12/11/2026): **primera versión del servidor hecha y probada, lista para probar.** Está en Python (solo biblioteca estándar, sin instalar nada): `servidor.py` + `iniciar.bat` (doble clic). Incluye: primer inicio con creación del administrador, login, usuarios (admin/editor), guardado con versiones e historial, aviso y bloqueo cuando otra persona guardó (recargar o pisar), recarga automática si no hay cambios pendientes, pestaña «Administración» (cuenta, usuarios, historial con restaurar, exportar JSON y .db, respaldo manual, registro de actividad) y respaldo diario automático en `datos/respaldos`. Pendiente: empaquetar en `.exe` + instalador, y decidir si se queda en Python (PyInstaller) o se porta a Go (ver «Piezas», punto 1). Tablet descartada: la interfaz se cuida solo para PC y celular.
Cómo se usa: doble clic en `iniciar.bat` → se abre el navegador en `http://localhost:8080` → la primera vez pide crear el administrador. Para traer los datos del archivo viejo: abrir `guardias.html` con doble clic, «Exportar JSON» (pestaña Médicos), y en el servidor pegar en «Cargar JSON». Para usarlo desde otras PCs: cambiar `"host"` a `"0.0.0.0"` en `config.json` y abrir el puerto en el firewall.

## Decisión
Seguimos con `guardias.html` como pantalla (frontend). Se le suma un programa local (backend) con base SQL, empaquetado en un instalador `.exe`. Reemplaza la idea del respaldo automático por carpeta: el respaldo diario pasa a ser función del programa.

## Dónde corre
- **Ahora:** en la PC del administrador (acceso por `http://localhost`). Puede apagarla sin perder datos; los datos quedan en un archivo en esa PC.
- **Futuro:** en un servidor o PC fija del sanatorio, siempre prendida, con los demás entrando por navegador a la dirección de esa máquina. Ver «Pasar a servidor» abajo.

## Piezas
1. **Programa único (`.exe`, hecho en Go):** lleva adentro la base SQLite y el HTML. Go da un `.exe` chico (~10 MB) y los antivirus lo marcan menos que uno hecho con Python.
2. **Instalador de Windows (Inno Setup o similar):** instala el programa, crea el acceso directo y, opcional, el arranque automático con Windows.
3. **Primer inicio:** pide crear el administrador (usuario y contraseña).
4. **Usuarios:** el administrador crea, edita y desactiva usuarios editores. Contraseñas guardadas cifradas (hash), nunca en texto plano.
5. **Médicos:** se pueden cargar muchos. Cada uno con interruptor activo/inactivo.
   - Los inactivos no entran en el reparto ni en el calendario, pero quedan en la base con su historial.
   - Se reactivan cuando vuelven.
6. **Historial:** cada guardado agrega una versión nueva (nunca borra), con quién y cuándo. Permite volver atrás.
7. **Edición simultánea:** cada guardado indica sobre qué versión se basa. Si otro guardó en el medio, el servidor lo rechaza y la página avisa «Fulano editó mientras tanto, recargá». Nadie pisa a nadie en silencio.
8. **Respaldo diario automático:** una copia de la base y un JSON exportable (compatible con el botón Exportar/Cargar de hoy), en otra carpeta o pendrive.

9. **Exportar la base de datos y los calendarios:**
   - Botón para exportar la base completa (archivo de la base SQLite y/o JSON con todo: médicos, usuarios sin contraseñas, historial).
   - Exportar los calendarios (mes o período, por planta) a archivo, además de la impresión/PDF que ya existe.
   - Importar un JSON exportado sigue funcionando para restaurar.
10. **Marca de agua en la impresión/PDF (se puede hacer ya, en el HTML):**
   - Opción bien clara en el menú de impresión: «Marca de agua: VERSION FINAL PARA FACTURACION».
   - Texto cruzado en diagonal, visible pero que no tape los nombres de quienes hicieron la guardia (gris suave, grande, detrás o con baja intensidad).
   - Impresión sigue en blanco y negro, A4 horizontal. Probar el PDF generado antes de darlo por bueno.

## Cómo se guardan los datos
Punto de partida simple: el estado `S` ya es un JSON único. Se guarda una versión por fila (número, fecha, usuario, JSON). Usuarios y médicos pueden ir en tablas propias si hace falta. Esto se define en la revisión de diseño con Opus antes de escribir código.

## Orden de trabajo
1. Opus termina el rediseño de la pestaña Médicos (en curso; copia de respaldo `guardias_version_anterior_pestana_medicos.html`).
2. ✅ HECHO (12/11/2026) — En el HTML: interruptor activo/inactivo y carga de muchos médicos. Revisado por Opus. También hecha la marca de agua de impresión (punto 10) y el rediseño de la pestaña Médicos.
3. Revisión de diseño del servidor con Opus (antes de implementar: es un cambio grande y de varios módulos).
4. Construir el servidor, el login y los usuarios.
5. Instalador `.exe`.
6. Respaldo diario y historial visible en la pantalla, en una seccion de Administracion.

## Pasar a servidor (futuro)
- Instalar el mismo programa en la máquina del servidor y mover ahí el archivo de base de datos (se copia el archivo y listo).
- Elegir un puerto (por ejemplo 8080) y pedir a sistemas que lo habiliten en el firewall de esa máquina.
- Que el programa arranque solo con Windows y que la máquina no se suspenda; idealmente UPS y «encender al volver la luz».
- El programa debe poder configurarse para escuchar en la red (hoy, solo `localhost`) y el puerto debe ser configurable.
- Aviso: dentro de la red interna las contraseñas viajan sin cifrar. Es aceptable para 2 o 3 editores en un sanatorio; si más adelante se quiere más seguridad, se puede agregar HTTPS con certificado propio.
- Acceso desde afuera del sanatorio (solo si hace falta): Tailscale en el servidor y en los celulares de los editores. Es un servicio externo que solo arma la conexión; los datos no se guardan en su nube.
- Mantener la base en un archivo local del servidor. No ponerla en una carpeta compartida de red: SQLite puede corromperse así.

## Riesgos a tener presentes
- Windows muestra «Windows protegió su PC» al instalar, porque el programa no está firmado. Se resuelve con «Ejecutar de todos modos»; firmar el código cuesta plata.
- PC apagada: nadie edita, pero no se pierde nada.
- Pérdida de datos: historial + respaldo diario fuera de esa PC + exportación manual en JSON.
