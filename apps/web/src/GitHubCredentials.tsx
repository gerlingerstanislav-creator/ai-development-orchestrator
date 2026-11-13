import {useEffect,useState,type FormEvent} from 'react';
import {KeyRound,Pencil,Plus,Trash2,X} from 'lucide-react';
import {api} from './api/client.js';

type Connection={id:string;name:string;provider:string;project_count?:number};
type EditDraft={id:string;name:string;secret:string};

const errorMessage=(error:unknown)=>error instanceof Error?error.message:'Не удалось сохранить изменения';

/** Personal GitHub credentials. Project repository binding is configured elsewhere. */
export function GitHubCredentials(){
 const [items,setItems]=useState<Connection[]>([]);
 const [loading,setLoading]=useState(true);
 const [busy,setBusy]=useState(false);
 const [creating,setCreating]=useState(false);
 const [draft,setDraft]=useState({name:'',secret:''});
 const [editing,setEditing]=useState<EditDraft|null>(null);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');

 async function refresh(){
  const connections=await api<Connection[]>('/connections');
  setItems(connections.filter(item=>item.provider==='github_token'));
 }
 useEffect(()=>{
  let active=true;
  void api<Connection[]>('/connections').then(connections=>{
   if(active)setItems(connections.filter(item=>item.provider==='github_token'));
  }).catch(error=>{if(active)setError(errorMessage(error));}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[]);

 async function add(event:FormEvent){
  event.preventDefault();if(busy)return;
  setBusy(true);setError('');setNotice('');
  try{
   await api('/connections',{method:'POST',body:JSON.stringify({...draft,provider:'github_token'})});
   await refresh();setDraft({name:'',secret:''});setCreating(false);
   setNotice('Токен сохранён. Его можно выбрать в настройках любого проекта.');
  }catch(error){setError(errorMessage(error));}
  finally{setBusy(false);}
 }
 async function update(event:FormEvent){
  event.preventDefault();if(!editing||busy)return;
  setBusy(true);setError('');setNotice('');
  try{
   await api('/connections/'+editing.id,{method:'PATCH',body:JSON.stringify({
    name:editing.name,...(editing.secret?{secret:editing.secret}:{})
   })});
   await refresh();setEditing(null);
   setNotice('Подключение обновлено. Привязки проектов сохранены.');
  }catch(error){setError(errorMessage(error));}
  finally{setBusy(false);}
 }
 async function remove(item:Connection){
  if(busy||item.project_count)return;
  if(!window.confirm('Удалить подключение «'+item.name+'»? Секрет будет удалён без возможности восстановления.'))return;
  setBusy(true);setError('');setNotice('');
  try{
   await api('/connections/'+item.id,{method:'DELETE'});
   await refresh();
   setNotice('Подключение удалено.');
  }catch(error){setError(errorMessage(error));}
  finally{setBusy(false);}
 }

 return <div className="profile-github">
  <div className="row-line profile-section-title">
   <div><h3><KeyRound size={17}/> GitHub</h3><p className="muted">Личные токены для всех проектов. Репозиторий и ветка выбираются отдельно в настройках проекта.</p></div>
   {!creating&&<button className="secondary" type="button" onClick={()=>{setCreating(true);setEditing(null);setError('');}}><Plus size={15}/> Добавить токен</button>}
  </div>
  {loading?<p className="muted">Загрузка подключений…</p>:items.length===0&&!creating?<p className="profile-empty">Токен GitHub пока не добавлен.</p>:
   <div className="profile-credential-list">{items.map(item=><div className="profile-credential" key={item.id}>
    <div className="profile-credential-info">
     <strong>{item.name}</strong>
     <small>{item.project_count?('Используется в проектах: '+item.project_count):'Пока не используется'} · Токен скрыт</small>
    </div>
    <div className="profile-credential-actions">
     <button className="secondary" type="button" disabled={busy} onClick={()=>{setEditing({id:item.id,name:item.name,secret:''});setCreating(false);setError('');}} aria-label={'Изменить '+item.name}><Pencil size={14}/> Изменить</button>
     <button className="secondary profile-danger" type="button" disabled={busy||!!item.project_count} title={item.project_count?'Сначала отвяжи токен от проектов':'Удалить подключение'} onClick={()=>void remove(item)} aria-label={'Удалить '+item.name}><Trash2 size={14}/></button>
    </div>
   </div>)}</div>}
  {creating&&<form className="profile-credential-form" onSubmit={event=>void add(event)}>
   <div className="row-line"><strong>Новый токен GitHub</strong><button type="button" className="secondary" onClick={()=>setCreating(false)} aria-label="Отменить добавление"><X size={15}/></button></div>
   <div className="settings-grid">
    <label>Название подключения<input required maxLength={100} value={draft.name} placeholder="Рабочий GitHub" onChange={event=>setDraft({...draft,name:event.target.value})}/></label>
    <label>Personal access token<input required minLength={8} type="password" autoComplete="new-password" value={draft.secret} placeholder="github_pat_…" onChange={event=>setDraft({...draft,secret:event.target.value})}/></label>
   </div>
   <div className="profile-form-actions"><button className="primary" disabled={busy||!draft.name.trim()||draft.secret.length<8}>{busy?'Сохранение…':'Сохранить токен'}</button></div>
  </form>}
  {editing&&<form className="profile-credential-form" onSubmit={event=>void update(event)}>
   <div className="row-line"><strong>Изменить подключение</strong><button type="button" className="secondary" onClick={()=>setEditing(null)} aria-label="Закрыть редактирование"><X size={15}/></button></div>
   <div className="settings-grid">
    <label>Название<input required maxLength={100} value={editing.name} onChange={event=>setEditing({...editing,name:event.target.value})}/></label>
    <label>Новый токен (необязательно)<input type="password" minLength={8} autoComplete="new-password" value={editing.secret} placeholder="Оставь пустым, чтобы не менять" onChange={event=>setEditing({...editing,secret:event.target.value})}/></label>
   </div>
   <p className="muted">Если заменить токен, проекты продолжат использовать это подключение. У нового токена должны быть права на их репозитории.</p>
   <div className="profile-form-actions"><button className="primary" disabled={busy||!editing.name.trim()||(!!editing.secret&&editing.secret.length<8)}>{busy?'Сохранение…':'Сохранить изменения'}</button></div>
  </form>}
  {error&&<p className="profile-feedback-error" role="alert">{error}</p>}
  {notice&&<p className="profile-feedback-success" role="status">{notice}</p>}
  <details className="profile-help">
   <summary>Как создать токен GitHub и какие права нужны</summary>
   <p>Создай <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Fine-grained personal access token</a>. Выбери только необходимые репозитории и права: Contents — Read and write, Pull requests — Read and write, Checks — Read.</p>
   <p>Не отправляй токен в чаты и не сохраняй в репозитории. Сервис хранит его в зашифрованном виде и не показывает повторно.</p>
  </details>
 </div>;
}
