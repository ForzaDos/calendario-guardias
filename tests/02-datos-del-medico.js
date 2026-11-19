const fs=require('fs'),vm=require('vm');const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[2],'utf8')+';this.api={freshState,addDoctor,setDocField,docFirst,docLast,nameParts,emailOk,surname}',ctx);
const A=ctx.api;let ok=true;const chk=(n,c)=>{console.log((c?'OK  ':'FAIL')+' '+n);if(!c)ok=false};
const st=A.freshState();
const d1=st.doctors[0]; // Ana Pérez (solo name)
chk('deduce nombre/apellido viejos',A.docFirst(d1)==='Ana'&&A.docLast(d1)==='Pérez');
const dj=st.doctors[1];dj.name='Marta De Luca';delete dj.first;delete dj.last;   // médico viejo con partícula en el apellido
chk('partículas: Marta De Luca',A.docFirst(dj)==='Marta'&&A.docLast(dj)==='De Luca');
chk('editar apellido actualiza name',A.setDocField(st,d1.id,'last','Pérez Rossi')&&d1.name==='Ana Pérez Rossi'&&d1.first==='Ana');
chk('editar nombre',A.setDocField(st,d1.id,'first','Anita')&&d1.name==='Anita Pérez Rossi');
A.setDocField(st,d1.id,'first','');chk('vaciar nombre deja apellido',d1.name==='Pérez Rossi');A.setDocField(st,d1.id,'first','Anita');
const before=d1.name;A.setDocField(st,d1.id,'last','');chk('vaciar apellido deja nombre',d1.name==='Anita');
chk('vaciar ambos se rechaza y conserva',A.setDocField(st,d1.id,'first','')===false&&d1.name==='Anita');
A.setDocField(st,d1.id,'phone',' 11  1234 5678 ');chk('teléfono limpio',d1.phone==='11 1234 5678');
A.setDocField(st,d1.id,'phone','');chk('teléfono vacío se borra',!('phone' in d1));
const r=A.addDoctor(st,{first:' Ana ',last:'Pérez',phone:'111',mat:'MP 123',email:'ana@x.com'});
chk('alta completa',r.doc&&r.doc.name==='Ana Pérez'&&r.doc.mat==='MP 123'&&r.doc.email==='ana@x.com'&&Number.isInteger(r.doc.id)&&!st.doctors.some(d=>d!==r.doc&&d.id===r.doc.id));
chk('alta duplicada rechazada',!!A.addDoctor(st,{first:'ana',last:'pérez'}).err);
chk('alta sin nombre rechazada',!!A.addDoctor(st,{first:'',last:'',mat:'1'}).err);
chk('solo apellido',A.addDoctor(st,{last:'Gomez'}).doc.name==='Gomez');
chk('email válido/ inválido',A.emailOk('a@b.co')&&A.emailOk('')&&!A.emailOk('abc')&&!A.emailOk('a@b'));
chk('nameParts viejo',A.nameParts(dj).sur==='De Luca'&&A.nameParts(dj).first==='Marta');
chk('nameParts nuevo',A.nameParts(r.doc).sur==='Pérez'&&A.nameParts(r.doc).first==='Ana');
console.log(ok?'TODO OK':'HAY FALLOS');
