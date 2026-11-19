// Sincronización entre PCs: hojas, parches, combinación y convergencia
const fs=require('fs'),vm=require('vm');const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[2],'utf8')+';this.api={freshState,blankState,generate,setSlot,splitSlot,joinSlot,addDoctor,addPlant,removePlant,setActive,clearMonth,setQ,setAllow,flat,unflat,fdiff,fapply,syncRebase,syncNormalize,sameVal,monthKeys,slotDoc,computeStats,newId,slotsOf}',ctx);
const A=ctx.api;let ok=true;const chk=(n,c)=>{console.log((c?'OK  ':'FAIL')+' '+n);if(!c)ok=false};
const J=o=>JSON.parse(JSON.stringify(o));
const eq=(a,b)=>A.sameVal(A.flat(a),A.flat(b));

// ---- ida y vuelta: flat/unflat no pierde nada
const st=A.freshState();A.generate(st);
const k0=A.monthKeys(st)[2],k1=A.monthKeys(st)[5];
A.splitSlot(st,k0,'1.h24','d');A.setSlot(st,k0,'1.h24n',3);
st.locks[k1+'|1.h24']=true;st.unavail[4]={[k1]:true};st.closed[2]={[k1]:true};st.ignored['x|y']=true;
A.setQ(st,5,'1.h24',3);A.setQ(st,5,'wk',1);A.setAllow(st,6,'h24',2,false);st.rules=[{doc:1,dow:2,sid:'1.h24'}];
const rt=A.unflat(A.flat(st),st);
chk('flat→unflat→flat idéntico',A.sameVal(A.flat(rt),A.flat(st)));
chk('conserva el orden de los médicos (colores)',rt.doctors.map(d=>d.id).join()===st.doctors.map(d=>d.id).join());
chk('día dividido y candados vuelven',rt.splits[k0+'|1.h24']&&rt.locks[k0+'|1.h24d']&&rt.locks[k0+'|1.h24n']&&rt.assign[k0]['1.h24n']===3&&rt.locks[k1+'|1.h24']);
chk('no cambia el mes que se mira',rt.month===st.month&&rt.year===st.year&&rt.seed===st.seed);
chk('permisos y objetivos vuelven',rt.allow[6].h24[2]===0&&rt.quotas['2026-12']&&1);
chk('diff de lo mismo es vacío',Object.keys(A.fdiff(A.flat(st),A.flat(rt))).length===0);
chk('apply(diff(a,b)) sobre a da b',(()=>{const b=J(st);A.setSlot(b,k1,'2.h24',7);delete b.rules;b.rules=[];const p=A.fdiff(A.flat(st),A.flat(b));return A.sameVal(A.fapply(A.flat(st),p),A.flat(b))})());

// ---- helper: una PC con su base y su estado; el buzón es un arreglo de paquetes
function pc(base){return {st:J(base),base:A.flat(base),by:'x'}}
function push(p,bus,auto){   // como el motor: pone al día, y manda lo propio
  const inc=bus.slice(p.seen||0);
  const r=A.syncRebase(p.base,p.st,inc,auto);
  p.st=r.state;p.base=r.base;p.seen=bus.length;p.notes=(p.notes||[]).concat(r.notes);
  if(Object.keys(r.pend).length){bus.push({by:p.by,auto:!!auto,patch:r.pend});p.base=r.baseAfter;p.seen=bus.length}
}
function pull(p,bus){push(p,bus,false)}
const mk=()=>{const b=A.freshState();A.generate(b);return b};

// 1) claves distintas: entran las dos
{const b=mk(),bus=[],X=pc(b),Y=pc(b);X.by='X';Y.by='Y';const ks=A.monthKeys(b);
 A.setSlot(X.st,ks[1],'1.h24',2);A.setSlot(Y.st,ks[8],'1.h24',9);
 push(X,bus);push(Y,bus);pull(X,bus);
 chk('turnos distintos: ambos entran y quedan iguales',A.slotDoc(X.st,ks[1],'1.h24')===2&&A.slotDoc(X.st,ks[8],'1.h24')===9&&eq(X.st,Y.st));
 chk('turnos distintos: sin avisos de choque',!(Y.notes||[]).some(n=>n.kind==='turno'))}
