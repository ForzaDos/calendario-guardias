// Buzón cifrado del calendario de guardias (Cloudflare Worker + base D1).
//
// Qué hace: las PCs del grupo dejan acá sus cambios YA CIFRADOS y retiran los de las demás, en orden.
// Qué NO puede hacer: leer nada. Solo ve quién escribió, cuándo y cuánto pesa el bloque.
//
// Rutas (todas bajo /v1):
//   GET    /ping
//   POST   /groups                       (cabecera x-setup-code)  crea el grupo y la invitación de la dueña
//   POST   /groups/:g/join               {code,label}             canjea una invitación (un solo uso)
//   POST   /groups/:g/invites            {role?}                  (admin o dueña) crea una invitación
//   GET    /groups/:g/log?after=N                                 cambios nuevos, en orden
//   POST   /groups/:g/log                {after,kind,epoch,blob}  agrega (409 si hubo novedades)
//   GET    /groups/:g/snapshot                                    última foto completa
//   GET    /groups/:g/members                                     (admin o dueña) quiénes están
//   PATCH  /groups/:g/members/me         {label}                  cambia el propio nombre
//   PATCH  /groups/:g/members/:id        {role}                   (solo la dueña) admin / member
//   DELETE /groups/:g/members/:id                                 (solo la dueña) quita a alguien
//   DELETE /groups/:g/members/me                                  salir del grupo (libera el lugar; la dueña no puede)
// Autenticación: cabecera Authorization: Bearer <id>.<secreto> (el buzón guarda solo el hash).

const MAX_BLOB = 900000;      // caracteres por bloque (D1 acepta ~1 MB por fila)
const MAX_MEMBERS = 5;        // personas activas por grupo
const INVITE_MS = 48 * 3600 * 1000;
const PAGE = 200;

const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const rnd = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const err = (status, code, extra) => json(Object.assign({ error: code }, extra || {}), status);
const MAX_BODY = 1100000;   // bytes que aceptamos de un pedido (un bloque + sobres)
const tooBig = req => (parseInt(req.headers.get('content-length') || '0', 10) || 0) > MAX_BODY;
const bodyOf = async req => { try { const t = await req.text(); if (t.length > MAX_BODY) return null; const b = JSON.parse(t); return b && typeof b === 'object' && !Array.isArray(b) ? b : null } catch (e) { return null } };
const PAGE_BYTES = 4000000;  // una respuesta de /log nunca pasa de esto (siempre trae al menos 1 entrada)
const GID = /^[0-9a-f]{32}$/;

async function auth(req, env, gid) {
  const m = /^Bearer ([0-9a-f]{16})\.([0-9a-f]{64})$/.exec(req.headers.get('authorization') || '');
  if (!m) return { res: err(401, 'sin_acceso') };
  const row = await env.DB.prepare('SELECT id, role, active, token_hash, last_seen FROM members WHERE group_id = ?1 AND id = ?2').bind(gid, m[1]).first();
  if (!row || row.token_hash !== await sha(m[2])) return { res: err(401, 'sin_acceso') };
  if (!row.active) return { res: err(403, 'quitada') };
  const now = Date.now();
  if (now - (row.last_seen || 0) > 60000) await env.DB.prepare('UPDATE members SET last_seen = ?1 WHERE group_id = ?2 AND id = ?3').bind(now, gid, row.id).run();
  return { me: row };
}
const isAdmin = me => me.role === 'owner' || me.role === 'admin';
const groupOf = (env, gid) => env.DB.prepare('SELECT id, epoch FROM groups WHERE id = ?1').bind(gid).first();
// Dos subconsultas separadas: así SQLite usa el índice y lee 2 filas (con MIN y MAX juntos recorría todo el registro)
const headOf = async (env, gid) => (await env.DB.prepare(
  'SELECT COALESCE((SELECT MAX(seq) FROM log WHERE group_id = ?1), 0) AS h, COALESCE((SELECT MIN(seq) FROM log WHERE group_id = ?1), 0) AS f').bind(gid).first());

