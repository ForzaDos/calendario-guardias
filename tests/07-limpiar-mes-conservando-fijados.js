const fs=require('fs'),vm=require('vm');const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[2],'utf8')+';this.api={freshState,generate,monthKeys,slotDoc,setSlot,clearMonth,splitSlot,isSplit,slotsOf,allSids}',ctx);
const A=ctx.api;let ok=true;const chk=(n,c,x)=>{console.log((c?'OK  ':'FAIL')+' '+n+((!c&&x!==undefined)?' -> '+JSON.stringify(x):''));if(!c)ok=false};
let st=A.freshState();A.generate(st);const ks=A.monthKeys(st);
// fijar 3 turnos (uno de otra planta) y dividir un día dejando una mitad fijada
const fix=[[ks[2],'1.h24'],[ks[5],'1.h12'],[ks[9],'2.h24']];fix.forEach(([k,s])=>{st.locks[k+'|'+s]=true});
const doc0=fix.map(([k,s])=>A.slotDoc(st,k,s));
A.splitSlot(st,ks[12],'1.h24','d');A.setSlot(st,ks[12],'1.h24n',4);st.locks[ks[12]+'|1.h24n']=true;
const mitadFija=A.slotDoc(st,ks[12],'1.h24n');
const copia=JSON.stringify(st);
// 1) conservar fijados
A.clearMonth(st,null,true);
chk('los 3 fijados siguen en su lugar con el mismo médico',fix.every(([k,s],i)=>A.slotDoc(st,k,s)===doc0[i]&&st.locks[k+'|'+s]));
chk('la mitad fijada se conserva y el día sigue dividido',A.isSplit(st,ks[12],'1.h24')&&A.slotDoc(st,ks[12],'1.h24n')===mitadFija&&st.locks[ks[12]+'|1.h24n']);
let resto=0;ks.forEach(k=>A.allSids(st).forEach(s=>{if(A.slotDoc(st,k,s)&&!st.locks[k+'|'+s])resto++}));
chk('todo lo que no tenía candado quedó vacío (restantes sin candado='+resto+')',resto===0);
const conLugar=ks.reduce((n,k)=>n+A.allSids(st).filter(s=>A.slotDoc(st,k,s)).length,0);
const conCandado=ks.reduce((n,k)=>n+A.allSids(st).filter(s=>A.slotDoc(st,k,s)&&st.locks[k+'|'+s]).length,0);chk('quedan solo los turnos con candado (3 fijados + las 2 mitades, que se fijan solas) = '+conLugar,conLugar===5&&conCandado===5,[conLugar,conCandado]);
// 2) solo una planta: la otra no se toca y su fijado queda
st=JSON.parse(copia);A.clearMonth(st,2,true);
chk('limpiar solo planta 2 conservando fijados: el fijado de planta 2 queda',A.slotDoc(st,ks[9],'2.h24')===doc0[2]);
chk('y la planta 1 no se tocó',A.slotDoc(st,ks[2],'1.h24')===JSON.parse(copia).assign[ks[2]]['1.h24']&&A.slotDoc(st,ks[4],'1.h24')===JSON.parse(copia).assign[ks[4]]['1.h24']);
// 3) sin la opción: borra todo, como siempre
st=JSON.parse(copia);A.clearMonth(st,null);
chk('sin la opción: se borra todo, incluidos los fijados y la división',!A.slotDoc(st,ks[2],'1.h24')&&Object.keys(st.locks).length===0&&!A.isSplit(st,ks[12],'1.h24'));
console.log(ok?'TODO OK':'HAY FALLOS');