// 2) mismo turno, valor distinto: gana el último y avisa; todas iguales
{const b=mk(),bus=[],X=pc(b),Y=pc(b),Z=pc(b);X.by='X';Y.by='Y';const k=A.monthKeys(b)[3];
 A.setSlot(X.st,k,'1.h24',2);A.setSlot(Y.st,k,'1.h24',3);
 push(X,bus);push(Y,bus);pull(X,bus);pull(Z,bus);
 chk('mismo turno: queda el último (Y)',A.slotDoc(X.st,k,'1.h24')===3&&A.slotDoc(Z.st,k,'1.h24')===3);
 chk('mismo turno: las tres iguales',eq(X.st,Y.st)&&eq(Y.st,Z.st));
 chk('mismo turno: Y recibe un aviso',(Y.notes||[]).some(n=>n.kind==='turno'&&n.by==='X'&&n.kept==='mine'))}
// 3) mismo valor: sin choque
{const b=mk(),bus=[],X=pc(b),Y=pc(b);const k=A.monthKeys(b)[3];
 A.setSlot(X.st,k,'1.h24',4);A.setSlot(Y.st,k,'1.h24',4);push(X,bus);push(Y,bus);
 chk('mismo turno, mismo valor: sin aviso',!(Y.notes||[]).some(n=>n.kind==='turno'))}
// 4) Reasignar automático contra edición manual: lo manual gana, en los dos órdenes
for(const orden of ['auto-primero','manual-primero']){
 const b=mk(),bus=[],M=pc(b),G=pc(b);M.by='M';G.by='G';const ks=A.monthKeys(b),k=ks[4];
 A.setSlot(M.st,k,'1.h24',8);M.st.locks[k+'|1.h24']=true;
 G.st.seed=99;A.generate(G.st);
 if(orden==='auto-primero'){push(G,bus,true);push(M,bus,false);pull(G,bus)}
 else{push(M,bus,false);push(G,bus,true);pull(M,bus)}
 chk('auto vs manual ('+orden+'): queda lo manual',A.slotDoc(M.st,k,'1.h24')===8&&A.slotDoc(G.st,k,'1.h24')===8&&eq(M.st,G.st))}
// 5) dividir contra día entero: no se mezclan; queda uno u otro completo y coherente
{const b=mk(),bus=[],X=pc(b),Y=pc(b),k=A.monthKeys(b)[6];
 A.splitSlot(X.st,k,'1.h24','d');A.setSlot(X.st,k,'1.h24d',2);A.setSlot(X.st,k,'1.h24n',3);
 A.setSlot(Y.st,k,'1.h24',5);
 push(X,bus);push(Y,bus);pull(X,bus);
 const e=X.st.assign[k]||{};
 chk('dividir vs entero: coherente (sin mezcla)',eq(X.st,Y.st)&&((e['1.h24']===5&&!e['1.h24d']&&!e['1.h24n']&&!X.st.splits[k+'|1.h24'])||(!e['1.h24']&&X.st.splits[k+'|1.h24'])))}
// 6) médico borrado por una; otra le puso un turno sin conexión
{const b=mk(),bus=[],X=pc(b),Y=pc(b),k=A.monthKeys(b)[7];
 X.st.doctors=X.st.doctors.filter(d=>d.id!==6);Object.keys(X.st.assign).forEach(kk=>Object.keys(X.st.assign[kk]).forEach(s=>{if(X.st.assign[kk][s]===6)delete X.st.assign[kk][s]}));
 A.setSlot(Y.st,k,'1.h24',6);Y.st.doctors.find(d=>d.id===6).phone='111';
 push(X,bus);push(Y,bus);pull(X,bus);
 chk('médico borrado vs turno de otra: el turno queda vacío con aviso',!A.slotDoc(Y.st,k,'1.h24')&&(Y.notes||[]).some(n=>n.kind==='sinmedico'));
 chk('médico borrado: no revive sin nombre',!Y.st.doctors.some(d=>d.id===6)&&eq(X.st,Y.st))}
