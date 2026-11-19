// Buzón (Cloudflare Worker): probado en esta PC con una base SQLite que imita a D1
const fs=require('fs'),path=require('path'),{pathToFileURL}=require('url');
const {DatabaseSync}=require('node:sqlite');
let ok=true;const chk=(n,c)=>{console.log((c?'OK  ':'FAIL')+' '+n);if(!c)ok=false};

function d1(db){
  const mk=sql=>{let a=[];const s={bind(...x){a=x;return s},
    run(){const r=db.prepare(sql).run(...a);return {meta:{changes:Number(r.changes)}}},
    first(){return db.prepare(sql).get(...a)||null},
    all(){return {results:db.prepare(sql).all(...a)}}};return s};
  return {prepare:mk,batch(list){   // lote atómico, como D1
    db.exec('BEGIN');try{const out=list.map(s=>s.run());db.exec('COMMIT');return Promise.resolve(out)}catch(e){db.exec('ROLLBACK');throw e}}};
}
(async()=>{
  const mod=await import(pathToFileURL(path.join(__dirname,'..','buzon','worker.js')).href);
  const db=new DatabaseSync(':memory:');db.exec(fs.readFileSync(path.join(__dirname,'..','buzon','schema.sql'),'utf8'));
  const env={DB:d1(db),SETUP_CODE:'creacion-123'};
  const call=async(method,p,{body,token,setup}={})=>{
    const h={'content-type':'application/json'};if(token)h.authorization='Bearer '+token;if(setup)h['x-setup-code']=setup;
    const r=await mod.default.fetch(new Request('https://buzon.test/v1'+p,{method,headers:h,body:body?JSON.stringify(body):undefined}),env);
    return {s:r.status,j:await r.json()};
  };

  chk('ping',(await call('GET','/ping')).j.ok===true);
  chk('crear grupo sin código de creación: rechazado',(await call('POST','/groups')).s===403);
  chk('crear grupo con código malo: rechazado',(await call('POST','/groups',{setup:'x'})).s===403);
  const cr=await call('POST','/groups',{setup:'creacion-123'});
  chk('crear grupo con el código: ok',cr.s===200&&/^[0-9a-f]{32}$/.test(cr.j.group)&&cr.j.code.length===32);
  const G=cr.j.group,g='/groups/'+G;

  // la dueña canjea su invitación
  chk('canje con código inválido: rechazado',(await call('POST',g+'/join',{body:{code:'nope'}})).s===403);
  const own=await call('POST',g+'/join',{body:{code:cr.j.code,label:'cifrado-dueña'}});
  chk('la dueña entra como owner',own.s===200&&own.j.role==='owner'&&own.j.token.includes('.'));
  chk('la invitación vale una sola vez',(await call('POST',g+'/join',{body:{code:cr.j.code}})).s===403);
  const T0=own.j.token;

  // sin credenciales o con credenciales falsas
  chk('sin token: 401',(await call('GET',g+'/log')).s===401);
  chk('token falso: 401',(await call('GET',g+'/log',{token:'0000000000000000.'+'0'.repeat(64)})).s===401);

  // invitar y entrar
  const inv=await call('POST',g+'/invites',{token:T0,body:{}});
  chk('la dueña crea una invitación',inv.s===200&&inv.j.code&&inv.j.expires>Date.now());
  const b1=await call('POST',g+'/join',{body:{code:inv.j.code,label:'cifrado-B'}});
  chk('B entra como member',b1.s===200&&b1.j.role==='member');
  const T1=b1.j.token;
  chk('un member no puede invitar',(await call('POST',g+'/invites',{token:T1,body:{}})).s===403);
  chk('un member no ve la lista de integrantes',(await call('GET',g+'/members',{token:T1})).s===403);
  // vencimiento
  const inv2=await call('POST',g+'/invites',{token:T0,body:{}});
  db.exec("UPDATE invites SET expires=1");
  chk('invitación vencida: rechazada',(await call('POST',g+'/join',{body:{code:inv2.j.code}})).s===403);

  // agregar cambios en orden
  const ap=(tok,after,kind,epoch,blob)=>call('POST',g+'/log',{token:tok,body:{after,kind,epoch,blob}});
  let r=await ap(T0,0,'p',1,'AAA');chk('primer cambio: seq 1',r.s===200&&r.j.seq===1);
  r=await ap(T1,1,'p',1,'BBB');chk('segundo: seq 2',r.s===200&&r.j.seq===2);
  r=await ap(T0,1,'p',1,'CCC');chk('quien no vio lo último: 409 con novedades',r.s===409&&r.j.error==='novedades'&&r.j.head===2);
  r=await ap(T0,2,'p',2,'DDD');chk('época equivocada: 409',r.s===409&&r.j.error==='epoca');
  chk('bloque vacío: rechazado',(await ap(T0,2,'p',1,'')).s===400);
  chk('bloque enorme: rechazado',(await ap(T0,2,'p',1,'x'.repeat(900001))).s===413);
  chk('tipo desconocido: rechazado',(await ap(T0,2,'z',1,'x')).s===400);
  r=await call('GET',g+'/log?after=0',{token:T1});
  chk('leer desde 0 trae todo en orden',r.j.entries.length===2&&r.j.entries[0].seq===1&&r.j.entries[1].seq===2&&r.j.head===2);
  chk('cada cambio dice quién lo mandó',r.j.entries[0].by===own.j.member_id&&r.j.entries[1].by===b1.j.member_id);
  r=await call('GET',g+'/log?after=2',{token:T0});chk('al día: sin novedades',r.j.entries.length===0&&r.j.head===2);

  // foto completa y recorte
  await ap(T0,2,'p',1,'EEE');r=await ap(T0,3,'s',1,'FOTO');
  chk('foto completa: seq 4',r.s===200&&r.j.seq===4);
  const snap=await call('GET',g+'/snapshot',{token:T1});
  chk('la foto se puede bajar',snap.s===200&&snap.j.blob==='FOTO'&&snap.j.seq===4);
  r=await call('GET',g+'/log?after=0',{token:T1});
  chk('quien quedó muy atrás recibe «gap» y parte de la foto',r.j.gap===true&&r.j.first===4&&r.j.entries.length===0);
  r=await call('GET',g+'/log?after=3',{token:T1});chk('quien tiene hasta lo anterior a la foto la recibe directo',!r.j.gap&&r.j.entries.length===1&&r.j.entries[0].kind==='s');
  await ap(T1,4,'p',1,'GGG');

  // tercera persona, dos administradoras y límite de 5
  const mk=async(tok,role)=>{const i=await call('POST',g+'/invites',{token:tok,body:{role}});return call('POST',g+'/join',{body:{code:i.j.code,label:'x'}})};
  const c1=await mk(T0,'admin');chk('la dueña invita a una admin',c1.j.role==='admin');
  chk('una admin no puede crear otra admin',(await call('POST',g+'/invites',{token:c1.j.token,body:{role:'admin'}})).s===403);
  const d1_=await mk(c1.j.token,'member');chk('una admin invita a una member',d1_.j.role==='member');
  const e1=await mk(T0,'member');chk('quinta persona entra',e1.s===200);
  const sexta=await call('POST',g+'/invites',{token:T0,body:{}});
  chk('la sexta persona no entra (máximo 5)',(await call('POST',g+'/join',{body:{code:sexta.j.code}})).s===409);
  const ls=await call('GET',g+'/members',{token:c1.j.token});
  chk('una admin ve la lista (5 activas)',ls.s===200&&ls.j.members.filter(x=>x.active).length===5);

  // quitar gente: solo la dueña
  chk('una admin no puede quitar a nadie',(await call('DELETE',g+'/members/'+b1.j.member_id,{token:c1.j.token})).s===403);
  chk('nadie puede quitar a la dueña',(await call('DELETE',g+'/members/'+own.j.member_id,{token:T0})).s===409);
  chk('un member no puede cambiar roles',(await call('PATCH',g+'/members/'+d1_.j.member_id,{token:T1,body:{role:'admin'}})).s===403);
  r=await call('PATCH',g+'/members/'+d1_.j.member_id,{token:T0,body:{role:'admin'}});chk('la dueña nombra admin a otra',r.s===200);
  r=await call('DELETE',g+'/members/'+b1.j.member_id,{token:T0});chk('la dueña quita a B',r.s===200);
  r=await call('GET',g+'/log?after=0',{token:T1});chk('B quitada: ya no puede leer (403 quitada)',r.s===403&&r.j.error==='quitada');
  r=await ap(T1,5,'p',1,'ZZZ');chk('B quitada: ya no puede escribir',r.s===403);
  chk('al quitar a B entra otra persona (hay lugar)',(await mk(T0,'member')).s===200);

  // cambio de clave: solo la dueña, época +1, y después ya no se acepta la anterior
  const head=(await call('GET',g+'/log?after=99',{token:T0})).j.head;
  chk('una admin no puede cambiar la clave',(await ap(c1.j.token,head,'k',2,'KKK')).s===403);
  r=await ap(T0,head,'k',2,'LLAVES');chk('la dueña cambia la clave (época 2)',r.s===200);
  r=await call('GET',g+'/log?after='+head,{token:T0});chk('la época del grupo subió',r.j.epoch===2);
  r=await ap(c1.j.token,head+1,'p',1,'viejo');chk('con la época vieja: 409',r.s===409&&r.j.error==='epoca');
  r=await ap(c1.j.token,head+1,'p',2,'nuevo');chk('con la época nueva: ok',r.s===200);

  // el buzón no guarda nada legible
  const filas=db.prepare('SELECT blob FROM log').all().map(x=>x.blob).join('');
  chk('el buzón solo tiene los bloques que mandaron las PCs',!/calendario|médico/i.test(filas));
  const toks=db.prepare('SELECT token_hash FROM members').all();
  chk('los tokens se guardan solo como hash',toks.every(t=>t.token_hash===''||(/^[0-9a-f]{64}$/.test(t.token_hash)&&!T0.includes(t.token_hash))));
  // salir por decisión propia
  {const c9=await call('POST','/groups',{setup:'creacion-123'}),g9='/groups/'+c9.j.group;
   const o9=await call('POST',g9+'/join',{body:{code:c9.j.code}});
   const i9=await call('POST',g9+'/invites',{token:o9.j.token,body:{}});const m9=await call('POST',g9+'/join',{body:{code:i9.j.code}});
   const iInv=await call('POST',g9+'/invites',{token:m9.j.token,body:{}});
   chk('la dueña no puede salir por sí misma',(await call('DELETE',g9+'/members/me',{token:o9.j.token})).s===409);
   chk('una integrante sale por su cuenta',(await call('DELETE',g9+'/members/me',{token:m9.j.token})).s===200);
   chk('al salir se libera su lugar',db.prepare('SELECT COUNT(*) n FROM members WHERE group_id=? AND active=1').get(c9.j.group).n===1);
   chk('lo que invitó antes de salir se anula',iInv.s===403||(await call('POST',g9+'/join',{body:{code:iInv.j.code||'x'}})).s===403);
   chk('quien salió ya no entra con su token',(await call('GET',g9+'/log',{token:m9.j.token})).s===403)}
  // --- casos que halló la revisión ---
  {const cr3=await call('POST','/groups',{setup:'creacion-123'}),g3='/groups/'+cr3.j.group;
   const o3=await call('POST',g3+'/join',{body:{code:cr3.j.code}});const To=o3.j.token;
   const inv0=await call('POST',g3+'/invites',{token:To,body:{role:'admin'}});
   const ad=await call('POST',g3+'/join',{body:{code:inv0.j.code}});
   const invAd=await call('POST',g3+'/invites',{token:ad.j.token,body:{}});          // invitación creada por la admin
   await call('DELETE',g3+'/members/'+ad.j.member_id,{token:To});                     // la dueña quita a la admin
   chk('una invitación creada por quien fue quitada deja de valer',(await call('POST',g3+'/join',{body:{code:invAd.j.code}})).s===403);
   const invViva=await call('POST',g3+'/invites',{token:To,body:{}});
   const hd=(await call('GET',g3+'/log?after=0',{token:To})).j.head;
   await call('POST',g3+'/log',{token:To,body:{after:hd,kind:'k',epoch:2,blob:'K'}});
   chk('al cambiar la clave se anulan las invitaciones pendientes (llevan la clave vieja)',(await call('POST',g3+'/join',{body:{code:invViva.j.code}})).s===403);
   const ep=db.prepare('SELECT epoch FROM groups WHERE id=?').get(cr3.j.group).epoch;
   chk('cambio de clave: época del grupo y registro coherentes',ep===2&&db.prepare("SELECT epoch FROM log WHERE group_id=? AND kind='k'").get(cr3.j.group).epoch===2);
   // dos canjes a la vez con 4 integrantes: queda en 5
   const ids=[];for(let i=0;i<3;i++){const iv=await call('POST',g3+'/invites',{token:To,body:{}});await call('POST',g3+'/join',{body:{code:iv.j.code}});}
   const a1=await call('POST',g3+'/invites',{token:To,body:{}}),a2=await call('POST',g3+'/invites',{token:To,body:{}});
   const rs=await Promise.all([a1,a2].map(x=>call('POST',g3+'/join',{body:{code:x.j.code}})));
   chk('dos canjes a la vez con lugar para uno: entra uno solo',db.prepare('SELECT COUNT(*) n FROM members WHERE group_id=? AND active=1').get(cr3.j.group).n===5&&rs.filter(x=>x.s===200).length===1);
   chk('la invitación que no entró no se gasta',db.prepare('SELECT COUNT(*) n FROM invites WHERE group_id=? AND used=0').get(cr3.j.group).n>=1);
   chk('PC adelantada (after > head): gap',(await call('GET',g3+'/log?after=9999',{token:To})).j.gap===true);
   // cuerpo gigante
   const big=await mod.default.fetch(new Request('https://buzon.test/v1'+g3+'/log',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+To,'content-length':'5000000'},body:'{}'}),env);
   chk('cuerpo de 5 MB: 413 sin leerlo',big.status===413);
   // el índice se usa (no recorre todo el registro)
   const plan=db.prepare("EXPLAIN QUERY PLAN SELECT COALESCE((SELECT MAX(seq) FROM log WHERE group_id = ?1), 0) AS h, COALESCE((SELECT MIN(seq) FROM log WHERE group_id = ?1), 0) AS f").all('x').map(r=>r.detail).join(' ');
   chk('la consulta del último número usa el índice',!/SCAN log/.test(plan));
  }
  // respuestas con tope de bytes
  {const cr4=await call('POST','/groups',{setup:'creacion-123'}),g4='/groups/'+cr4.j.group;
   const o4=await call('POST',g4+'/join',{body:{code:cr4.j.code}});const T4=o4.j.token;let hh=0;
   for(let i=0;i<6;i++){const r=await call('POST',g4+'/log',{token:T4,body:{after:hh,kind:'p',epoch:1,blob:'x'.repeat(850000)}});hh=r.j.seq}
   const r=await call('GET',g4+'/log?after=0',{token:T4});
   chk('GET /log no devuelve más de ~4 MB y avisa que hay más',r.j.entries.length>=1&&r.j.entries.length<6&&r.j.more===true&&JSON.stringify(r.j).length<5e6+1000)}
  // otro grupo no se mezcla
  const cr2=await call('POST','/groups',{setup:'creacion-123'});
  chk('un token no sirve en otro grupo',(await call('GET','/groups/'+cr2.j.group+'/log',{token:T0})).s===401);
  chk('ruta inexistente: 404',(await call('GET','/nada')).s===404);
  console.log(ok?'TODO OK':'HAY FALLOS');
  process.exit(ok?0:1);
})().catch(e=>{console.log('FAIL excepción: '+e.stack);console.log('HAY FALLOS');process.exit(1)});
