// Corre todas las pruebas de la lógica (el núcleo de guardias.html) con Node:  node tests/run.js
const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
const html=fs.readFileSync(path.join(__dirname,'..','guardias.html'),'utf8');
const core=html.match(/\/\/<core>[\s\S]*?\/\/<\/core>/);
if(!core){console.error('No encuentro el núcleo (//<core>) en guardias.html');process.exit(2)}
const tmp=path.join(os.tmpdir(),'guardias_core_'+process.pid+'.js');fs.writeFileSync(tmp,core[0]+String.fromCharCode(10));
let fallas=0;
for(const f of fs.readdirSync(__dirname).filter(x=>/^\d\d-.*\.js$/.test(x)).sort()){
  const r=cp.spawnSync(process.execPath,[path.join(__dirname,f),tmp],{encoding:'utf8'});
  const out=(r.stdout||'')+(r.stderr||'');
  const ok=r.status===0&&!/^FAIL/m.test(out)&&!/HAY FALLOS/.test(out);
  console.log((ok?'OK    ':'FALLA ')+f);
  if(!ok){fallas++;console.log(out.split('\n').filter(l=>/FAIL|Error|HAY/.test(l)).slice(0,8).join('\n'))}
}
fs.unlinkSync(tmp);
console.log(fallas?('\n'+fallas+' archivo(s) con fallas'):'\nTodo bien.');
process.exit(fallas?1:0);
