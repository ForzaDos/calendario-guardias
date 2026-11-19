// Cifrado y ronda de sincronización: 3 PCs contra el buzón real (Worker con una base SQLite que imita a D1)
const fs=require('fs'),vm=require('vm'),path=require('path'),{pathToFileURL}=require('url');
const {DatabaseSync}=require('node:sqlite');
let ok=true;const chk=(n,c)=>{console.log((c?'OK  ':'FAIL')+' '+n);if(!c)ok=false};
const ctx={crypto:globalThis.crypto,btoa,atob,Blob,Response,CompressionStream,DecompressionStream,TextEncoder,TextDecoder};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[2],'utf8')+';this.api={freshState,blankState,generate,setSlot,flat,unflat,fdiff,syncRound,syncSeal,syncOpen,syncAad,syncNewKey,monthKeys,slotDoc,sameVal,addDoctor}',ctx);
const A=ctx.api;
const J=o=>JSON.parse(JSON.stringify(o));
const eq=(a,b)=>A.sameVal(A.flat(a),A.flat(b));
function d1(db){const mk=sql=>{let a=[];const s={bind(...x){a=x;return s},run(){const r=db.prepare(sql).run(...a);return {meta:{changes:Number(r.changes)}}},first(){return db.prepare(sql).get(...a)||null},all(){return {results:db.prepare(sql).all(...a)}}};return s};
  return {prepare:mk,batch(l){db.exec('BEGIN');try{const o=l.map(s=>s.run());db.exec('COMMIT');return Promise.resolve(o)}catch(e){db.exec('ROLLBACK');throw e}}}}

