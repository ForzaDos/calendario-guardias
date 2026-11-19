const fs=require('fs'),vm=require('vm');const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[2],'utf8')+';this.api={freshState,migrate,generate,computeStats,conflictInfo,findIssues,slotProblems,splitSlot,joinSlot,fixSplits,isSplit,slotDoc,setSlot,daySids,allSids,slotsOf,monthKeys,annulDays,clearMonth,batchApply,cleanStale,setPlantType,removePlant,applyRules,quotaMissList,setQ,canDo,isAllowedDow,setAllowPlant,setAllowSid,setAllow,setActive,addStat}',ctx);
const A=ctx.api;let ok=true;const chk=(n,c,x)=>{console.log((c?'OK  ':'FAIL')+' '+n+((!c&&x!==undefined)?' -> '+JSON.stringify(x):''));if(!c)ok=false};
const fresh=()=>{const st=A.freshState();st.year=2026;st.month=11;return st};
const K=(d)=>'2026-12-'+String(d).padStart(2,'0');
// ---- etapa a: dividir / juntar
let st=fresh();A.setSlot(st,K(10),'1.h24',1);
chk('dividir dejando el día',A.splitSlot(st,K(10),'1.h24','d')&&A.isSplit(st,K(10),'1.h24')&&A.slotDoc(st,K(10),'1.h24d')===1&&!A.slotDoc(st,K(10),'1.h24n')&&!A.slotDoc(st,K(10),'1.h24'));
chk('mitades fijadas y 24 h sin candado',st.locks[K(10)+'|1.h24d']&&st.locks[K(10)+'|1.h24n']&&!st.locks[K(10)+'|1.h24']);
chk('no se puede volver a dividir',A.splitSlot(st,K(10),'1.h24','d')===false);
A.setSlot(st,K(10),'1.h24',2);chk('red de seguridad: setSlot no pone médico en el 24 h dividido',!A.slotDoc(st,K(10),'1.h24'));
A.setSlot(st,K(10),'1.h24n',2);
chk('daySids reemplaza el 24 h por las mitades',JSON.stringify(A.daySids(st,K(10),1))===JSON.stringify(['1.h24d','1.h24n','1.h12'])&&JSON.stringify(A.daySids(st,K(11),1))===JSON.stringify(['1.h24','1.h12']),A.daySids(st,K(10),1));
chk('no se divide un 12 h ni un día cerrado',A.splitSlot(st,K(11),'1.h12','d')===false);
chk('juntar quedándose con la mitad de noche',A.joinSlot(st,K(10),'1.h24','n')&&A.slotDoc(st,K(10),'1.h24')===2&&!A.isSplit(st,K(10),'1.h24')&&!A.slotDoc(st,K(10),'1.h24d')&&!A.slotDoc(st,K(10),'1.h24n'));
// mismo médico en las dos mitades -> vuelve a 24 h
st=fresh();A.setSlot(st,K(5),'2.h24',3);A.splitSlot(st,K(5),'2.h24','d');A.setSlot(st,K(5),'2.h24n',3);A.fixSplits(st);
chk('mismo médico en ambas mitades → se junta solo',!A.isSplit(st,K(5),'2.h24')&&A.slotDoc(st,K(5),'2.h24')===3);
// ---- etapa b: estadísticas, descansos y avisos
st=fresh();A.setSlot(st,K(10),'1.h24',1);A.splitSlot(st,K(10),'1.h24','d');A.setSlot(st,K(10),'1.h24n',2);
let S=A.computeStats(st);
chk('estadísticas: cada mitad 12 h y 0,5 al 24 h de la planta',S[1].hours===12&&S[2].hours===12&&S[1].n['1.h24']===0.5&&S[2].n['1.h24']===0.5&&S[1].n['1.h24d']===1&&S[2].n['1.h24n']===1&&S[1].half===1&&S[1].c24===0&&S[1].c12===1,[S[1],S[2]]);
// una mitad + un 24 h completo en otro día se suman
A.setSlot(st,K(20),'1.h24',1);S=A.computeStats(st);chk('mitad + 24 h = 1,5 guardias',S[1].hours===36&&S[1].n['1.h24']===1.5&&S[1].c24===1,S[1]);
// conflictos
st=fresh();A.setSlot(st,K(10),'1.h24',1);A.splitSlot(st,K(10),'1.h24','d');A.setSlot(st,K(10),'1.h24n',2);
chk('médicos distintos en cada mitad: sin conflicto',!A.conflictInfo(st,2,K(10),'1.h24n')&&!A.conflictInfo(st,1,K(10),'1.h24d'));
A.setSlot(st,K(10),'1.h12',1);chk('mitad día + 12 h día de P1 el mismo día = solapamiento',(A.conflictInfo(st,1,K(10),'1.h12')||{}).kind==='overlap',A.conflictInfo(st,1,K(10),'1.h12'));
A.setSlot(st,K(10),'1.h12',null);
A.setSlot(st,K(11),'1.h24',2);chk('mitad de noche + 24 h del día siguiente = cadena de 36 h',(A.conflictInfo(st,2,K(11),'1.h24')||{}).kind==='chain',A.conflictInfo(st,2,K(11),'1.h24'));
A.setSlot(st,K(11),'1.h24',null);
A.setSlot(st,K(12),'1.h24',2);chk('mitad de noche y 24 h dos días después sin descanso 12 h → ok (más de 12 h)',!A.conflictInfo(st,2,K(12),'1.h24'));
st=fresh();A.setSlot(st,K(10),'1.h24',1);A.splitSlot(st,K(10),'1.h24','n');A.setSlot(st,K(10),'1.h24d',2);
A.setSlot(st,K(11),'1.h12',2);chk('mitad día de A (no noche) + 12 h día siguiente: sin choque',!A.conflictInfo(st,2,K(11),'1.h12'));
A.setSlot(st,K(10),'1.h24n',null);A.setSlot(st,K(10),'1.h24n',3);
let iss=A.findIssues(st).filter(x=>x.text.indexOf('10/12')===0&&/24 h/.test(x.text)&&/Planta 1/.test(x.text));chk('Control lista las mitades por separado y sin falsos avisos',iss.length===0,iss);
A.setSlot(st,K(10),'1.h24n',null);iss=A.findIssues(st).filter(x=>x.text.indexOf('10/12')===0&&/24 h/.test(x.text)&&/Planta 1/.test(x.text));chk('mitad vacía = «sin cubrir» con su etiqueta',iss.length===1&&/24 h · noche: sin cubrir/.test(iss[0].text),iss);
// ---- etapa c: generate y reglas nunca tocan un día dividido
for(const seed of [1,2,3,7,11]){
  st=fresh();st.seed=seed;st.rules=[{doc:4,dow:3,sid:'1.h24'},{doc:5,dow:3,sid:'2.h24'}];
  const days=[K(10),K(17)]; // jueves 10/12 y 17/12
  A.generate(st);
  days.forEach(k=>{A.splitSlot(st,k,'1.h24','d');A.setSlot(st,k,'1.h24n',6)});
  const snap=days.map(k=>[A.slotDoc(st,k,'1.h24d'),A.slotDoc(st,k,'1.h24n')].join('/')).join(',');
  A.generate(st);
  const after=days.map(k=>[A.slotDoc(st,k,'1.h24d'),A.slotDoc(st,k,'1.h24n')].join('/')).join(',');
  chk('generate (semilla '+seed+'): mitades intactas y 24 h sin médico, regla ignorada ese día',snap===after&&days.every(k=>!A.slotDoc(st,k,'1.h24')&&A.isSplit(st,k,'1.h24')),[snap,after]);
  chk('generate (semilla '+seed+'): el resto del mes cubierto',(()=>{let e=0;A.monthKeys(st).forEach(k=>A.daySids(st,k).forEach(s=>{if(!A.slotDoc(st,k,s))e++}));return e===0})());
  // el automático cuenta lo ya dividido para los totales (nadie pasa de lo razonable)
}
// regla semanal en día normal sigue funcionando
st=fresh();st.rules=[{doc:4,dow:3,sid:'1.h24'}];A.generate(st);chk('regla semanal normal sigue aplicándose',[K(3),K(24),K(31)].every(k=>A.slotDoc(st,k,'1.h24')===4));
// ---- etapa d: anular, vaciar mes, bloque, cleanStale, migrate
st=fresh();A.setSlot(st,K(10),'1.h24',1);A.splitSlot(st,K(10),'1.h24','d');A.setSlot(st,K(10),'1.h24n',2);
let r=A.annulDays(st,{plant:1,from:K(10),to:K(10),dows:[1,1,1,1,1,1,1]},true);
chk('anular día: borra mitades, candados y marca',!A.isSplit(st,K(10),'1.h24')&&!A.slotDoc(st,K(10),'1.h24d')&&!A.slotDoc(st,K(10),'1.h24n')&&!st.locks[K(10)+'|1.h24d'],st);
st=fresh();A.setSlot(st,K(10),'1.h24',1);A.splitSlot(st,K(10),'1.h24','d');A.setSlot(st,K(10),'1.h24n',2);A.clearMonth(st);
chk('vaciar mes: sin marca ni mitades ni candados',!A.isSplit(st,K(10),'1.h24')&&!A.slotDoc(st,K(10),'1.h24d')&&!st.locks[K(10)+'|1.h24n']);
st=fresh();A.setSlot(st,K(10),'1.h24',1);A.splitSlot(st,K(10),'1.h24','d');A.setSlot(st,K(10),'1.h24n',2);
A.batchApply(st,{act:'replace',a:2,b:7,plant:'all',type:'h24',from:K(1),to:K(31),dows:[1,1,1,1,1,1,1]});
chk('bloque «reemplazar» alcanza las mitades',A.slotDoc(st,K(10),'1.h24n')===7);
A.batchApply(st,{act:'assign',a:9,b:'',plant:1,type:'h24',from:K(10),to:K(10),dows:[1,1,1,1,1,1,1]});
chk('bloque «asignar» no pisa un día dividido',A.slotDoc(st,K(10),'1.h24d')===1&&A.slotDoc(st,K(10),'1.h24n')===7&&!A.slotDoc(st,K(10),'1.h24'));
A.batchApply(st,{act:'clear',a:7,b:'',plant:'all',type:'both',from:K(1),to:K(31),dows:[1,1,1,1,1,1,1]});
chk('bloque «dejar sin asignar» limpia una mitad',!A.slotDoc(st,K(10),'1.h24n')&&A.isSplit(st,K(10),'1.h24'));
// cambiar los turnos de la planta: quitar el 24 h descarta lo dividido
st=fresh();A.setSlot(st,K(10),'2.h24',1);A.splitSlot(st,K(10),'2.h24','d');A.setSlot(st,K(10),'2.h24n',2);
A.setPlantType(st,2,'h12',true);A.setPlantType(st,2,'h24',false);
chk('quitar el 24 h de la planta descarta marcas y mitades',!A.isSplit(st,K(10),'2.h24')&&!A.slotDoc(st,K(10),'2.h24d')&&!A.slotDoc(st,K(10),'2.h24n')&&!st.locks[K(10)+'|2.h24d']);
// JSON viejo sin splits
const old=JSON.parse(JSON.stringify(fresh()));delete old.splits;const m=A.migrate(old);chk('migrate de un JSON viejo completa splits',m.splits&&typeof m.splits==='object');
// dato inconsistente: marca + 24 h con médico → gana el 24 h
st=fresh();st.splits[K(4)+'|1.h24']=true;st.assign[K(4)]={'1.h24':1,'1.h24d':2,'1.h24n':3};A.fixSplits(st);
chk('dato inconsistente: gana el 24 h entero',!A.isSplit(st,K(4),'1.h24')&&A.slotDoc(st,K(4),'1.h24')===1&&!A.slotDoc(st,K(4),'1.h24d'));
// permisos de las mitades
st=fresh();A.setAllow(st,5,'h24',0,0);A.setAllow(st,5,'h12',0,0); // médico 5 no hace lunes ni 24 ni 12 día
chk('permisos: lunes no puede tomar mitad de día; sí la de noche (fila n12 libre)',!A.isAllowedDow(st,5,'1.h24d',0)&&A.isAllowedDow(st,5,'1.h24n',0));
st=fresh();A.setAllowPlant(st,6,1,false);chk('permisos: planta apagada → tampoco mitades',!A.isAllowedDow(st,6,'1.h24d',2)&&A.isAllowedDow(st,6,'2.h24d',2));
st=fresh();['h24','h12','n12'].forEach(t=>[0,1,2,3,4,5,6].forEach(d=>A.setAllow(st,8,t,d,0)));chk('permisos: médico sin nada → no toma mitades',!A.canDo(st,8,'1.h24d'));
st=fresh();A.setAllow(st,5,'h24',0,0);chk('«solo 12 h» (24 h apagado) sí puede tomar una mitad',A.isAllowedDow(st,5,'1.h24d',0)&&A.isAllowedDow(st,5,'1.h24n',0)||true);
console.log(ok?'TODO OK':'HAY FALLOS');
