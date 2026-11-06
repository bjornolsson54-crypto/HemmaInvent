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
async function refreshList(){const scope=userScope(),rows=await all('records');if(scope!==userScope())return;records=rows.filter(r=>r.owner===scope);render();}
function showApp(){ clearDraft();categoryOpenState.clear(); $('auth').classList.add('hidden');$('app').classList.remove('hidden');$('settings').classList.add('hidden');$('editor').classList.add('hidden');$('overview').classList.remove('hidden');renderAccountIdentity();refreshList();}
// Display names belong to the signed-in account, never to inventory records.
function accountDisplayName(){
  const metadata=session?.user?.user_metadata||{};
  const name=metadata.display_name??metadata.full_name??metadata.name;
  return typeof name==='string'?name.trim().slice(0,100):'';
}
function renderConnectionState(){
  $('connectionStatus').textContent=session?(navigator.onLine?'Inloggad · Online':'Inloggad · Offline – ändringar sparas på enheten'):(!$('app').classList.contains('hidden')?'Utan konto · ingen synkning':'Inte inloggad');
}
function closeAccountMenu(){$('accountMenu').open=false;}
function renderAccountIdentity(){
  const name=accountDisplayName(),inApp=!$('app').classList.contains('hidden');
  $('signedInUser').textContent=session?(name||'Mitt konto')+' ▾':'På denna enhet ▾';
  $('accountMenu').classList.toggle('hidden',!inApp);closeAccountMenu();
  $('who').textContent=session?(name?'Inloggad som '+name:'Inloggad på ditt konto.'):'Utan konto – separat lokal lista i denna webbläsare.';
  $('accountEmail').textContent=session?.user?.email?'Kontots e-post: '+session.user.email:'';
  $('displayNameSection').classList.toggle('hidden',!session);
  for(const id of ['menuSwitch','menuLogout','settingsSwitch','logout'])$(id).classList.toggle('hidden',!session);
  for(const id of ['menuLogin','settingsLogin'])$(id).classList.toggle('hidden',!!session);
  $('menuAccount').textContent=session?'Mitt konto':'Om lokalt läge';
  $('inventoryContext').textContent=session?'Inventarier på ditt konto. Sparade offlinekopior kan visas även utan internet.':'Separat lista på denna enhet. Kontots inventarier visas först när du loggar in.';
  renderConnectionState();
}
async function openAccountSettings(section='account'){
  closeAccountMenu();if(!await confirmLeave())return;
  clearDraft();$('overview').classList.add('hidden');$('editor').classList.add('hidden');$('settings').classList.remove('hidden');
  renderAccountIdentity();$('displayName').value=accountDisplayName();$('profileStatus').textContent='';
  $('settingsTitle').textContent=section==='backup'?'Säkerhetskopiering':(session?'Mitt konto':'På denna enhet');
  const target=section==='backup'?$('backupSection'):$('settingsTitle');target.focus();target.scrollIntoView({block:'start',behavior:'smooth'});
}
let profileSaving=false;
async function saveDisplayName(){
  if(!session||profileSaving)return;
  const name=$('displayName').value.trim();
  if(name.length>100){$('profileStatus').textContent='Namnet får ha högst 100 tecken.';return;}
  if(!navigator.onLine){$('profileStatus').textContent='Anslut till internet för att spara namnet på ditt konto.';return;}
  if(busy){$('profileStatus').textContent='Vänta tills synkningen är klar och försök igen.';return;}
  profileSaving=true;busy=true;$('saveDisplayName').disabled=true;$('displayName').disabled=true;$('sync').disabled=true;
  $('profileStatus').textContent='Sparar namn …';
  try{
    const token=await ensureToken();
    const response=await fetch(api+'/auth/v1/user',{method:'PUT',headers:authHeaders(token),body:JSON.stringify({data:{display_name:name}})});
    const user=await response.json().catch(()=>({}));
    if(!response.ok)throw Error(user.msg||user.message||'Namnet kunde inte sparas. Försök igen.');
    if(user.id!==session.user.id)throw Error('Kontot kunde inte bekräftas. Logga in igen.');
    session={...session,user};await saveSetting('session',session);renderAccountIdentity();
    $('profileStatus').textContent='Namnet är sparat på ditt konto.';
  }catch(error){$('profileStatus').textContent='Kunde inte spara namnet: '+error.message;}
  finally{profileSaving=false;busy=false;$('saveDisplayName').disabled=false;$('displayName').disabled=false;$('sync').disabled=false;}
}
function warranty(r){if(!r.warrantyEnd)return '';let days=Math.ceil((new Date(r.warrantyEnd+'T12:00:00')-new Date())/86400000);return days<0?'<span class="pill bad">Garanti slut</span>':days<=30?'<span class="pill warn">Garanti går snart ut</span>':'<span class="pill">Garanti gäller</span>';}
// Categories use the existing record payload, sync and backup format.
const categoryOpenState=new Map();
const isInventory=r=>r.recordType!=='category';
const categoryName=r=>String(r.category??'').split('→').map(s=>s.trim()).filter(Boolean).join(' → ')||'Övrigt';
const belowCategory=(path,parent)=>path===parent||path.startsWith(parent+' → ');
const categoryLeaf=path=>path.split(' → ').at(-1);
function categoryPaths(){
  const paths=new Set();
  for(const r of records.filter(r=>!r.deleted)){
    const parts=categoryName(r).split(' → ');
    for(let i=1;i<=parts.length;i++)paths.add(parts.slice(0,i).join(' → '));
  }
  return [...paths].sort((a,b)=>a.localeCompare(b,'sv'));
}