(async()=>{
  // ---------- cifrado ----------
  const k=A.syncNewKey(),aad=A.syncAad('g1',1,'s',7);
  const obj={v:1,f:{'T|2026-11-01|1.h24':{doc:3}},nom:'ñandú ✓'};
  const b1=await A.syncSeal(k,obj,aad),b2=await A.syncSeal(k,obj,aad);
  chk('cifrar y abrir devuelve lo mismo',JSON.stringify(await A.syncOpen(k,b1,aad))===JSON.stringify(obj));
  chk('el IV es distinto en cada cifrado',b1!==b2);
  let fallo=false;try{await A.syncOpen(k,b1,A.syncAad('g1',1,'s',8))}catch(e){fallo=true}
  chk('si cambia el número del encabezado, no abre',fallo);
  fallo=false;try{await A.syncOpen(k,b1,A.syncAad('g2',1,'s',7))}catch(e){fallo=true}chk('si cambia el grupo, no abre',fallo);
  fallo=false;try{await A.syncOpen(A.syncNewKey(),b1,aad)}catch(e){fallo=true}chk('con otra clave, no abre',fallo);
  const st0=A.freshState();A.generate(st0);const gran=await A.syncSeal(k,{v:1,f:A.flat(st0)},aad);
  chk('un calendario completo comprimido y cifrado pesa poco ('+Math.round(gran.length/1024)+' KB)',gran.length<120000);
  chk('el texto cifrado no contiene los nombres',!Buffer.from(gran,'base64').toString('latin1').includes(A.freshState().doctors[0].name));

  // ---------- buzón y PCs ----------
  const mod=await import(pathToFileURL(path.join(__dirname,'..','buzon','worker.js')).href);
  const db=new DatabaseSync(':memory:');db.exec(fs.readFileSync(path.join(__dirname,'..','buzon','schema.sql'),'utf8'));
  const env={DB:d1(db),SETUP_CODE:'c'};
  const raw=async(method,p,{body,token,setup}={})=>{const h={'content-type':'application/json'};if(token)h.authorization='Bearer '+token;if(setup)h['x-setup-code']=setup;
    const r=await mod.default.fetch(new Request('https://b.test/v1'+p,{method,headers:h,body:body?JSON.stringify(body):undefined}),env);return {s:r.status,j:await r.json()}};
  const cr=await raw('POST','/groups',{setup:'c'});const G=cr.j.group;
  const key=A.syncNewKey();
  const mkpc=async(codeIn,state,adopt)=>{
    const j=await raw('POST','/groups/'+G+'/join',{body:{code:codeIn}});
    const pc={S:state,token:j.j.token,off:false,commits:0,cl:{g:G,token:j.j.token,k:key,epoch:1,base:{},seen:0,adopt:!!adopt},mid:null};
    pc.io=async(m,p,b)=>{if(pc.off)return {s:0,j:{}};const r=await raw(m,p,{body:b,token:pc.token});if(pc.mid){const f=pc.mid;pc.mid=null;f()}return r};
    pc.hooks={getS:()=>pc.S,commit:(s,cl)=>{if(s)pc.S=s;pc.commits++;pc.saved=J(cl)},nom:'x'};
    pc.round=()=>A.syncRound(pc.cl,pc.io,pc.hooks);
    return pc;
  };
  const inv=async()=>(await raw('POST','/groups/'+G+'/invites',{token:T0,body:{}})).j.code;
  const own=await raw('POST','/groups/'+G+'/join',{body:{code:cr.j.code}});const T0=own.j.token;
  const base0=A.freshState();A.generate(base0);
  const P1=await(async()=>{const pc={S:J(base0),token:T0,off:false,commits:0,cl:{g:G,token:T0,k:key,epoch:1,base:{},seen:0,adopt:false}};
    pc.io=async(m,p,b)=>{if(pc.off)return {s:0,j:{}};const r=await raw(m,p,{body:b,token:pc.token});if(pc.mid){const f=pc.mid;pc.mid=null;f()}return r};
    pc.hooks={getS:()=>pc.S,commit:(s,cl)=>{if(s)pc.S=s;pc.commits++;pc.saved=J(cl)},nom:'dueña'};pc.round=()=>A.syncRound(pc.cl,pc.io,pc.hooks);return pc})();

  const P2=await mkpc(await inv(),A.blankState(),true),P3=await mkpc(await inv(),A.blankState(),true);
  let r=await P2.round();chk('unida con el buzón vacío: «esperando»',r.status==='esperando'&&P2.cl.adopt===true);
  r=await P1.round();chk('la dueña sube su calendario (primera foto)',r.status==='ok'&&r.subio&&P1.cl.seen===1);
  r=await P2.round();chk('la otra PC adopta el calendario de la dueña',r.status==='ok'&&P2.cl.adopt===false&&eq(P2.S,P1.S));
  r=await P3.round();chk('la tercera también',eq(P3.S,P1.S));
  chk('sin cambios no se sube nada',(await P1.round()).subio===false&&P1.cl.seen===1);
  const ks=A.monthKeys(P1.S);

  // simultáneas en turnos distintos
  A.setSlot(P2.S,ks[1],'1.h24',2);A.setSlot(P3.S,ks[8],'1.h24',9);
  await Promise.all([P2.round(),P3.round()]);await P2.round();await P3.round();await P1.round();await P2.round();
  chk('edición simultánea en turnos distintos: las tres iguales con los dos cambios',eq(P1.S,P2.S)&&eq(P2.S,P3.S)&&A.slotDoc(P1.S,ks[1],'1.h24')===2&&A.slotDoc(P1.S,ks[8],'1.h24')===9);

  // mismo turno, valores distintos: gana el último en llegar y todas quedan iguales
  A.setSlot(P2.S,ks[3],'1.h24',4);A.setSlot(P3.S,ks[3],'1.h24',5);
  await P2.round();const rr=await P3.round();await P2.round();await P1.round();
  chk('mismo turno: queda lo último y las tres iguales',eq(P1.S,P2.S)&&eq(P2.S,P3.S)&&A.slotDoc(P1.S,ks[3],'1.h24')===5);
  chk('mismo turno: la que perdió el empate recibió un aviso',rr.notes.some(n=>n.kind==='turno'));

  // edición mientras la ronda espera la red: no se pierde
  A.setSlot(P1.S,ks[4],'1.h24',6);
  P2.mid=()=>A.setSlot(P2.S,ks[10],'1.h12',7);
  await P1.round();await P2.round();
  chk('lo editado durante el pedido sigue en la PC',A.slotDoc(P2.S,ks[10],'1.h12')===7&&A.slotDoc(P2.S,ks[4],'1.h24')===6);
  await P2.round();await P1.round();await P3.round();
  chk('y en la ronda siguiente llega a las demás',eq(P1.S,P2.S)&&eq(P2.S,P3.S)&&A.slotDoc(P3.S,ks[10],'1.h12')===7);

  // sin conexión
  P3.off=true;A.setSlot(P3.S,ks[12],'1.h24',8);r=await P3.round();
  chk('sin conexión: estado «red» y no se pierde nada',r.status==='red'&&A.slotDoc(P3.S,ks[12],'1.h24')===8);
  A.setSlot(P1.S,ks[13],'1.h24',3);await P1.round();
  P3.off=false;await P3.round();await P1.round();await P2.round();
  chk('al volver la conexión se pasa todo y quedan iguales',eq(P1.S,P2.S)&&eq(P2.S,P3.S)&&A.slotDoc(P1.S,ks[12],'1.h24')===8&&A.slotDoc(P3.S,ks[13],'1.h24')===3);

  // PC que quedó muy atrás (el buzón ya recortó): arranca de la última foto
  const vieja=J(P2.cl);for(let i=0;i<4;i++){A.setSlot(P1.S,ks[14+i],'1.h24',i+1);await P1.round()}
  P2.cl=vieja;r=await P2.round();
  chk('PC muy atrás (gap): se pone al día',r.status==='ok'&&eq(P1.S,P2.S));

  // corte justo después de subir: se reinicia con la base vieja y no se rompe nada
  const antes=J(P2.cl);A.setSlot(P2.S,ks[20],'1.h24',9);await P2.round();const despues=J(P2.S);
  P2.cl=antes;r=await P2.round();
  chk('si se corta la luz tras subir, la entrada propia vuelve y no cambia nada',r.status==='ok'&&eq(P2.S,despues));
  await P1.round();await P3.round();chk('…y las demás igual',eq(P1.S,P2.S)&&eq(P2.S,P3.S));

  // clave equivocada: se frena sin avanzar
  const mala=await mkpc(await inv(),A.blankState(),true);mala.cl.k=A.syncNewKey();const sBefore=mala.cl.seen;
  r=await mala.round();chk('clave equivocada: error y no avanza',r.status==='error'&&mala.cl.seen===sBefore);

  // el buzón vuelve atrás (restaurado de una copia vieja)
  const hs=db.prepare('SELECT MAX(seq) h FROM log WHERE group_id=?').get(G).h;
  db.prepare('DELETE FROM log WHERE group_id=?').run(G);
  chk('(el buzón se vació; las PCs tenían visto hasta el '+hs+')',P1.cl.seen>0);
  r=await P1.round();chk('buzón que volvió atrás: la dueña vuelve a subir lo suyo',r.status==='ok'&&r.subio);
  r=await P2.round();await P3.round();await P1.round();
  chk('…y las demás no pierden nada ni pisan lo propio',eq(P1.S,P2.S)&&eq(P2.S,P3.S)&&A.slotDoc(P2.S,ks[12],'1.h24')===8);

  // quitar a una persona
  const rem=await raw('GET','/groups/'+G+'/members',{token:T0});
  const idB=rem.j.members.find(m=>m.id!==own.j.member_id&&P3.token.startsWith(m.id)).id;
  await raw('DELETE','/groups/'+G+'/members/'+idB,{token:T0});
  r=await P3.round();chk('persona quitada: «quitada» (y conserva lo que tenía)',r.status==='quitada'&&A.slotDoc(P3.S,ks[12],'1.h24')===8);

  // varias rondas en paralelo con cambios cruzados: terminan iguales
  A.setSlot(P1.S,ks[22],'1.h24',1);A.setSlot(P2.S,ks[23],'1.h24',2);A.setSlot(P2.S,ks[22],'1.h24',3);
  for(let i=0;i<3;i++){await Promise.all([P1.round(),P2.round()])}
  chk('rondas simultáneas: las dos iguales',eq(P1.S,P2.S));
  console.log(ok?'TODO OK':'HAY FALLOS');process.exit(ok?0:1);
})().catch(e=>{console.log('FAIL excepción: '+e.stack);console.log('HAY FALLOS');process.exit(1)});
