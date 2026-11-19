-- Buzón cifrado del calendario de guardias (Cloudflare D1).
-- El buzón guarda bloques cifrados que arman las PCs; no tiene forma de leerlos.
CREATE TABLE IF NOT EXISTS groups (
  id      TEXT PRIMARY KEY,
  epoch   INTEGER NOT NULL DEFAULT 1,      -- sube cada vez que se cambia la clave (al quitar a alguien)
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  group_id   TEXT NOT NULL,
  id         TEXT NOT NULL,
  role       TEXT NOT NULL,                -- owner | admin | member
  label      TEXT NOT NULL DEFAULT '',     -- nombre cifrado por la PC (el buzón no lo entiende)
  token_hash TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created    INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, id)
);
CREATE TABLE IF NOT EXISTS invites (
  group_id  TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  role      TEXT NOT NULL,
  expires   INTEGER NOT NULL,
  used      INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT '',     -- quién la creó (si a esa persona la quitan, su invitación se anula)
  PRIMARY KEY (group_id, code_hash)
);
CREATE TABLE IF NOT EXISTS log (
  group_id  TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  member_id TEXT NOT NULL,
  kind      TEXT NOT NULL,                 -- p = cambios, s = foto completa, k = cambio de clave
  epoch     INTEGER NOT NULL,
  blob      TEXT NOT NULL,                 -- contenido cifrado (base64)
  t         INTEGER NOT NULL,
  PRIMARY KEY (group_id, seq)
);