// 7) planta borrada
{const b=mk(),bus=[],X=pc(b),Y=pc(b),k=A.monthKeys(b)[7];
 A.removePlant(X.st,2);A.setSlot(Y.st,k,'2.h24',3);push(X,bus);push(Y,bus);pull(X,bus);
 chk('planta borrada vs turno en ella: no queda basura',!Y.st.plants.some(p=>p.id===2)&&!(Y.st.assign[k]&&Y.st.assign[k]['2.h24'])&&eq(X.st,Y.st))}
// 8) dos altas de médicos sin conexión: ids distintos, no se pisan
{const b=A.blankState(),bus=[],X=pc(b),Y=pc(b);
 const a=A.addDoctor(X.st,{first:'Ana',last:'Uno'}).doc,c=A.addDoctor(Y.st,{first:'Bea',last:'Dos'}).doc;
 push(X,bus);push(Y,bus);pull(X,bus);
 chk('altas sin conexión: ids distintos',a.id!==c.id);
 chk('altas sin conexión: están las dos en las dos PCs',X.st.doctors.length===2&&Y.st.doctors.length===2&&eq(X.st,Y.st))}
// 9) objetivos: dos campos del mismo médico no se pisan; permisos: dos días distintos
{const b=mk(),bus=[],X=pc(b),Y=pc(b);
 A.setQ(X.st,3,'1.h24',4);A.setQ(Y.st,3,'wk',1);A.setAllow(X.st,3,'h24',1,false);A.setAllow(Y.st,3,'h24',4,false);
 push(X,bus);push(Y,bus);pull(X,bus);
 const q=X.st.quotas[X.st.year+'-'+String(X.st.month+1).padStart(2,'0')];
 chk('objetivos de campos distintos: se suman',q&&q[3]&&q[3]['1.h24']===4&&q[3].wk===1);
 chk('permisos de días distintos: se suman',X.st.allow[3].h24[1]===0&&X.st.allow[3].h24[4]===0&&eq(X.st,Y.st))}
// 10) tres PCs, dos sin conexión a la vez y una conectada: terminan iguales
{const b=mk(),bus=[],X=pc(b),Y=pc(b),Z=pc(b),ks=A.monthKeys(b);X.by='X';Y.by='Y';Z.by='Z';
 A.setSlot(X.st,ks[1],'1.h24',1);A.setSlot(X.st,ks[2],'1.h24',1);A.setSlot(Y.st,ks[2],'1.h24',2);A.setSlot(Y.st,ks[10],'1.h12',4);A.setSlot(Z.st,ks[12],'1.h24',5);
 push(Z,bus);push(Y,bus);push(X,bus);pull(Z,bus);pull(Y,bus);pull(X,bus);
 chk('tres PCs, cambios cruzados: iguales',eq(X.st,Y.st)&&eq(Y.st,Z.st))}
// 11) mismo registro aplicado en orden en dos PCs nuevas da lo mismo
{const b=mk(),bus=[],X=pc(b),Y=pc(b),ks=A.monthKeys(b);X.by='X';Y.by='Y';
 A.setSlot(X.st,ks[3],'1.h24',2);A.setSlot(Y.st,ks[3],'1.h24',4);A.setSlot(Y.st,ks[9],'1.h24',7);push(X,bus);push(Y,bus);
 const N1=pc(b),N2=pc(b);pull(N1,bus);pull(N2,bus);
 chk('PC nueva que repite el registro llega al mismo calendario',eq(N1.st,N2.st)&&eq(N1.st,Y.st))}
// 12) idempotencia: nada nuevo, nada cambia
{const b=mk(),bus=[],X=pc(b);const before=J(X.st);pull(X,bus);pull(X,bus);chk('sin novedades no cambia nada',eq(before,X.st)&&bus.length===0)}
// 13) clearMonth (automático) contra turno manual de otra
{const b=mk(),bus=[],X=pc(b),Y=pc(b),k=A.monthKeys(b)[5];X.by='X';Y.by='Y';
 A.setSlot(Y.st,k,'1.h24',6);Y.st.locks[k+'|1.h24']=true;A.clearMonth(X.st,null,false);
 push(Y,bus,false);push(X,bus,true);pull(Y,bus);
 chk('Limpiar mes (auto) no borra lo puesto a mano por otra',A.slotDoc(X.st,k,'1.h24')===6&&eq(X.st,Y.st))}
