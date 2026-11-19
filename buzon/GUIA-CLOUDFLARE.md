# Publicar el buzón en Cloudflare (se hace una sola vez)

El buzón es un programita (un Cloudflare Worker con una base D1) que guarda los cambios del calendario **ya cifrados**: Cloudflare no puede leerlos. El plan gratuito alcanza para un grupo de hasta 5 personas.

## Pasos

1. Creá una cuenta gratuita en https://dash.cloudflare.com/sign-up (no pide tarjeta) y confirmá el mail.
2. Instalá las dependencias e iniciá sesión (se abre el navegador; hay que tocar **Allow**):
   ```bash
   cd buzon
   npm install wrangler@4
   npx wrangler login
   ```
3. Creá la base de datos y cargá las tablas. Copiá el `database_id` que devuelve el primer comando en una copia local de `wrangler.toml` llamada `wrangler.local.toml` (está en `.gitignore`; no se sube al repositorio):
   ```bash
   npx wrangler d1 create buzon-guardias
   npx wrangler d1 execute buzon-guardias --remote --file=schema.sql -c wrangler.local.toml
   ```
4. Publicá el buzón y guardá un **código de creación** al azar como secreto (es lo que impide que un desconocido cree grupos en tu buzón; guardalo en un lugar seguro, por ejemplo en `buzon/codigo-creacion.txt`, que también está en `.gitignore`):
   ```bash
   npx wrangler deploy -c wrangler.local.toml
   npx wrangler secret put SETUP_CODE -c wrangler.local.toml
   ```
   Cloudflare te va a pedir un nombre para tu dirección (`buzon-guardias.TU-NOMBRE.workers.dev`): elegí uno sin datos personales.
5. Comprobá que responde: `curl https://buzon-guardias.TU-NOMBRE.workers.dev/v1/ping`
6. Poné la dirección y el código de creación en `empaquetado/buzon.json` (copiá `buzon.ejemplo.json`; no se versiona) y recompilá el instalador. Para una sola computadora alcanza con crear `buzon.json` junto a `servidor.py`.
7. **La primera persona crea el grupo con un botón**: **Administración → Grupo → Crear el grupo**. El programa usa el código de creación por su cuenta (nunca se muestra), crea el grupo y deja a esa persona como administradora. Después ella toca **Invitar a una persona → Copiar mensaje para WhatsApp** y lo manda a cada integrante, que lo pega en **Administración → Grupo → Unirme al grupo**. La invitación vale 48 horas y se usa una sola vez.
   - Alternativa por línea de comandos: `py -3 buzon/crear-grupo.py https://buzon-guardias.TU-NOMBRE.workers.dev` imprime la invitación de la administradora.

## Importante

- La dirección del buzón y el código de creación son de quien lo publica: no van al repositorio. El código viaja dentro del instalador (así la primera persona puede crear el grupo con un botón): **no publiques ese instalador**; quien lo tenga podría extraer el código y crear grupos en tu buzón.
- El buzón solo ve **quién escribió, cuándo y cuánto pesa** el bloque; nunca el contenido.
- Para borrar todo: en el panel de Cloudflare, Workers & Pages → `buzon-guardias` → Delete, y Storage & Databases → D1 → `buzon-guardias` → Delete.
- Límites del plan gratuito (verificar antes de crecer): unos 100.000 pedidos por día al Worker y 5 millones de lecturas por día en la base. Cada PC consulta cada 3 segundos con la ventana a la vista y cada minuto si está oculta.

## Probar en local, sin cuenta

```bash
npx wrangler d1 execute buzon-guardias --local --file=schema.sql
npx wrangler dev --local --var SETUP_CODE:prueba
```

Las pruebas automáticas están en `tests/09-buzon.js` (con una base SQLite que imita a D1) y `tests/servidor-grupo.py` (el motor con un buzón real local).