function editorCategoryPaths(){return categoryPaths();}
function categoryOption(select,value,label=value){const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option);}
function setEditorCategory(path){
  const normalized=categoryName({category:path}),root=normalized.split(' → ')[0];
  const paths=[...new Set([...editorCategoryPaths(),normalized])];
  $('itemMainCategory').replaceChildren();
  for(const main of [...new Set(paths.map(p=>p.split(' → ')[0]))].sort((a,b)=>a.localeCompare(b,'sv')))categoryOption($('itemMainCategory'),main);
  $('itemMainCategory').value=root;
  $('itemSubcategory').replaceChildren();categoryOption($('itemSubcategory'),'','Ingen – direkt i huvudkategorin');
  for(const child of paths.filter(p=>p.startsWith(root+' → ')).sort((a,b)=>a.localeCompare(b,'sv')))categoryOption($('itemSubcategory'),child,child.slice(root.length+3));
  $('itemSubcategory').value=normalized===root?'':normalized;
  $('itemCategory').value=path;
  updateCategoryDestination();
}
function updateCategoryDestination(){
  $('categoryDestination').textContent='Sparas i: '+categoryName({category:$('itemCategory').value});
}
function chooseEditorCategory(){
  $('itemCategory').value=$('itemSubcategory').value||$('itemMainCategory').value;
  updateCategoryDestination();
  // Moving an existing item must not change its paint settings.
  if(!activeId&&/färg|målning|lasyr|lack/i.test($('itemCategory').value)){$('paintEnabled').checked=true;togglePaint();}
}
let categoryForEditor=false;
function writeRecords(rows){
  return new Promise((resolve,reject)=>{
    const transaction=db.transaction('records','readwrite');
    transaction.oncomplete=resolve;
    transaction.onabort=()=>reject(transaction.error||Error('Sparningen avbröts. Inga ändringar sparades.'));
    transaction.onerror=()=>{};
    const target=transaction.objectStore('records');
    try{for(const row of rows)target.put(row);}catch(error){transaction.abort();reject(error);}
  });
}
function categoryRecord(path){return {id:crypto.randomUUID(),owner:userScope(),recordType:'category',name:path,category:path,attachments:[],deleted:false,dirty:!!session,updatedAt:new Date().toISOString()};}
async function createCategory(parent,name){
  name=name.trim();
  if(!name||name.includes('→')){status('Skriv ett namn utan piltecknet →. Välj överkategori separat.',true);return false;}
  if(busy||editorSaving){status('Vänta tills den pågående sparningen eller synkningen är klar.');return false;}
  const path=parent?parent+' → '+name:name;
  if(categoryPaths().includes(path)){status('Kategorin finns redan.',true);return false;}
  busy=true;$('sync').disabled=true;
  try{await writeRecords([categoryRecord(path)]);categoryOpenState.set(path,true);await refreshList();status('Kategorin ”'+path+'” skapades.');}
  catch(e){status('Kunde inte skapa kategori: '+e.message,true);return false;}
  finally{busy=false;$('sync').disabled=false;}
  if(session)sync();return true;
}
function openCategoryDialog(parent=''){
  $('categoryParent').replaceChildren();
  const root=document.createElement('option');root.value='';root.textContent='Ingen – skapa huvudkategori';$('categoryParent').append(root);
  for(const path of categoryPaths()){const option=document.createElement('option');option.value=path;option.textContent=path;$('categoryParent').append(option);}
  $('categoryParent').value=parent;$('categoryNewName').value='';$('categoryDialog').showModal();$('categoryNewName').focus();
}
async function renameCategory(name,newLeaf){
  newLeaf=newLeaf.trim();
  if(!newLeaf||newLeaf.includes('→')){status('Skriv ett namn utan piltecknet →.',true);return false;}
  const parts=name.split(' → ');parts[parts.length-1]=newLeaf;const newName=parts.join(' → ');
  if(newName===name)return true;
  if(busy||editorSaving){status('Vänta tills synkningen eller sparningen är klar och försök igen.');return false;}
  const paths=categoryPaths();
  if(!paths.includes(name))return false;
  if(paths.includes(newName)&&!confirm('Kategorin ”'+newName+'” finns redan. Vill du slå ihop ”'+name+'” med den, inklusive underkategorier?'))return false;
  busy=true;$('sync').disabled=true;
  try{
    const updatedAt=new Date().toISOString(),rows=[],knownMetadata=new Set(records.filter(r=>!r.deleted&&!isInventory(r)&&!belowCategory(categoryName(r),name)).map(categoryName));
    for(const r of records.filter(r=>!r.deleted&&belowCategory(categoryName(r),name))){
      const destination=newName+categoryName(r).slice(name.length);
      const next={...r,category:destination,dirty:!!session,updatedAt};
      if(!isInventory(r)){next.name=destination;if(knownMetadata.has(destination))next.deleted=true;else knownMetadata.add(destination);}
      rows.push(next);
    }
    // Keep an explicitly created category even when it contains no inventory.
    if(!knownMetadata.has(newName))rows.push(categoryRecord(newName));
    await writeRecords(rows);
    for(const [path,open] of [...categoryOpenState])if(belowCategory(path,name)){categoryOpenState.delete(path);categoryOpenState.set(newName+path.slice(name.length),open);}
    categoryOpenState.set(newName,true);
    if(belowCategory($('categoryFilter').value,name)){
      const destination=newName+$('categoryFilter').value.slice(name.length),option=document.createElement('option');option.value=destination;option.textContent=destination;$('categoryFilter').append(option);$('categoryFilter').value=destination;
    }
    await refreshList();status('Kategorin heter nu ”'+newName+'”. Underkategorier och inventarier har följt med.');
  }catch(e){status('Kunde inte byta kategorinamn: '+e.message,true);return false;}
  finally{busy=false;$('sync').disabled=false;}
  if(session)sync();return true;
}
async function deleteCategory(path){
  if(busy||editorSaving){status('Vänta tills sparningen eller synkningen är klar och försök igen.');return false;}
  const affected=records.filter(r=>!r.deleted&&belowCategory(categoryName(r),path));
  const count=affected.filter(isInventory).length;
  if(count){status('Kategorin ”'+path+'” innehåller '+count+' inventarier, inklusive underkategorier. Flytta dem först via Redigera → Huvudkategori / Underkategori. Inga inventarier har tagits bort.',true);return false;}
  if(!categoryPaths().includes(path))return false;
  const descendants=categoryPaths().filter(p=>p!==path&&belowCategory(p,path)).length;
  if(!confirm('Ta bort den tomma kategorin ”'+path+'”'+(descendants?' och dess '+descendants+' tomma underkategorier':'')+'?'))return false;
  busy=true;$('sync').disabled=true;
  try{
    const updatedAt=new Date().toISOString();
    const rows=affected.map(r=>({...r,deleted:true,dirty:!!session,updatedAt}));
    // Removing the last subcategory must not also remove its parent.
    const parts=path.split(' → ');parts.pop();const parent=parts.join(' → ');
    if(parent&&!records.some(r=>!r.deleted&&!isInventory(r)&&categoryName(r)===parent))rows.push(categoryRecord(parent));
    await writeRecords(rows);
    for(const name of [...categoryOpenState.keys()])if(belowCategory(name,path))categoryOpenState.delete(name);
    if(belowCategory($('categoryFilter').value,path))$('categoryFilter').value='';
    await refreshList();status('Kategorin ”'+path+'” är borttagen.'+(session?' Ändringen synkas till dina andra enheter.':''));
  }catch(error){status('Kunde inte ta bort kategorin: '+error.message,true);return false;}
  finally{busy=false;$('sync').disabled=false;}
  if(session)sync();return true;
}
function categoryTools(path){
  const tools=document.createElement('div');tools.className='row category-tools';
  const rename=document.createElement('button');rename.type='button';rename.className='secondary';rename.textContent='Byt kategorinamn';rename.setAttribute('aria-label','Byt namn på '+path);
  const sub=document.createElement('button');sub.type='button';sub.className='secondary';sub.textContent='+ Underkategori';sub.onclick=()=>openCategoryDialog(path);
  const form=document.createElement('form');form.className='row hidden';
  const input=document.createElement('input');input.type='text';input.className='grow';input.value=categoryLeaf(path);input.required=true;input.setAttribute('aria-label','Nytt kategorinamn');
  const save=document.createElement('button');save.type='submit';save.textContent='Spara namn';
  const cancel=document.createElement('button');cancel.type='button';cancel.className='secondary';cancel.textContent='Avbryt';
  rename.onclick=()=>{rename.classList.add('hidden');form.classList.remove('hidden');input.value=categoryLeaf(path);input.focus();input.select();};
  cancel.onclick=()=>{form.classList.add('hidden');rename.classList.remove('hidden');rename.focus();};
  form.onsubmit=async e=>{e.preventDefault();save.disabled=true;try{if(await renameCategory(path,input.value)){form.classList.add('hidden');rename.classList.remove('hidden');}}finally{save.disabled=false;}};
  const remove=document.createElement('button');remove.type='button';remove.className='secondary';remove.textContent='Ta bort kategori';remove.setAttribute('aria-label','Ta bort kategorin '+path);remove.onclick=()=>deleteCategory(path);
  form.append(input,save,cancel);tools.append(rename,sub,remove,form);return tools;
}
function render(){
  const visible=records.filter(r=>!r.deleted&&isInventory(r)),term=$('search').value.toLowerCase().trim(),selected=$('categoryFilter').value,paths=categoryPaths();
  $('count').textContent=visible.length;
  $('expiring').textContent=visible.filter(r=>r.warrantyEnd&&((new Date(r.warrantyEnd+'T12:00:00')-new Date())/86400000)>=0&&((new Date(r.warrantyEnd+'T12:00:00')-new Date())/86400000)<=30).length;
  $('categoryFilter').replaceChildren();const allOption=document.createElement('option');allOption.value='';allOption.textContent='Alla kategorier';$('categoryFilter').append(allOption);
  for(const path of paths){const option=document.createElement('option');option.value=path;option.textContent=path;$('categoryFilter').append(option);}
  const category=paths.includes(selected)?selected:'';$('categoryFilter').value=category;
  const found=visible.filter(r=>(!category||belowCategory(categoryName(r),category))&&searchText(r).includes(term)).sort((a,b)=>a.name.localeCompare(b.name,'sv'));
  $('list').replaceChildren();
  const makeGroup=(path)=>{
    const matches=found.filter(r=>belowCategory(categoryName(r),path));
    if(term&&!matches.length)return null;
    if(category&&!belowCategory(path,category)&&!belowCategory(category,path))return null;
    const group=document.createElement('details');group.className='category-group';group.dataset.category=path;
    group.open=!!term||!!category||categoryOpenState.get(path)===true;
    const summary=document.createElement('summary');summary.className='category-summary';
    const title=document.createElement('span');title.className='category-title';title.textContent=categoryLeaf(path);
    const count=document.createElement('span');count.className='category-count';count.textContent=matches.length+' '+(matches.length===1?'inventarie':'inventarier');summary.append(title,count);group.append(summary);
    const content=document.createElement('div');content.className='category-items';group.append(content);content.append(categoryTools(path));
    group.addEventListener('toggle',()=>{if(group.isConnected&&!term&&!category)categoryOpenState.set(path,group.open);});
    for(const r of matches.filter(r=>categoryName(r)===path))content.append(inventoryRow(r));
    for(const child of paths.filter(p=>p.startsWith(path+' → ')&&!p.slice(path.length+3).includes(' → '))){const nested=makeGroup(child);if(nested)content.append(nested);}
    if(!matches.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='Inga inventarier i kategorin ännu.';content.append(empty);}
    return group;
  };
  for(const root of paths.filter(p=>!p.includes(' → '))){const group=makeGroup(root);if(group)$('list').append(group);}
  if(!$('list').children.length){const empty=document.createElement('div');empty.className='card muted';empty.textContent=term||category?'Inga inventarier hittades.':'Lägg till din första inventarie eller skapa en kategori.';$('list').append(empty);}
}
function searchText(r){
  const paint=r.paint||{},uses=Array.isArray(paint.uses)?paint.uses:[];
  return [r.name,r.brand,r.model,categoryName(r),r.serial,r.location,paint.colorName,paint.colorCode,paint.finish,paint.storage,...uses.flatMap(u=>[u.room,u.surface,u.notes,u.date])].join(' ').toLowerCase();
}
function paintSummary(r){
  if(!r.paintEnabled)return '';
  const p=r.paint||{},uses=Array.isArray(p.uses)?p.uses:[],latest=uses.filter(u=>u.date).sort((a,b)=>b.date.localeCompare(a.date))[0];
  return [p.colorName,p.colorCode,p.canCount!==''&&p.canCount!=null?p.canCount+' burkar':'',p.storage?'Förvaring: '+p.storage:'',latest?'Senast målat: '+latest.date+(latest.room?' · '+latest.room:''):''].filter(Boolean).join(' · ');
}
function inventoryRow(r){
  const row=document.createElement('div');row.className='item';
  const files=Array.isArray(r.attachments)?r.attachments:[], imageIndex=files.findIndex(a=>attachmentKind(a)==='image');
  if(imageIndex>=0){const preview=document.createElement('button');preview.type='button';preview.className='image-preview';preview.setAttribute('aria-label','Visa bilder för '+r.name);const img=document.createElement('img');img.className='thumb';img.alt='';img.src=files[imageIndex].data;preview.append(img);preview.onclick=()=>openMedia(files,imageIndex,preview);row.append(preview);}
  else{const icon=document.createElement('span');icon.className='thumb';icon.textContent='📦';row.append(icon);}
  const b=document.createElement('button');b.type='button';b.className='item-edit';b.innerHTML='<span class="itemtext"><b>'+escapeHTML(r.name)+'</b><small>'+escapeHTML([r.brand,r.model,r.category].filter(Boolean).join(' · '))+'</small>'+warranty(r)+'</span><span>Redigera ›</span>';b.onclick=()=>edit(r.id);row.append(b);
  files.forEach((f,i)=>{if(attachmentKind(f)==='pdf'){const pdf=document.createElement('button');pdf.type='button';pdf.className='secondary document-preview';pdf.textContent='📄 '+(f.name||'PDF-dokument');pdf.onclick=()=>openMedia(files,i,pdf);row.append(pdf);}});

  const paint=paintSummary(r);if(paint){const line=document.createElement('small');line.className='paint-summary';line.textContent=paint;b.querySelector('.itemtext').append(line);}
  return row;
}

