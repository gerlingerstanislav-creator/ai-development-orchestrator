import React,{useEffect,useState} from 'react';

type Request=(path:string,options?:RequestInit)=>Promise<any>;
type Module={id:string;title:string;body:string;stage:string|null;tags:string[];mandatory:boolean;status:'draft'|'approved'|'obsolete';priority:number;revision:number};
type Draft=Omit<Module,'id'|'revision'>;
const empty:Draft={title:'',body:'',stage:null,tags:[],mandatory:false,status:'draft',priority:0};
const stages=[['','Все этапы'],['analysis','Анализ'],['development','Разработка'],['testing','Тестирование'],['documentation','Документация'],['manager','Менеджер']];
export function KnowledgeInstructions({projectId,request}:{projectId:string;request:Request}){
 const [items,setItems]=useState<Module[]>([]);
 const [editing,setEditing]=useState<string|null>(null);
 const [draft,setDraft]=useState<Draft>(empty);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 useEffect(()=>{
  let mounted=true;
  request('/projects/'+projectId+'/knowledge/instructions').then(result=>{
   if(mounted)setItems(result.modules||[]);
  }).catch(e=>{if(mounted)setError(String(e.message||e));});
  return()=>{mounted=false;};
 },[projectId,request]);
 async function reload(){
  const result=await request('/projects/'+projectId+'/knowledge/instructions');
  setItems(result.modules||[]);
 }
 async function save(){
  setBusy(true);setError('');
  try{
   const old=items.find(i=>i.id===editing);
   await request('/projects/'+projectId+'/knowledge/instructions'+(old?'/'+old.id:''),{
    method:old?'PATCH':'POST',
    body:JSON.stringify({...draft,...(old?{expected_revision:old.revision}:{})})
   });
   await reload();setDraft(empty);setEditing(null);
  }catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{setBusy(false);}
 }
 async function remove(id:string){
  if(!window.confirm('Удалить модуль инструкций?'))return;
  setBusy(true);setError('');
  try{
   await request('/projects/'+projectId+'/knowledge/instructions/'+id,{method:'DELETE'});
   await reload();setEditing(null);setDraft(empty);
  }catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{setBusy(false);}
 }
 function edit(item:Module){
  setEditing(item.id);
  setDraft({title:item.title,body:item.body,stage:item.stage,tags:item.tags||[],mandatory:item.mandatory,status:item.status,priority:item.priority});
 }
 return <details className="knowledge-instructions-panel">
  <summary>Инструкции агентов ({items.length})</summary>
  <p className="muted">Утверждённые инструкции добавляются к выбранному этапу. Обязательные применяются независимо от тегов.</p>
  {items.map(item=><div className="knowledge-instruction-item" key={item.id}>
   <div><strong>{item.title}</strong><small>{stages.find(s=>s[0]===String(item.stage||''))?.[1]||item.stage} · {item.status==='approved'?'Утверждена':item.status==='draft'?'Черновик':'Устарела'}{item.mandatory?' · обязательная':''}</small></div>
   <div className="docs-actions"><button type="button" onClick={()=>edit(item)}>Изменить</button><button type="button" disabled={busy} onClick={()=>void remove(item.id)}>Удалить</button></div>
  </div>)}
  <div className="knowledge-instruction-form">
   <label>Название<input value={draft.title} maxLength={180} onChange={e=>setDraft({...draft,title:e.target.value})}/></label>
   <label>Инструкция<textarea rows={4} value={draft.body} maxLength={12000} onChange={e=>setDraft({...draft,body:e.target.value})}/></label>
   <div className="knowledge-inline-fields">
    <label>Этап<select value={draft.stage||''} onChange={e=>setDraft({...draft,stage:e.target.value||null})}>{stages.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
    <label>Статус<select value={draft.status} onChange={e=>setDraft({...draft,status:e.target.value as Draft['status']})}><option value="draft">Черновик</option><option value="approved">Утверждена</option><option value="obsolete">Устарела</option></select></label>
    <label>Приоритет<input type="number" min={-100} max={100} value={draft.priority} onChange={e=>setDraft({...draft,priority:Number(e.target.value)||0})}/></label>
   </div>
   <label>Теги через запятую<input value={draft.tags.join(', ')} onChange={e=>setDraft({...draft,tags:e.target.value.split(',').map(t=>t.trim()).filter(Boolean).slice(0,24)})}/></label>
   <label className="knowledge-checkbox"><input type="checkbox" checked={draft.mandatory} onChange={e=>setDraft({...draft,mandatory:e.target.checked})}/> Обязательная инструкция</label>
   <div className="docs-actions"><button type="button" disabled={busy||draft.title.trim().length<3||draft.body.trim().length<5} onClick={()=>void save()}>{editing?'Сохранить':'Добавить'}</button>{editing&&<button type="button" onClick={()=>{setEditing(null);setDraft(empty);}}>Отмена</button>}</div>
  </div>
  {error&&<p role="alert" className="error">{error}</p>}
 </details>;
}
