const fs=require('fs');const src=fs.readFileSync(process.argv[2],'utf8');
const vm=require('vm');const ctx={};vm.createContext(ctx);vm.runInContext(src+';this.api={freshState,migrate,generate,activeDocs,isActive,setActive,docsInMonth,addDoctors,computeStats,quotaInfo,applyRules,slotsOf,monthKeys,slotDoc,setSlot}',ctx);
const A=ctx.api;let ok=true;const chk=(n,c)=>{console.log((c?'OK  ':'FAIL')+' '+n);if(!c)ok=false};
let st=A.freshState();A.generate(st);
const S0=A.computeStats(st);
chk('todos activos por defecto',A.activeDocs(st).length===10);
// desactivar a 3 médicos
[2,5,9].forEach(id=>A.setActive(st,id,false));
chk('7 activos',A.activeDocs(st).length===7);
A.generate(st);const S1=A.computeStats(st);
chk('inactivos sin guardias tras regenerar',[2,5,9].every(id=>S1[id].hours===0));
let empt=0;A.monthKeys(st).forEach(k=>A.slotsOf(st).forEach(s=>{if(!A.slotDoc(st,k,s))empt++}));
chk('mes completamente cubierto sin ellos (empties='+empt+')',empt===0);
const hs=[1,3,4,6,7,8,10].map(id=>S1[id].hours);console.log('horas activos',hs.join(','));
chk('docsInMonth = solo activos (inactivos sin guardias)',A.docsInMonth(st).length===7);
// inactivo con guardia fijada aparece en docsInMonth
A.setSlot(st,A.monthKeys(st)[0],'1.h24',2);
chk('inactivo con guardia aparece en docsInMonth',A.docsInMonth(st).some(d=>d.id===2));
// regla de un inactivo no se aplica
st.rules=[{doc:5,dow:0,sid:'1.h24'}];A.generate(st);
chk('regla de inactivo no se aplica',A.monthKeys(st).every(k=>A.slotDoc(st,k,'1.h24')!==5));
// reactivar
A.setActive(st,5,true);chk('reactivar borra flag',!('active' in st.doctors.find(d=>d.id===5))&&A.isActive(st,5));
// alta masiva
const n=A.addDoctors(st,'Sebastián Vega\nRita Núñez;  sebastián vega \n\nMaría Sosa');
chk('alta masiva agrega 3 sin repetir (n='+n+')',n===3&&st.doctors.length===13);
// datos viejos: sin campo active, generate idéntico al original
const st2=A.freshState();st2.seed=7;A.generate(st2);
const st3=A.freshState();st3.seed=7;A.generate(st3);
chk('determinista con todos activos',JSON.stringify(st2.assign)===JSON.stringify(st3.assign));
console.log(ok?'TODO OK':'HAY FALLOS');
