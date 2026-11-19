const fs=require('fs'),vm=require('vm');const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[2],'utf8')+';TODAY_OVERRIDE="2026-12-15";this.api={freshState,generate,monthKeys,slotDoc,setSlot,setActive,addPlant,removePlant,setPlantType,applyRules,clearMonth,annulDays,batchApply,slotsOf,pastWork,pastWorkDoc}',ctx);
const A=ctx.api;let ok=true;const chk=(n,c,x)=>{console.log((c?'OK  ':'FAIL')+' '+n+((!c&&x!==undefined)?' -> '+JSON.stringify(x):''));if(!c)ok=false};
let st=A.freshState();A.generate(st);const keys=A.monthKeys(st),past=keys[3];
const snap=()=>JSON.stringify(keys.map(k=>A.slotsOf(st).map(s=>A.slotDoc(st,k,s))));
// el administrador puede cambiar un turno en curso o pasado
const doc=A.slotDoc(st,past,'1.h24');const otro=doc===2?3:2;A.setSlot(st,past,'1.h24',otro);
chk('se puede cambiar un turno de un día pasado a mano',A.slotDoc(st,past,'1.h24')===otro);
// Reasignar puede rehacer todo el mes (los días sin fijar)
const b=snap();st.seed=77;A.generate(st);chk('reasignar rehace también los días anteriores a hoy',snap()!==b);
chk('reasignar cubre todo el mes',keys.every(k=>A.slotsOf(st).every(s=>A.slotDoc(st,k,s))));
// limpiar mes vacía todo
A.clearMonth(st,null);chk('limpiar mes vacía también lo pasado',keys.every(k=>A.slotsOf(st).every(s=>!A.slotDoc(st,k,s))));
st=A.freshState();A.generate(st);
// anular y cambio por bloque llegan a días pasados
const an=A.annulDays(st,{plant:'all',from:keys[0],to:keys[3],dows:[1,1,1,1,1,1,1]},true);chk('anular días llega al pasado',an.n>0&&!A.slotDoc(st,keys[1],'1.h24'),an);
const bp=A.batchApply(st,{act:'clear',a:'',b:'',plant:'all',type:'both',from:keys[5],to:keys[8],dows:[1,1,1,1,1,1,1]});chk('cambio por bloque llega al pasado',!A.slotDoc(st,keys[6],'1.h24'),bp);
// quitar planta/turno se puede (la pantalla avisa y confirma)
st=A.freshState();A.generate(st);chk('hay trabajo cargado que contar',A.pastWork(st,1,null)>0);
chk('quitar un tipo de turno con guardias cargadas se puede',A.setPlantType(st,1,'h12',false)===true);
chk('quitar una planta con guardias cargadas se puede',A.removePlant(st,1)===true);
console.log(ok?'TODO OK':'HAY FALLOS');