// 14) la limpieza local NO se reenvía como cambio y no pisa ediciones nuevas de otra (bug hallado en la revisión)
{const b=mk(),bus=[],X=pc(b),Y=pc(b),Z=pc(b),k=A.monthKeys(b)[7];X.by='X';Y.by='Y';Z.by='Z';
 X.st.doctors=X.st.doctors.filter(d=>d.id!==6);push(X,bus);
 A.setSlot(Y.st,k,'1.h12',6);push(Y,bus);
 pull(Z,bus);                       // Z limpia localmente el turno del médico borrado
 A.setSlot(X.st,k,'1.h12',7);push(X,bus);
 push(Z,bus);pull(X,bus);pull(Y,bus);
 chk('la limpieza de Z no pisa lo que X puso después',A.slotDoc(Z.st,k,'1.h12')===7&&A.slotDoc(X.st,k,'1.h12')===7&&eq(X.st,Z.st)&&eq(Y.st,Z.st))}
// 15) día anulado: no queda guardia fantasma aunque otra asigne a la vez
{const b=mk(),bus=[],X=pc(b),Y=pc(b),k=A.monthKeys(b)[9];X.by='X';Y.by='Y';
 X.st.closed[1]={[k]:true};Object.keys(X.st.assign[k]||{}).forEach(s=>{if(s.startsWith('1.'))delete X.st.assign[k][s]});
 A.setSlot(Y.st,k,'1.h24',3);Y.st.locks[k+'|1.h24']=true;
 push(X,bus);push(Y,bus);pull(X,bus);
 const fantasma=['1.h24','1.h12','1.n12','1.h24d','1.h24n'].some(s=>X.st.assign[k]&&X.st.assign[k][s]);
 chk('día anulado: sin médico ni candado fantasma',!fantasma&&!X.st.locks[k+'|1.h24']&&eq(X.st,Y.st))}
// 16) candado huérfano: Reasignar puede volver a llenar el turno
{const b=mk(),bus=[],X=pc(b),Y=pc(b),k=A.monthKeys(b)[7];
 X.st.doctors=X.st.doctors.filter(d=>d.id!==6);Object.keys(X.st.assign).forEach(kk=>Object.keys(X.st.assign[kk]).forEach(s=>{if(X.st.assign[kk][s]===6){delete X.st.assign[kk][s];delete X.st.locks[kk+'|'+s]}}));
 A.setSlot(Y.st,k,'1.h12',6);Y.st.locks[k+'|1.h12']=true;
 push(X,bus);push(Y,bus);pull(X,bus);
 chk('sin médico: tampoco queda candado',!X.st.locks[k+'|1.h12']&&!A.slotDoc(X.st,k,'1.h12'))}
// 17) planta borrada no revive si otra la renombra
{const b=mk(),bus=[],X=pc(b),Y=pc(b);A.removePlant(X.st,2);Y.st.plants.find(p=>p.id===2).name='Terapia';
 push(X,bus);push(Y,bus);pull(X,bus);
 chk('planta borrada no revive al renombrarla otra',!X.st.plants.some(p=>p.id===2)&&!Y.st.plants.some(p=>p.id===2)&&eq(X.st,Y.st))}
// 18) mismo orden de médicos en todas las PCs aunque las altas lleguen cruzadas
{const b=A.blankState(),bus=[],X=pc(b),Y=pc(b);
 A.addDoctor(X.st,{first:'Ana',last:'Uno'});A.addDoctor(Y.st,{first:'Bea',last:'Dos'});
 push(X,bus);push(Y,bus);pull(X,bus);
 chk('mismo orden de médicos en las dos PCs',X.st.doctors.map(d=>d.id).join()===Y.st.doctors.map(d=>d.id).join())}
// 19) lo aceptado en Control (ignored) no viaja
{const b=mk(),bus=[],X=pc(b),Y=pc(b);X.st.ignored['a|b']=true;push(X,bus);pull(Y,bus);
 chk('las excepciones aceptadas en Control quedan en cada PC',bus.length===0&&!Y.st.ignored['a|b']&&X.st.ignored['a|b'])}
chk('ids nuevos no repiten',(()=>{const s=new Set();for(let i=0;i<500;i++){const id=A.newId(s);if(s.has(id))return false;s.add(id)}return true})());
console.log(ok?'TODO OK':'HAY FALLOS');
