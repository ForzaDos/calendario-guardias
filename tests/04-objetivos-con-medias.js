const fs=require('fs'),vm=require('vm');const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[2],'utf8')+';this.api={freshState,generate,computeStats,splitSlot,setSlot,setQ,quotaMissList,slotDoc,monthKeys,fixSplits}',ctx);
const A=ctx.api;let ok=true;const chk=(n,c)=>{console.log((c?'OK  ':'FAIL')+' '+n);if(!c)ok=false};
let st=A.freshState();A.generate(st);
// médico 1: objetivo 5 en P1 24 h; le damos una mitad a mano para que tenga 4,5
const ks=A.monthKeys(st);
A.setQ(st,1,'1.h24',5);
for(let seed=1;seed<=5;seed++){st.seed=seed;A.generate(st);const n=A.computeStats(st)[1].n['1.h24']||0;chk('semilla '+seed+': no pasa el objetivo 5 (tiene '+n+')',n<=5+1e-9)}
// con 4,5 reales y objetivo 5 el aviso aparece escrito con coma; con objetivo 4,5 no aparece
const k=ks.find(k=>A.slotDoc(st,k,'1.h24')===1);A.splitSlot(st,k,'1.h24','d');
const n0=A.computeStats(st)[1].n['1.h24'];
A.setQ(st,1,'1.h24',n0);chk('objetivo = lo hecho ('+n0+') -> sin aviso',!A.quotaMissList(st).some(x=>x.id.endsWith('|1|1.h24')));
A.setQ(st,1,'1.h24',n0+1);chk('objetivo distinto -> avisa con coma',A.quotaMissList(st).some(x=>x.id.endsWith('|1|1.h24')&&/objetivo es \d+(,5)?$/.test(x.text)));
console.log(ok?'TODO OK':'HAY FALLOS');
