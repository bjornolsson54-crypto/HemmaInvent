'use strict';
const $=id=>document.getElementById(id), cfg=window.HEMMA_CONFIG||{};
const configured=/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(cfg.supabaseUrl||'') && cfg.supabaseAnonKey && !cfg.supabaseAnonKey.startsWith('DIN_');
const api=(cfg.supabaseUrl||'').replace(/\/$/,'');
let db,session=null,records=[],activeId=null,mode='local',busy=false;
const escapeHTML=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fields=['name','category','brand','model','serial','location','purchaseDate','price','store','warrantyEnd','notes'];
function status(s,error=false){$('status').textContent=s;$('status').className='status'+(error?' error':'');}
function openDB(){return new Promise((res,rej)=>{let r=indexedDB.open('hemmainvent-v2',1);r.onupgradeneeded=()=>{let d=r.result;d.createObjectStore('records',{keyPath:'id'});d.createObjectStore('settings',{keyPath:'key'});};r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});}
function store(name,method='readonly'){return db.transaction(name,method).objectStore(name);}
function all(name){return new Promise((res,rej)=>{let r=store(name).getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});}
function getSetting(key){return new Promise((res,rej)=>{let r=store('settings').get(key);r.onsuccess=()=>res(r.result?.value);r.onerror=()=>rej(r.error);});}
function put(name,value){return new Promise((res,rej)=>{let r=store(name,'readwrite').put(value);r.onsuccess=()=>res();r.onerror=()=>rej(r.error);});}
async function saveSetting(key,value){await put('settings',{key,value});}
function userScope(){return session?.user?.id||'local';}
async function refreshList(){records=(await all('records')).filter(r=>r.owner===userScope());render();}
function showApp(){ $('auth').classList.add('hidden');$('app').classList.remove('hidden');$('settings').classList.add('hidden');$('editor').classList.add('hidden');$('overview').classList.remove('hidden');$('who').textContent=session?'Inloggad som '+session.user.email:'Lokalt läge – ingen automatisk synkning';refreshList();}
function warranty(r){if(!r.warrantyEnd)return '';let days=Math.ceil((new Date(r.warrantyEnd+'T12:00:00')-new Date())/86400000);return days<0?'<span class="pill bad">Garanti slut</span>':days<=30?'<span class="pill warn">Garanti går snart ut</span>':'<span class="pill">Garanti gäller</span>';}
// View state only: inventory records and the database format stay unchanged.
const categoryOpenState=new Map();
const categoryName=r=>String(r.category??'').trim()||'Övrigt';
function render(){
const visible=records.filter(r=>!r.deleted),term=$('search').value.toLowerCase(),selectedCategory=$('categoryFilter').value;
$('count').textContent=visible.length;$('expiring').textContent=visible.filter(r=>r.warrantyEnd&&((new Date(r.warrantyEnd+'T12:00:00')-new Date())/86400000)>=0&&((new Date(r.warrantyEnd+'T12:00:00')-new Date())/86400000)<=30).length;
const cats=[...new Set(visible.map(categoryName))].sort((a,b)=>a.localeCompare(b,'sv'));
$('categoryFilter').innerHTML='<option value="">Alla kategorier</option>'+cats.map(c=>`<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join('');
const category=cats.includes(selectedCategory)?selectedCategory:'';
$('categoryFilter').value=category;
const found=visible.filter(r=>(!category||categoryName(r)===category)&&[r.name,r.brand,r.model,categoryName(r),r.serial,r.location].join(' ').toLowerCase().includes(term)).sort((a,b)=>a.name.localeCompare(b.name,'sv'));
$('list').replaceChildren();if(!found.length){$('list').innerHTML='<div class="card muted">Inga inventarier hittades.</div>';return;}
const groups=new Map();
for(const r of found){const name=categoryName(r);if(!groups.has(name))groups.set(name,[]);groups.get(name).push(r);}
for(const name of cats){
  const items=groups.get(name);if(!items)continue;
  const group=document.createElement('details');group.className='category-group';
  group.open=!!term||categoryOpenState.get(name)===true;
  const summary=document.createElement('summary');summary.className='category-summary';
  const title=document.createElement('span');title.className='category-title';title.textContent=name;
  const count=document.createElement('span');count.className='category-count';count.textContent=items.length+' '+(items.length===1?'inventarie':'inventarier');
  summary.append(title,count);group.append(summary);
  const content=document.createElement('div');content.className='category-items';group.append(content);
  // Search temporarily opens matches without overwriting the user's choices.
  group.addEventListener('toggle',()=>{if(group.isConnected&&!term)categoryOpenState.set(name,group.open);});
  for(const r of items){
  const row=document.createElement('div');row.className='item';
  const files=Array.isArray(r.attachments)?r.attachments:[], imageIndex=files.findIndex(a=>attachmentKind(a)==='image');
  if(imageIndex>=0){const preview=document.createElement('button');preview.type='button';preview.className='image-preview';preview.setAttribute('aria-label','Visa bilder för '+r.name);const img=document.createElement('img');img.className='thumb';img.alt='';img.src=files[imageIndex].data;preview.append(img);preview.onclick=()=>openMedia(files,imageIndex,preview);row.append(preview);}
  else{const icon=document.createElement('span');icon.className='thumb';icon.textContent='📦';row.append(icon);}
  const b=document.createElement('button');b.type='button';b.className='item-edit';b.innerHTML='<span class="itemtext"><b>'+escapeHTML(r.name)+'</b><small>'+escapeHTML([r.brand,r.model,r.category].filter(Boolean).join(' · '))+'</small>'+warranty(r)+'</span><span>Redigera ›</span>';b.onclick=()=>edit(r.id);row.append(b);
  files.forEach((f,i)=>{if(attachmentKind(f)==='pdf'){const pdf=document.createElement('button');pdf.type='button';pdf.className='secondary document-preview';pdf.textContent='📄 '+(f.name||'PDF-dokument');pdf.onclick=()=>openMedia(files,i,pdf);row.append(pdf);}});
  content.append(row);
  }
  $('list').append(group);
}
}

function edit(id=null){activeId=id;const r=records.find(x=>x.id===id)||{};for(const f of fields)$('itemForm').elements[f].value=r[f]??'';$('editorTitle').textContent=id?'Redigera inventarie':'Ny inventarie';$('delete').classList.toggle('hidden',!id);$('attachment').value='';renderFiles(r.attachments||[]);$('overview').classList.add('hidden');$('settings').classList.add('hidden');$('editor').classList.remove('hidden');window.scrollTo(0,0);}
let editingFiles=[];
function renderFiles(files){editingFiles=structuredClone(files);$('filePreview').replaceChildren();editingFiles.forEach((f,i)=>{const div=document.createElement('div');div.className='row';const kind=attachmentKind(f),open=document.createElement('button');open.type='button';open.className='secondary attachment-open';open.textContent=(kind==='image'?'🖼 ':kind==='pdf'?'📄 ':'📎 ')+(f.name||'Bilaga');open.disabled=!kind;if(!kind)open.title='Filformatet stöds inte för visning';if(kind==='image'){const img=document.createElement('img');img.src=f.data;img.alt='';open.prepend(img);}open.onclick=()=>openMedia(editingFiles,i,open);div.append(open);const remove=document.createElement('button');remove.type='button';remove.className='secondary';remove.textContent='Ta bort';remove.onclick=()=>{editingFiles.splice(i,1);renderFiles(editingFiles);};div.append(remove);$('filePreview').append(div);});}
// Attachments stay in the existing database format. Only validated, local
// raster images and PDFs may be rendered; imported HTML/SVG/URLs are refused.
function attachmentKind(f){
  if(!f||typeof f.data!=='string'||f.data.length>8_000_000)return '';
  const m=/^data:(image\/(?:jpeg|png|gif|webp)|application\/pdf);base64,([A-Za-z0-9+/\s]*={0,2})$/i.exec(f.data);
  if(!m)return '';
  const type=m[1].toLowerCase();
  if(String(f.type).toLowerCase()!==type)return '';
  try{const head=atob(m[2].replace(/\s/g,'').slice(0,32));
    if(type==='application/pdf')return head.startsWith('%PDF-')?'pdf':'';
    const valid=type==='image/jpeg'?head.startsWith('\xff\xd8\xff'):type==='image/png'?head.startsWith('\x89PNG\r\n\x1a\n'):type==='image/gif'?/^GIF8[79]a/.test(head):head.startsWith('RIFF')&&head.slice(8,12)==='WEBP';
    return valid?'image':'';
  }catch{return '';}
}
function attachmentBlob(f){const [header,body]=f.data.split(',');const bytes=Uint8Array.from(atob(body.replace(/\s/g,'')),c=>c.charCodeAt(0));return new Blob([bytes],{type:header.slice(5,header.indexOf(';'))});}
const mediaDialog=document.createElement('dialog');mediaDialog.className='media-viewer';mediaDialog.setAttribute('aria-labelledby','mediaTitle');
mediaDialog.innerHTML='<div class="media-shell"><div class="media-toolbar"><h2 id="mediaTitle"></h2><button type="button" id="mediaClose" autofocus aria-label="Stäng visaren">✕ Stäng</button></div><p id="mediaCount" role="status" aria-live="polite"></p><div class="media-actions"><button type="button" id="mediaPrev" aria-label="Föregående bild">← Föregående</button><button type="button" id="mediaNext" aria-label="Nästa bild">Nästa →</button><a id="mediaOpen" target="_blank" rel="noopener noreferrer">Öppna i ny flik</a><a id="mediaSave">Spara fil</a></div><p id="mediaHint"></p><div id="mediaStage"></div></div>';
document.body.append(mediaDialog);
let mediaFiles=[],mediaIndex=0,mediaURL=null,mediaOpener=null,oldOverflow='',swipe=null;
function clearMedia(){ $('mediaStage').replaceChildren();if(mediaURL){URL.revokeObjectURL(mediaURL);mediaURL=null;}$('mediaOpen').removeAttribute('href');$('mediaSave').removeAttribute('href');swipe=null;}
function drawMedia(){
  clearMedia();const f=mediaFiles[mediaIndex],kind=attachmentKind(f);
  $('mediaTitle').textContent=f.name||'Bilaga';
  const image=kind==='image';$('mediaCount').textContent=image?'Bild '+(mediaIndex+1)+' av '+mediaFiles.length:'PDF-dokument';
  $('mediaPrev').hidden=$('mediaNext').hidden=!image||mediaFiles.length<2;
  $('mediaHint').textContent=image?'Svep åt sidan eller använd piltangenterna. Öppna i ny flik för att zooma.':'Läs och zooma med webbläsarens PDF-verktyg. Om dokumentet inte visas eller alla sidor inte syns: välj Öppna i ny flik eller Spara fil.';
  mediaURL=URL.createObjectURL(attachmentBlob(f));$('mediaOpen').href=mediaURL;$('mediaSave').href=mediaURL;$('mediaSave').download=f.name|| (image?'bild.jpg':'dokument.pdf');
  const el=document.createElement(image?'img':'iframe');
  if(image){el.alt=f.name||'Inventariebild';el.draggable=false;el.onerror=()=>{$('mediaHint').textContent='Bilden kunde inte visas. Prova att öppna eller spara filen.';};}
  else{el.title='PDF: '+(f.name||'Dokument');el.setAttribute('referrerpolicy','no-referrer');}
  el.src=mediaURL;$('mediaStage').append(el);
}
function openMedia(files,index,opener){
  const f=files[index],kind=attachmentKind(f);if(!kind){status('Bilagan kunde inte öppnas. Endast giltiga bildfiler och PDF stöds.',true);return;}
  mediaFiles=kind==='image'?files.filter(x=>attachmentKind(x)==='image'):[f];mediaIndex=mediaFiles.indexOf(f);mediaOpener=opener||document.activeElement;
  try{drawMedia();oldOverflow=document.body.style.overflow;mediaDialog.showModal();document.body.style.overflow='hidden';$('mediaClose').focus();}catch{clearMedia();status('Bilagan kunde inte visas i den här webbläsaren.',true);}
}
function stepMedia(delta){if(mediaFiles.length<2)return;mediaIndex=(mediaIndex+delta+mediaFiles.length)%mediaFiles.length;drawMedia();}
$('mediaClose').onclick=()=>mediaDialog.close();$('mediaPrev').onclick=()=>stepMedia(-1);$('mediaNext').onclick=()=>stepMedia(1);
mediaDialog.addEventListener('close',()=>{clearMedia();mediaFiles=[];document.body.style.overflow=oldOverflow;if(mediaOpener?.isConnected)mediaOpener.focus();mediaOpener=null;});
mediaDialog.addEventListener('keydown',e=>{if(attachmentKind(mediaFiles[mediaIndex])!=='image')return;if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();stepMedia(e.key==='ArrowLeft'?-1:1);}});
const mediaStage=$('mediaStage');
mediaStage.addEventListener('touchstart',e=>{swipe=e.touches.length===1?{x:e.touches[0].clientX,y:e.touches[0].clientY,time:Date.now()}:null;},{passive:true});
mediaStage.addEventListener('touchmove',e=>{if(e.touches.length!==1)swipe=null;},{passive:true});
mediaStage.addEventListener('touchcancel',()=>{swipe=null;},{passive:true});
mediaStage.addEventListener('touchend',e=>{const start=swipe;swipe=null;if(!start||e.touches.length||!e.changedTouches.length||attachmentKind(mediaFiles[mediaIndex])!=='image')return;const dx=e.changedTouches[0].clientX-start.x,dy=e.changedTouches[0].clientY-start.y;if(Date.now()-start.time<1000&&Math.abs(dx)>60&&Math.abs(dx)>Math.abs(dy)*1.5)stepMedia(dx<0?1:-1);},{passive:true});

async function toAttachment(file){if(file.type.startsWith('image/')){let bitmap=await createImageBitmap(file);let scale=Math.min(1,1400/Math.max(bitmap.width,bitmap.height));let canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();let quality=.76,data=canvas.toDataURL('image/jpeg',quality);while(data.length>1_300_000&&quality>.3){quality-=.12;data=canvas.toDataURL('image/jpeg',quality);}if(data.length>1_300_000)throw Error('Bilden är för stor även efter komprimering.');return {name:file.name.replace(/\.[^.]+$/,'.jpg'),type:'image/jpeg',data};}if(file.type!=='application/pdf')throw Error('Endast bilder och PDF stöds.');if(file.size>1_000_000)throw Error('PDF-filen får vara högst 1 MB.');return await new Promise((res,rej)=>{let r=new FileReader();r.onload=()=>res({name:file.name,type:file.type,data:r.result});r.onerror=()=>rej(r.error);r.readAsDataURL(file)});}
function authHeaders(token){return {'apikey':cfg.supabaseAnonKey,'Authorization':'Bearer '+(token||cfg.supabaseAnonKey),'Content-Type':'application/json'};}
async function authCall(path,body){let r=await fetch(api+'/auth/v1/'+path,{method:'POST',headers:authHeaders(),body:JSON.stringify(body)});let d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.msg||d.error_description||d.message||'Inloggning misslyckades');return d;}
async function ensureToken(){if(!session)throw Error('Inte inloggad');if(Date.now()<(session.expires_at*1000-60000))return session.access_token;let data=await authCall('token?grant_type=refresh_token',{refresh_token:session.refresh_token});session={...data,expires_at:Math.floor(Date.now()/1000)+data.expires_in};await saveSetting('session',session);return session.access_token;}
async function cloud(path,method='GET',body){let token=await ensureToken();let r=await fetch(api+'/rest/v1/'+path,{method,headers:{...authHeaders(token),...(method!=='GET'?{'Prefer':'resolution=merge-duplicates,return=minimal'}:{})},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok)throw Error('Molntjänst: '+r.status+' '+(await r.text()).slice(0,220));return method==='GET'?r.json():null;}
async function sync(){if(!session){status('Lokalt läge – ingen synkning.');return;}if(!navigator.onLine){status('Offline. Ändringar sparas och synkas när internet återkommer.');return;}if(busy)return;busy=true;$('sync').disabled=true;try{status('Synkroniserar …');let local=(await all('records')).filter(r=>r.owner===userScope());let dirty=local.filter(r=>r.dirty);if(dirty.length){for(let r of dirty){await cloud('inventory','POST',{id:r.id,user_id:session.user.id,payload:{...r,dirty:false},updated_at:r.updatedAt});r.dirty=false;await put('records',r);}}
let remote=await cloud('inventory?select=id,payload,updated_at&order=updated_at.desc&limit=10000');let current=new Map((await all('records')).filter(r=>r.owner===userScope()).map(r=>[r.id,r]));for(let row of remote){let existing=current.get(row.id);if(!existing||(!existing.dirty&&row.updated_at>existing.updatedAt)){await put('records',{...row.payload,owner:userScope(),updatedAt:row.updated_at,dirty:false});}}await refreshList();status('Synkat '+new Date().toLocaleTimeString('sv-SE')+'.');}catch(e){status('Synkning misslyckades: '+e.message+' – lokala ändringar finns kvar.',true);}finally{busy=false;$('sync').disabled=false;}}
$('itemForm').onsubmit=async e=>{e.preventDefault();try{let files=[...editingFiles];for(let f of $('attachment').files){files.push(await toAttachment(f));}let existing=records.find(x=>x.id===activeId);let data={id:activeId||crypto.randomUUID(),owner:userScope(),attachments:files,deleted:false,dirty:!!session,updatedAt:new Date().toISOString()};for(let f of fields)data[f]=$('itemForm').elements[f].value.trim();await put('records',{...existing,...data});await refreshList();$('editor').classList.add('hidden');$('overview').classList.remove('hidden');status('Sparad lokalt.'+(session?' Synkning startar.':''));if(session)sync();}catch(e){status('Kunde inte spara: '+e.message,true);}};
$('delete').onclick=async()=>{if(!confirm('Radera inventarien på alla synkade enheter?'))return;let r=records.find(x=>x.id===activeId);await put('records',{...r,deleted:true,attachments:[],dirty:!!session,updatedAt:new Date().toISOString()});await refreshList();$('editor').classList.add('hidden');$('overview').classList.remove('hidden');if(session)sync();};
$('new').onclick=()=>edit();$('cancel').onclick=()=>{$('editor').classList.add('hidden');$('overview').classList.remove('hidden');};$('search').oninput=render;$('categoryFilter').onchange=render;$('sync').onclick=sync;
$('account').onclick=()=>{$('overview').classList.add('hidden');$('editor').classList.add('hidden');$('settings').classList.remove('hidden');};$('closeSettings').onclick=()=>{$('settings').classList.add('hidden');$('overview').classList.remove('hidden');};
$('login').onclick=async()=>{if(!configured)return status('Konfigurera Supabase i config.js först.',true);try{let d=await authCall('token?grant_type=password',{email:$('email').value.trim(),password:$('password').value});session={...d,expires_at:Math.floor(Date.now()/1000)+d.expires_in};await saveSetting('session',session);mode='cloud';await saveSetting('mode',mode);showApp();sync();}catch(e){status(e.message,true);}};
$('signup').onclick=async()=>{if(!configured)return status('Konfigurera Supabase i config.js först.',true);try{let d=await authCall('signup',{email:$('email').value.trim(),password:$('password').value});if(d.access_token){session={...d,expires_at:Math.floor(Date.now()/1000)+d.expires_in};await saveSetting('session',session);mode='cloud';await saveSetting('mode',mode);showApp();sync();}else status('Kontot skapades. Bekräfta via e-post och logga sedan in.');}catch(e){status(e.message,true);}};
$('local').onclick=async()=>{mode='local';session=null;await saveSetting('mode',mode);await saveSetting('session',null);showApp();status('Lokalt läge. Dina uppgifter synkas inte.');};
$('logout').onclick=async()=>{session=null;mode='local';await saveSetting('session',null);await saveSetting('mode','local');$('app').classList.add('hidden');$('auth').classList.remove('hidden');status('Utloggad. Molnposter är kvar lokalt på den här enheten.');};
$('export').onclick=async()=>{let data={format:'hemmainvent-v2',exportedAt:new Date().toISOString(),records:records};let blob=new Blob([JSON.stringify(data)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='hemmainvent-backup-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);};
$('importBtn').onclick=()=>$('importFile').click();$('importFile').onchange=async e=>{try{let file=e.target.files[0];if(!file)return;if(file.size>25_000_000)throw Error('Säkerhetskopian är för stor (max 25 MB).');let data=JSON.parse(await file.text());if(data.format!=='hemmainvent-v2'||!Array.isArray(data.records))throw Error('Felaktigt säkerhetskopieringsformat.');if(!confirm('Importera '+data.records.length+' poster till aktuellt konto?'))return;for(let r of data.records){if(typeof r.id!=='string'||typeof r.name!=='string'||!Array.isArray(r.attachments))continue;await put('records',{...r,owner:userScope(),dirty:!!session,updatedAt:new Date().toISOString()});}await refreshList();status('Import klar.');if(session)sync();}catch(err){status(err.message,true);}finally{e.target.value='';}};
window.addEventListener('online',()=>{if(session)sync();else status('Online.');});window.addEventListener('offline',()=>status('Offline – uppgifter sparas lokalt.'));
(async()=>{try{db=await openDB();mode=await getSetting('mode')||'local';session=await getSetting('session')||null;if(mode==='cloud'&&session&&configured){try{await ensureToken();showApp();if(navigator.onLine)sync();else status('Offline – visar lokalt sparade inventarier.');}catch(e){session=null;await saveSetting('session',null);status('Sessionen har gått ut. Logga in igen.',true);}}else if(mode==='local'){showApp();status(configured?'Lokalt läge – välj konto för automatisk synkning.':'Lokalt läge. För synkning behöver du först konfigurera Supabase.');}else status('Logga in för att fortsätta.');if('serviceWorker'in navigator&&location.protocol==='https:')navigator.serviceWorker.register('./sw.js').catch(()=>{});}catch(e){status('Kunde inte öppna lokal databas: '+e.message,true);}})();
