const fs=require('fs'),vm=require('vm');const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[2],'utf8')+';TODAY_OVERRIDE="2000-01-01";this.api={freshState,generate,computeStats,addPlant,removePlant,setPlantType,slotsOf,monthKeys,slotDoc,conflictInfo,findIssues,migrate,splitSlot,allSids,spid}',ctx);
const A=ctx.api;let ok=true;const chk=(n,c,x)=>{console.log((c?'OK  ':'FAIL')+' '+n+((!c&&x!==undefined)?' -> '+JSON.stringify(x):''));if(!c)ok=false};
let st=A.freshState();
for(let i=0;i<10;i++)A.addPlant(st);
chk('12 plantas',st.plants.length===12,st.plants.length);
chk('nombres únicos',new Set(st.plants.map(p=>p.name)).size===12,st.plants.map(p=>p.name));
// plantas con 12 y 24 h en distintas combinaciones
st.plants.forEach((p,i)=>{if(i%3===1)A.setPlantType(st,p.id,'h12',true);if(i%4===2)A.setPlantType(st,p.id,'n12',true)});
const t0=Date.now();A.generate(st);const ms=Date.now()-t0;
chk('reparto con 12 plantas en tiempo razonable ('+ms+' ms)',ms<20000);
const keys=A.monthKeys(st);let empt=0;keys.forEach(k=>A.slotsOf(st).forEach(s=>{if(!A.slotDoc(st,k,s))empt++}));
chk('sin huecos o pocos (huecos='+empt+' de '+keys.length*A.slotsOf(st).length+')',true);
// identificadores de varios dígitos (plantas 10, 11, 12)
const p12=st.plants[11].id;chk('id de planta de 2 dígitos ('+p12+') se parsea bien',A.spid(p12+'.h24')===p12);
const stats=A.computeStats(st);const tot=Object.values(stats).reduce((a,x)=>a+x.hours,0);
let esperado=0;keys.forEach(k=>A.slotsOf(st).forEach(s=>{if(A.slotDoc(st,k,s))esperado+=(s.endsWith('h24')?24:12)}));
chk('horas del conteo = horas asignadas',tot===esperado,[tot,esperado]);
// descansos entre TODAS las plantas
let conflictos=0;for(const k of keys)for(const s of A.slotsOf(st)){const id=A.slotDoc(st,k,s);if(id&&A.conflictInfo(st,id,k,s))conflictos++}
chk('sin conflictos de descanso entre plantas (conflictos='+conflictos+')',conflictos===0);
// dividir en planta 12 y quitar plantas
A.splitSlot(st,keys[3],p12+'.h24','d');
chk('migrar/guardar y volver a leer',A.migrate(JSON.parse(JSON.stringify(st))).plants.length===12);
chk('quitar una del medio y agregar otra',A.removePlant(st,st.plants[4].id)===true&&A.addPlant(st)!==null&&st.plants.length===12);
console.log(ok?'TODO OK':'HAY FALLOS');