async function newInvite(env, gid, role, by) {
  const code = rnd(16), now = Date.now();
  await env.DB.prepare('DELETE FROM invites WHERE group_id = ?1 AND (used = 1 OR expires < ?2)').bind(gid, now).run();
  await env.DB.prepare('INSERT INTO invites (group_id, code_hash, role, expires, used, created_by) VALUES (?1, ?2, ?3, ?4, 0, ?5)').bind(gid, await sha(code), role, now + INVITE_MS, by || '').run();
  return { code, expires: now + INVITE_MS };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), method = req.method;
    if (!url.pathname.startsWith('/v1/')) return err(404, 'no_existe');
    const path = url.pathname.slice(3);
    if (tooBig(req)) return err(413, 'muy_grande', { maximo: MAX_BODY });
    try {
      if (method === 'GET' && path === '/ping') return json({ ok: true, servicio: 'buzon-guardias', v: 1 });

      // ---- crear un grupo (solo quien tiene el código de creación: el desarrollador) ----
      if (method === 'POST' && path === '/groups') {
        const sc = req.headers.get('x-setup-code') || '';
        if (!env.SETUP_CODE || !sc || await sha(sc) !== await sha(env.SETUP_CODE)) return err(403, 'codigo_de_creacion');
        const gid = rnd(16);
        await env.DB.prepare('INSERT INTO groups (id, epoch, created) VALUES (?1, 1, ?2)').bind(gid, Date.now()).run();
        const inv = await newInvite(env, gid, 'owner', '');
        return json({ group: gid, code: inv.code, expires: inv.expires });
      }

      const m = /^\/groups\/([0-9a-f]{32})(\/.*)?$/.exec(path);
      if (!m) return err(404, 'no_existe');
      const gid = m[1], sub = m[2] || '';
      const grp = await groupOf(env, gid);
      if (!grp) return err(404, 'grupo_inexistente');

      // ---- canjear una invitación ----
      if (method === 'POST' && sub === '/join') {
        const b = await bodyOf(req);
        if (!b || typeof b.code !== 'string' || b.code.length > 100) return err(400, 'pedido_invalido');
        const label = typeof b.label === 'string' ? b.label.slice(0, 400) : '';
        const ch = await sha(b.code);
        const inv = await env.DB.prepare('SELECT role, expires, used FROM invites WHERE group_id = ?1 AND code_hash = ?2').bind(gid, ch).first();
        if (!inv || inv.used) return err(403, 'invitacion_invalida');
        if (inv.expires < Date.now()) return err(403, 'invitacion_vencida');
        const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE group_id = ?1 AND active = 1').bind(gid).first();
        if (n.n >= MAX_MEMBERS) return err(409, 'grupo_completo', { maximo: MAX_MEMBERS });
        const id = rnd(8), secret = rnd(32), now = Date.now();
        // todo o nada: se crea la persona SOLO si la invitación sigue sin usar y hay lugar; y recién ahí se gasta la invitación
        const res = await env.DB.batch([
          env.DB.prepare('INSERT INTO members (group_id, id, role, label, token_hash, active, created, last_seen) ' +
            'SELECT ?1, ?3, i.role, ?4, ?5, 1, ?6, ?6 FROM invites i WHERE i.group_id = ?1 AND i.code_hash = ?2 AND i.used = 0 AND i.expires > ?6 ' +
            'AND (SELECT COUNT(*) FROM members WHERE group_id = ?1 AND active = 1) < ?7').bind(gid, ch, id, label, await sha(secret), now, MAX_MEMBERS),
          env.DB.prepare('UPDATE invites SET used = 1 WHERE group_id = ?1 AND code_hash = ?2 AND used = 0 AND EXISTS (SELECT 1 FROM members WHERE group_id = ?1 AND id = ?3)').bind(gid, ch, id)
        ]);
        if (res[0].meta.changes !== 1) return err(403, 'invitacion_invalida');
        inv.role = (await env.DB.prepare('SELECT role FROM members WHERE group_id = ?1 AND id = ?2').bind(gid, id).first()).role;
        const h = await headOf(env, gid);
        return json({ member_id: id, token: id + '.' + secret, role: inv.role, epoch: grp.epoch, head: h.h });
      }

      // ---- de acá en adelante hace falta ser del grupo ----
      const a = await auth(req, env, gid);
      if (a.res) return a.res;
      const me = a.me;

      if (method === 'POST' && sub === '/invites') {
        if (!isAdmin(me)) return err(403, 'sin_permiso');
        const b = (await bodyOf(req)) || {};
        const role = b.role === 'admin' ? 'admin' : 'member';
        if (role === 'admin' && me.role !== 'owner') return err(403, 'sin_permiso');
        return json(await newInvite(env, gid, role, me.id));
      }

      if (method === 'GET' && sub === '/log') {
        const after = Math.max(0, parseInt(url.searchParams.get('after') || '0', 10) || 0);
        const h = await headOf(env, gid);
        const base = { epoch: grp.epoch, head: h.h, first: h.f };
        // si la PC quedó atrás de lo que se conserva, tiene que partir de la última foto
        if (after > h.h || (h.h > 0 && after + 1 < h.f)) return json(Object.assign({ gap: true, entries: [] }, base));   // adelantada (se restauró el buzón) o muy atrás
        const rows = await env.DB.prepare('SELECT seq, member_id AS by, kind, epoch, blob, t FROM log WHERE group_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3').bind(gid, after, PAGE).all();
        let bytes = 0; const out = [];
        for (const r of rows.results) { bytes += r.blob.length; if (out.length && bytes > PAGE_BYTES) break; out.push(r) }
        return json(Object.assign({ entries: out, more: out.length < rows.results.length || rows.results.length === PAGE }, base));
      }

      if (method === 'POST' && sub === '/log') {
        const b = await bodyOf(req);
        if (!b || !Number.isInteger(b.after) || b.after < 0 || !['p', 's', 'k'].includes(b.kind) || !Number.isInteger(b.epoch) ||
            typeof b.blob !== 'string' || !b.blob.length) return err(400, 'pedido_invalido');
        if (b.blob.length > MAX_BLOB) return err(413, 'muy_grande', { maximo: MAX_BLOB });
        if (b.kind === 'k' && me.role !== 'owner') return err(403, 'sin_permiso');
        const want = b.kind === 'k' ? grp.epoch + 1 : grp.epoch;
        if (b.epoch !== want) return err(409, 'epoca', { epoch: grp.epoch, head: (await headOf(env, gid)).h });
        const seq = b.after + 1;
        const ins = env.DB.prepare(
          'INSERT INTO log (group_id, seq, member_id, kind, epoch, blob, t) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 ' +
          'WHERE (SELECT COALESCE(MAX(seq), 0) FROM log WHERE group_id = ?1) = ?8')
          .bind(gid, seq, me.id, b.kind, b.epoch, b.blob, Date.now(), b.after);
        // lo que acompaña a la entrada va en el mismo lote y solo se aplica si la entrada se agregó
        const here = 'EXISTS (SELECT 1 FROM log WHERE group_id = ?1 AND seq = ?2 AND kind = ?3 AND member_id = ?4)';
        const extra = [];
        if (b.kind === 'k') {
          extra.push(env.DB.prepare('UPDATE groups SET epoch = ?5 WHERE id = ?1 AND ' + here).bind(gid, seq, 'k', me.id, b.epoch));
          extra.push(env.DB.prepare('DELETE FROM invites WHERE group_id = ?1 AND used = 0 AND ' + here).bind(gid, seq, 'k', me.id));   // las invitaciones viejas llevan la clave vieja
        }
        if (b.kind === 's') extra.push(env.DB.prepare('DELETE FROM log WHERE group_id = ?1 AND seq < ?2 AND EXISTS (SELECT 1 FROM log WHERE group_id = ?1 AND seq = ?2 AND kind = ?3 AND member_id = ?4)').bind(gid, seq, 's', me.id));   // lo anterior ya está en la foto
        const res = await env.DB.batch([ins].concat(extra));
        if (res[0].meta.changes !== 1) return err(409, 'novedades', { head: (await headOf(env, gid)).h });
        return json({ seq });
      }

      if (method === 'GET' && sub === '/snapshot') {
        const row = await env.DB.prepare("SELECT seq, member_id AS by, epoch, blob, t FROM log WHERE group_id = ?1 AND kind = 's' ORDER BY seq DESC LIMIT 1").bind(gid).first();
        return row ? json(row) : err(404, 'sin_foto');
      }

      if (method === 'GET' && sub === '/members') {
        if (!isAdmin(me)) return err(403, 'sin_permiso');
        const rows = await env.DB.prepare('SELECT id, role, label, active, created, last_seen FROM members WHERE group_id = ?1 ORDER BY created').bind(gid).all();
        return json({ members: rows.results, yo: me.id });
      }

      if (method === 'PATCH' && sub === '/members/me') {
        const b = await bodyOf(req);
        if (!b || typeof b.label !== 'string') return err(400, 'pedido_invalido');
        await env.DB.prepare('UPDATE members SET label = ?1 WHERE group_id = ?2 AND id = ?3').bind(b.label.slice(0, 400), gid, me.id).run();
        return json({ ok: true });
      }

      if (method === 'DELETE' && sub === '/members/me') {   // salir del grupo por decisión propia: libera el lugar
        if (me.role === 'owner') return err(409, 'es_la_duena');
        await env.DB.batch([
          env.DB.prepare('UPDATE members SET active = 0 WHERE group_id = ?1 AND id = ?2').bind(gid, me.id),
          env.DB.prepare('DELETE FROM invites WHERE group_id = ?1 AND created_by = ?2 AND used = 0').bind(gid, me.id)
        ]);
        return json({ ok: true });
      }

      const mm = /^\/members\/([0-9a-f]{16})$/.exec(sub);
      if (mm && (method === 'PATCH' || method === 'DELETE')) {
        if (me.role !== 'owner') return err(403, 'sin_permiso');
        const tgt = await env.DB.prepare('SELECT id, role, active FROM members WHERE group_id = ?1 AND id = ?2').bind(gid, mm[1]).first();
        if (!tgt) return err(404, 'no_existe');
        if (tgt.role === 'owner') return err(409, 'es_la_duena');
        if (method === 'DELETE') {
          await env.DB.batch([
            env.DB.prepare('UPDATE members SET active = 0 WHERE group_id = ?1 AND id = ?2').bind(gid, tgt.id),
            env.DB.prepare('DELETE FROM invites WHERE group_id = ?1 AND created_by = ?2 AND used = 0').bind(gid, tgt.id)
          ]);
          return json({ ok: true, epoch: grp.epoch });   // la PC de la dueña ahora cambia la clave (POST /log con kind k)
        }
        const b = await bodyOf(req);
        if (!b || !['admin', 'member'].includes(b.role)) return err(400, 'pedido_invalido');
        await env.DB.prepare('UPDATE members SET role = ?1 WHERE group_id = ?2 AND id = ?3').bind(b.role, gid, tgt.id).run();
        return json({ ok: true });
      }

      return err(404, 'no_existe');
    } catch (e) {
      return err(500, 'error_interno');
    }
  }
};