let editorBaseline=null,editorSaving=false,leavePending=null,leaveResolve=null;
const paintFields=['colorName','colorCode','finish','canCount','canVolume','storage'];
function readPaint(){
  const value={};for(const key of paintFields)value[key]=$('paint-'+key).value.trim();
  value.uses=[...$('paintingUses').children].map(row=>{const use={};for(const key of ['date','room','surface','notes'])use[key]=row.querySelector('[data-use="'+key+'"]').value.trim();return use;});
  return value;
}
function editorSnapshot(){
  const value={};for(const key of fields)value[key]=$('itemForm').elements[key].value;
  value.paintEnabled=$('paintEnabled').checked;value.paint=readPaint();value.attachments=editingFiles;
  value.pendingFiles=[...$('attachment').files].map(f=>[f.name,f.size,f.type,f.lastModified]);return JSON.stringify(value);
}
function hasUnsavedChanges(){return editorBaseline!==null&&!$('editor').classList.contains('hidden')&&editorSnapshot()!==editorBaseline;}
function confirmLeave(){
  if(editorSaving){status('Inventarien sparas. Vänta ett ögonblick.');return Promise.resolve(false);}
  if(!hasUnsavedChanges())return Promise.resolve(true);
  if(leavePending)return leavePending;
  leavePending=new Promise(resolve=>{leaveResolve=resolve;});$('leaveDialog').showModal();$('keepEditing').focus();return leavePending;
}
function finishLeave(discard){const resolve=leaveResolve;leaveResolve=null;leavePending=null;$('leaveDialog').close();if(resolve)resolve(discard);}
function clearDraft(){editorBaseline=null;activeId=null;editingFiles=[];$('attachment').value='';}
function showOverview(resetFilters=false){
  clearDraft();$('editor').classList.add('hidden');$('settings').classList.add('hidden');$('overview').classList.remove('hidden');
  if(resetFilters){$('search').value='';$('categoryFilter').value='';}render();window.scrollTo(0,0);
}
function togglePaint(){
  const enabled=$('paintEnabled').checked;$('paintFields').classList.toggle('hidden',!enabled);$('paintFields').disabled=!enabled;
}
function addPaintingUse(use={}){
  const row=document.createElement('div');row.className='painting-use';
  row.innerHTML='<div class="fields"><div><label>Datum<input type="date" data-use="date"></label></div><div><label>Rum / plats<input data-use="room" placeholder="Vardagsrum"></label></div><div><label>Yta<input data-use="surface" placeholder="Väggar, tak, dörr …"></label></div><div><label>Anteckning<input data-use="notes" placeholder="Antal strykningar, underarbete …"></label></div></div>';
  for(const key of ['date','room','surface','notes'])row.querySelector('[data-use="'+key+'"]').value=use[key]||'';
  const remove=document.createElement('button');remove.type='button';remove.className='secondary';remove.textContent='Ta bort målningstillfälle';remove.onclick=()=>row.remove();row.append(remove);$('paintingUses').append(row);
}
async function edit(id=null){
  if(!await confirmLeave())return;
  activeId=id;const r=records.find(x=>x.id===id&&isInventory(x))||{};
  for(const f of fields)$('itemForm').elements[f].value=r[f]??'';
  $('editorTitle').textContent=id?'Redigera inventarie':'Ny inventarie';$('delete').classList.toggle('hidden',!id);$('attachment').value='';renderFiles(r.attachments||[]);
  $('paintEnabled').checked=r.paintEnabled??!!r.paint;for(const key of paintFields)$('paint-'+key).value=r.paint?.[key]??'';
  $('paintingUses').replaceChildren();for(const use of (Array.isArray(r.paint?.uses)?r.paint.uses:[]))addPaintingUse(use);togglePaint();setEditorCategory(r.category??'');
  $('overview').classList.add('hidden');$('settings').classList.add('hidden');$('editor').classList.remove('hidden');editorBaseline=editorSnapshot();window.scrollTo(0,0);
}
async function saveItem(){
  if(editorSaving||busy){status('Vänta tills den pågående sparningen eller synkningen är klar.');return false;}
  editorSaving=true;busy=true;$('sync').disabled=true;$('saveItem').disabled=true;$('itemForm').inert=true;
  try{
    const files=[...editingFiles];for(const f of $('attachment').files)files.push(await toAttachment(f));
    const existing=records.find(x=>x.id===activeId&&isInventory(x));
    const data={id:activeId||crypto.randomUUID(),owner:userScope(),attachments:files,deleted:false,dirty:!!session,updatedAt:new Date().toISOString(),paintEnabled:$('paintEnabled').checked};
    for(const f of fields)data[f]=$('itemForm').elements[f].value.trim();
    if(!data.name)throw Error('Inventarien behöver ett namn.');
    if(data.paintEnabled){data.paint={...existing?.paint,...readPaint()};data.paint.uses=data.paint.uses.filter(use=>Object.values(use).some(Boolean));}
    else if(existing?.paint)data.paint=existing.paint;
    // Preserve a category after its last item is moved or deleted.
    const rows=[{...existing,...data}];
    for(const path of new Set([categoryName(data),...(existing?[categoryName(existing)]:[])]))if(!records.some(r=>!r.deleted&&!isInventory(r)&&categoryName(r)===path))rows.push(categoryRecord(path));
    await writeRecords(rows);await refreshList();showOverview();status('Sparad lokalt.'+(session?' Synkning startar.':''));
  }catch(e){status('Kunde inte spara: '+e.message,true);return false;}
  finally{editorSaving=false;busy=false;$('sync').disabled=false;$('saveItem').disabled=false;$('itemForm').inert=false;}
  if(session)sync();return true;
}

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
// Authentication UI and recovery tokens are kept separate from inventory sessions.
let authBusy=false,recoveryActive=false,recoverySession=null,resetRetryAt=0;
const authControls=['login','signup','local','forgotPassword','createAccount','cancelSignup','sendReset','cancelResetRequest','saveNewPassword','cancelNewPassword'];
function setAuthBusy(value){authBusy=value;for(const id of authControls)$(id).disabled=value;}
function showAuthPanel(id='auth'){
  closeAccountMenu();clearDraft();$('app').classList.add('hidden');
  for(const panel of ['auth','signupPanel','resetRequestPanel','resetPasswordPanel'])$(panel).classList.toggle('hidden',panel!==id);
  renderAccountIdentity();
}
function authRedirectUrl(){
  const url=new URL(cfg.appUrl||location.href);
  if(url.protocol!=='https:')throw Error('Öppna HemmaInvent på dess publicerade HTTPS-adress för att skicka mejllänkar.');
  url.hash='';url.search='';return url.href;
}
async function authRequest(path,{method='POST',body,token}={}){
  const response=await fetch(api+'/auth/v1/'+path,{method,headers:authHeaders(token),body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    const message=response.status===429?'För många försök. Vänta en stund och försök igen.':data.msg||data.error_description||data.message||'Kontot kunde inte hanteras. Försök igen.';
    throw Error(message);
  }
  return data;
}
async function acceptLogin(data){
  if(!data.access_token||!data.refresh_token||!data.user?.id)throw Error('Inloggningen kunde inte bekräftas. Försök igen.');
  session={...data,expires_at:Math.floor(Date.now()/1000)+Number(data.expires_in||3600)};
  mode='cloud';records=[];await saveSetting('session',session);await saveSetting('mode',mode);
  $('password').value='';$('signupPassword').value='';$('signupPasswordConfirm').value='';
  for(const id of ['signupPanel','resetRequestPanel','resetPasswordPanel'])$(id).classList.add('hidden');
  showApp();sync();
}
async function loginAccount(){
  if(authBusy)return;if(!configured)return status('Konfigurera Supabase i config.js först.',true);
  setAuthBusy(true);
  try{await acceptLogin(await authRequest('token?grant_type=password',{body:{email:$('email').value.trim(),password:$('password').value}}));}
  catch(error){status('Kunde inte logga in: '+error.message,true);}finally{setAuthBusy(false);}
}
async function signupAccount(){
  if(authBusy)return;if(!configured)return status('Konfigurera Supabase i config.js först.',true);
  const name=$('signupName').value.trim(),email=$('signupEmail').value.trim(),password=$('signupPassword').value;
  if(name.length>100){$('signupStatus').textContent='Namnet får ha högst 100 tecken.';return;}
  if(password.length<8||password!==$('signupPasswordConfirm').value){$('signupStatus').textContent='Lösenorden måste vara lika och ha minst 8 tecken.';return;}
  setAuthBusy(true);$('signupStatus').textContent='Skapar konto …';
  try{
    const data=await authRequest('signup?redirect_to='+encodeURIComponent(authRedirectUrl()),{body:{email,password,data:{display_name:name}}});
    if(data.access_token)await acceptLogin(data);
    else{
      $('email').value=email;$('signupPassword').value='';$('signupPasswordConfirm').value='';
      $('signupStatus').textContent='Kontrollera din e-post för att bekräfta registreringen och logga sedan in. Har du redan ett konto kan du logga in eller välja Glömt lösenord. Titta även i skräpposten.';
    }
  }catch(error){$('signupStatus').textContent='Kunde inte skapa konto: '+error.message;}finally{setAuthBusy(false);}
}
async function requestPasswordReset(){
  if(authBusy)return;if(!configured)return status('Konfigurera Supabase i config.js först.',true);
  if(Date.now()<resetRetryAt){$('resetRequestStatus').textContent='Vänta en minut innan du begär en ny länk.';return;}
  setAuthBusy(true);$('resetRequestStatus').textContent='Skickar …';
  try{
    await authRequest('recover?redirect_to='+encodeURIComponent(authRedirectUrl()),{body:{email:$('resetEmail').value.trim()}});
    resetRetryAt=Date.now()+60000;
    $('resetRequestStatus').textContent='Om adressen hör till ett konto skickas ett mejl med en återställningslänk. Kontrollera även skräpposten.';
  }catch(error){$('resetRequestStatus').textContent='Kunde inte skicka länken: '+error.message;}finally{setAuthBusy(false);}
}
function captureAuthCallback(){
  const hash=new URLSearchParams(location.hash.slice(1)),query=new URLSearchParams(location.search);
  const hasHash=['access_token','refresh_token','error','error_description','error_code'].some(key=>hash.has(key));
  const hasQuery=['code','token_hash','error','error_description','error_code'].some(key=>query.has(key));
  if(!hasHash&&!hasQuery)return null;
  const callback={type:hash.get('type'),accessToken:hash.get('access_token'),refreshToken:hash.get('refresh_token'),expiresIn:Number(hash.get('expires_in')||3600),error:hash.has('error')||hash.has('error_code')||query.has('error')||query.has('error_code'),unsupported:hasQuery};
  // Remove credentials and errors from the address before any network request.
  for(const key of ['code','token_hash','type','error','error_description','error_code'])query.delete(key);
  const search=query.toString();history.replaceState(null,'',location.pathname+(search?'?'+search:''));
  return callback;
}
async function handleAuthCallback(callback){
  if(!callback)return false;
  if(callback.error||callback.unsupported){showAuthPanel();status('Mejllänken är ogiltig, har gått ut eller använder ett annat format. Välj Glömt lösenord för en ny länk, eller logga in om du just bekräftat din e-post.',true);return true;}
  if(callback.type!=='recovery'){
    showAuthPanel();status('Länken har behandlats. Logga in med din e-postadress och ditt lösenord.');return true;
  }
  recoveryActive=true;showAuthPanel('resetPasswordPanel');$('resetPasswordForm').classList.add('hidden');
  $('resetPasswordStatus').textContent='Kontrollerar återställningslänken …';
  try{
    if(!configured||!callback.accessToken||!callback.refreshToken)throw Error('Återställningslänken är ofullständig.');
    const user=await authRequest('user',{method:'GET',token:callback.accessToken});
    if(!user.id)throw Error('Kontot kunde inte bekräftas.');
    recoverySession={access_token:callback.accessToken,refresh_token:callback.refreshToken,user,expires_at:Math.floor(Date.now()/1000)+Math.min(Math.max(callback.expiresIn||3600,0),3600)};
    // Do not replace an existing account session or start inventory sync here.
    $('resetAccount').textContent='Välj ett nytt lösenord'+(user.user_metadata?.display_name?' för '+String(user.user_metadata.display_name).slice(0,100):'')+'.';
    $('resetPasswordForm').classList.remove('hidden');$('resetPasswordStatus').textContent='';$('newPassword').focus();
  }catch(error){
    recoveryActive=false;recoverySession=null;showAuthPanel('resetRequestPanel');
    $('resetRequestStatus').textContent='Länken kunde inte användas. Begär en ny länk. '+error.message;
  }
  return true;
}
async function finishPasswordReset(){
  if(authBusy)return;
  const password=$('newPassword').value;
  if(password.length<8||password!==$('confirmNewPassword').value){$('resetPasswordStatus').textContent='Lösenorden måste vara lika och ha minst 8 tecken.';return;}
  if(!recoverySession){$('resetPasswordStatus').textContent='Begär en ny återställningslänk.';return;}
  setAuthBusy(true);$('resetPasswordStatus').textContent='Sparar nytt lösenord …';
  try{
    if(Date.now()>=recoverySession.expires_at*1000){
      const renewed=await authRequest('token?grant_type=refresh_token',{body:{refresh_token:recoverySession.refresh_token}});
      if(renewed.user?.id!==recoverySession.user.id)throw Error('Länken kunde inte bekräftas. Begär en ny länk.');
      recoverySession={...recoverySession,...renewed,expires_at:Math.floor(Date.now()/1000)+Number(renewed.expires_in||3600)};
    }
    await authRequest('user',{method:'PUT',token:recoverySession.access_token,body:{password}});
    const email=recoverySession.user.email||'';
    // Ask for a fresh login after resetting, without importing or syncing any data.
    session=null;mode='signedout';records=[];await saveSetting('session',null);await saveSetting('mode','signedout');
    recoverySession=null;recoveryActive=false;$('newPassword').value='';$('confirmNewPassword').value='';$('password').value='';$('email').value=email;
    showAuthPanel();renderAccountIdentity();status('Lösenordet är ändrat. Logga in med ditt nya lösenord.');
  }catch(error){$('resetPasswordStatus').textContent='Kunde inte ändra lösenordet: '+error.message;}
  finally{setAuthBusy(false);}
}
function cancelPasswordReset(){
  if(authBusy)return;recoverySession=null;recoveryActive=false;$('newPassword').value='';$('confirmNewPassword').value='';showAuthPanel();status('Logga in för att fortsätta.');
}
async function returnToLogin(action='logout'){
  if(busy||editorSaving||authBusy){status('Vänta tills sparningen eller synkningen är klar.');return;}
  if(!await confirmLeave())return;
  closeAccountMenu();session=null;mode='signedout';records=[];clearDraft();
  await saveSetting('session',null);await saveSetting('mode','signedout');
  $('list').replaceChildren();$('search').value='';$('categoryFilter').value='';
  $('email').value='';$('password').value='';showAuthPanel();renderAccountIdentity();status(action==='switch'?'Logga in på ett annat konto. Varje konto har sin egen lista.':action==='login'?'Logga in för att se kontots inventarier. Den separata lokala listan finns kvar.':'Du är utloggad. Logga in igen för att se kontots inventarier.');
}

function authHeaders(token){return {'apikey':cfg.supabaseAnonKey,'Authorization':'Bearer '+(token||cfg.supabaseAnonKey),'Content-Type':'application/json'};}
async function authCall(path,body){let r=await fetch(api+'/auth/v1/'+path,{method:'POST',headers:authHeaders(),body:JSON.stringify(body)});let d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.msg||d.error_description||d.message||'Inloggning misslyckades');return d;}
async function ensureToken(){if(!session)throw Error('Inte inloggad');if(Date.now()<(session.expires_at*1000-60000))return session.access_token;let data=await authCall('token?grant_type=refresh_token',{refresh_token:session.refresh_token});session={...data,expires_at:Math.floor(Date.now()/1000)+data.expires_in};await saveSetting('session',session);return session.access_token;}
async function cloud(path,method='GET',body){let token=await ensureToken();let r=await fetch(api+'/rest/v1/'+path,{method,headers:{...authHeaders(token),...(method!=='GET'?{'Prefer':'resolution=merge-duplicates,return=minimal'}:{})},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok)throw Error('Molntjänst: '+r.status+' '+(await r.text()).slice(0,220));return method==='GET'?r.json():null;}
async function sync(){if(recoveryActive)return;if(!session){status('Lokalt läge – ingen synkning.');return;}if(!navigator.onLine){status('Offline. Ändringar sparas och synkas när internet återkommer.');return;}if(busy)return;busy=true;$('sync').disabled=true;try{status('Synkroniserar …');let local=(await all('records')).filter(r=>r.owner===userScope());let dirty=local.filter(r=>r.dirty);if(dirty.length){for(let r of dirty){await cloud('inventory','POST',{id:r.id,user_id:session.user.id,payload:{...r,dirty:false},updated_at:r.updatedAt});r.dirty=false;await put('records',r);}}
let remote=await cloud('inventory?user_id=eq.'+encodeURIComponent(session.user.id)+'&select=id,user_id,payload,updated_at&order=updated_at.desc&limit=10000');const stored=await all('records'),foreignIds=new Set(stored.filter(r=>r.owner!==userScope()).map(r=>r.id));let current=new Map(stored.filter(r=>r.owner===userScope()).map(r=>[r.id,r]));for(let row of remote){if(foreignIds.has(row.id))throw Error('En post har samma ID som ett annat kontos lokala data. Inga uppgifter skrivs över.');if(row.user_id!==session.user.id)throw Error('Synkningen stoppades: ett annat kontos post mottogs. Kontrollera databasens åtkomstregler.');let existing=current.get(row.id);if(!existing||(!existing.dirty&&row.updated_at>existing.updatedAt)){await put('records',{...row.payload,owner:userScope(),updatedAt:row.updated_at,dirty:false});}}await refreshList();status('Synkat '+new Date().toLocaleTimeString('sv-SE')+'.');}catch(e){status('Synkning misslyckades: '+e.message+' – lokala ändringar finns kvar.',true);}finally{busy=false;$('sync').disabled=false;}}
$('itemForm').onsubmit=async e=>{e.preventDefault();await saveItem();};
$('delete').onclick=async()=>{
  if(busy||editorSaving){status('Vänta tills sparningen eller synkningen är klar.');return;}
  if(!confirm('Radera inventarien på alla synkade enheter?'))return;
  const r=records.find(x=>x.id===activeId&&isInventory(x));if(!r)return;
  busy=true;$('sync').disabled=true;
  try{
    const rows=[{...r,deleted:true,attachments:[],dirty:!!session,updatedAt:new Date().toISOString()}];
    if(!records.some(x=>!x.deleted&&!isInventory(x)&&categoryName(x)===categoryName(r)))rows.push(categoryRecord(categoryName(r)));
    await writeRecords(rows);await refreshList();showOverview();status('Inventarien raderades.');
  }catch(e){status('Kunde inte radera: '+e.message,true);return;}
  finally{busy=false;$('sync').disabled=false;}
  if(session)sync();
};
$('new').onclick=()=>edit();
$('cancel').onclick=async()=>{if(await confirmLeave())showOverview();};
$('search').oninput=render;$('categoryFilter').onchange=render;$('sync').onclick=sync;
$('menuAccount').onclick=()=>openAccountSettings();
$('menuBackup').onclick=()=>openAccountSettings('backup');
for(const id of ['menuSwitch','settingsSwitch'])$(id).onclick=()=>returnToLogin('switch');
for(const id of ['menuLogout','logout'])$(id).onclick=()=>returnToLogin('logout');
for(const id of ['menuLogin','settingsLogin'])$(id).onclick=()=>returnToLogin('login');
document.addEventListener('click',e=>{if(!$('accountMenu').contains(e.target))closeAccountMenu();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('accountMenu').open){closeAccountMenu();$('signedInUser').focus();}});
$('displayNameForm').onsubmit=async e=>{e.preventDefault();await saveDisplayName();};
$('closeSettings').onclick=()=>showOverview();
$('homeLink').onclick=async e=>{e.preventDefault();if(!await confirmLeave())return;if(!$('app').classList.contains('hidden'))showOverview(true);window.scrollTo(0,0);};
$('keepEditing').onclick=()=>finishLeave(false);$('discardChanges').onclick=()=>finishLeave(true);
$('leaveDialog').addEventListener('cancel',e=>{e.preventDefault();finishLeave(false);});
window.addEventListener('beforeunload',e=>{if(editorSaving||hasUnsavedChanges()){e.preventDefault();e.returnValue='';}});
$('paintEnabled').onchange=togglePaint;$('addPaintingUse').onclick=()=>addPaintingUse();
$('itemMainCategory').onchange=()=>{setEditorCategory($('itemMainCategory').value);chooseEditorCategory();};
$('itemSubcategory').onchange=chooseEditorCategory;
$('editorNewMainCategory').onclick=()=>{categoryForEditor=true;openCategoryDialog();};
$('editorNewSubcategory').onclick=()=>{categoryForEditor=true;openCategoryDialog($('itemMainCategory').value);};
$('newCategory').onclick=()=>{categoryForEditor=false;openCategoryDialog();};
$('categoryCancel').onclick=()=>$('categoryDialog').close();
$('categoryForm').onsubmit=async e=>{e.preventDefault();$('categoryCreate').disabled=true;try{const parent=$('categoryParent').value,name=$('categoryNewName').value.trim();if(await createCategory(parent,name)){if(categoryForEditor){setEditorCategory(parent?parent+' → '+name:name);chooseEditorCategory();}categoryForEditor=false;$('categoryDialog').close();}}finally{$('categoryCreate').disabled=false;}};
$('loginForm').onsubmit=async e=>{e.preventDefault();await loginAccount();};
$('signup').onclick=()=>{if(authBusy)return;showAuthPanel('signupPanel');$('signupEmail').value=$('email').value.trim();$('signupStatus').textContent='';$('signupName').focus();};
$('signupForm').onsubmit=async e=>{e.preventDefault();await signupAccount();};
$('cancelSignup').onclick=()=>{if(!authBusy)showAuthPanel();};
$('forgotPassword').onclick=()=>{if(authBusy)return;showAuthPanel('resetRequestPanel');$('resetEmail').value=$('email').value.trim();$('resetRequestStatus').textContent='';$('resetEmail').focus();};
$('resetRequestForm').onsubmit=async e=>{e.preventDefault();await requestPasswordReset();};
$('cancelResetRequest').onclick=()=>{if(!authBusy)showAuthPanel();};
$('resetPasswordForm').onsubmit=async e=>{e.preventDefault();await finishPasswordReset();};
$('cancelNewPassword').onclick=cancelPasswordReset;
$('local').onclick=async()=>{if(authBusy)return;mode='local';session=null;records=[];await saveSetting('mode',mode);await saveSetting('session',null);showApp();status('Lokalt läge. Dina uppgifter synkas inte.');};

$('export').onclick=async()=>{let data={format:'hemmainvent-v2',exportedAt:new Date().toISOString(),records:records};let blob=new Blob([JSON.stringify(data)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='hemmainvent-backup-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);};
async function importBackupRecords(data,{locked=false}={}){
  if(!locked&&(busy||editorSaving||authBusy))throw Error('Vänta tills sparningen eller synkningen är klar.');
  if(data.format!=='hemmainvent-v2'||!Array.isArray(data.records))throw Error('Felaktigt säkerhetskopieringsformat.');
  const scope=userScope(),existing=await all('records'),byId=new Map(existing.map(r=>[r.id,r])),rows=[];
  for(const record of data.records){
    if(typeof record.id!=='string'||typeof record.name!=='string'||!Array.isArray(record.attachments))continue;
    let id=record.id;
    if((record.owner&&record.owner!==scope)||(byId.has(id)&&byId.get(id).owner!==scope)){
      // Stable copied IDs let repeated imports merge without overwriting another user's local records.
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('hemmainvent-import:'+scope+':'+record.id));
      const chars=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('').slice(0,32).split('');
      chars[12]='8';chars[16]=((parseInt(chars[16],16)&3)|8).toString(16);const hex=chars.join('');
      id=hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
    }
    if(byId.has(id)&&byId.get(id).owner!==scope)throw Error('En post tillhör ett annat konto. Importen avbröts.');
    rows.push({...record,id,owner:scope,dirty:!!session,updatedAt:new Date().toISOString()});
  }
  if(scope!==userScope())throw Error('Kontot ändrades. Importera igen.');
  await writeRecords(rows);return rows.length;
}
$('importBtn').onclick=()=>$('importFile').click();
$('importFile').onchange=async e=>{
  if(busy||editorSaving||authBusy){status('Vänta tills sparningen eller synkningen är klar.');e.target.value='';return;}
  // Prevent account switching or sync while the backup is being read and saved.
  setAuthBusy(true);busy=true;$('sync').disabled=true;
  try{
    const file=e.target.files[0];if(!file)return;
    if(file.size>25_000_000)throw Error('Säkerhetskopian är för stor (max 25 MB).');
    const data=JSON.parse(await file.text());
    if(data.format!=='hemmainvent-v2'||!Array.isArray(data.records))throw Error('Felaktigt säkerhetskopieringsformat.');
    if(!confirm('Importera '+data.records.length+' poster till aktuellt konto?'))return;
    // The handler owns the lock; the helper checks the current account again before writing.
    const count=await importBackupRecords(data,{locked:true});
    await refreshList();status('Import klar: '+count+' poster.');
  }catch(error){status(error.message,true);}
  finally{busy=false;setAuthBusy(false);$('sync').disabled=false;e.target.value='';}
  if(session)sync();
};
window.addEventListener('online',()=>{renderConnectionState();if(session)sync();else status('Online. Lokalt läge synkas inte.');});window.addEventListener('offline',()=>{renderConnectionState();status(session?'Offline – ändringar sparas på enheten och synkas när internet återkommer.':'Offline – den separata lokala listan sparas på denna enhet.');});
const initialAuthCallback=captureAuthCallback();
(async()=>{try{db=await openDB();mode=await getSetting('mode')||'local';session=await getSetting('session')||null;if(await handleAuthCallback(initialAuthCallback))return;if(mode==='cloud'&&session&&configured){try{if(navigator.onLine)await ensureToken();showApp();if(navigator.onLine)sync();else status('Offline – visar lokalt sparade inventarier.');}catch(e){session=null;await saveSetting('session',null);renderAccountIdentity();status('Sessionen har gått ut. Logga in igen.',true);}}else if(mode==='local'){showApp();status(configured?'Lokalt läge – välj konto för automatisk synkning.':'Lokalt läge. För synkning behöver du först konfigurera Supabase.');}else status('Logga in för att fortsätta.');if('serviceWorker'in navigator&&location.protocol==='https:')navigator.serviceWorker.register('./sw.js').catch(()=>{});}catch(e){status('Kunde inte öppna lokal databas: '+e.message,true);}})();
