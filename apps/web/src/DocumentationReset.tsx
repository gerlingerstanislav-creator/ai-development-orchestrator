import React,{useState} from 'react';
import {createPortal} from 'react-dom';
import {Trash2,X} from 'lucide-react';

type Request=(path:string,options?:RequestInit)=>Promise<any>;
type Preview={
 intent_id:string;project_name:string;pages:number;imports:number;questions:number;roots_preserved:number;
 confirmation_phrase:string;warning:string;
};
export function DocumentationReset({projectId,request,onReset,compact=false}:{
 projectId:string;request:Request;onReset:()=>Promise<void>;compact?:boolean;
}){
 const [preview,setPreview]=useState<Preview|null>(null);
 const [phrase,setPhrase]=useState('');
 const [projectName,setProjectName]=useState('');
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 async function open(){
  setBusy(true);setError('');
  try{
   const p=await request('/projects/'+projectId+'/documentation/reset/preview',{method:'POST'});
   setPreview(p);setPhrase('');setProjectName('');
  }catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{setBusy(false);}
 }
 async function confirm(){
  if(!preview||busy)return;
  setBusy(true);setError('');
  try{
   await request('/projects/'+projectId+'/documentation/reset/confirm',{
    method:'POST',body:JSON.stringify({intent_id:preview.intent_id,project_name:projectName,confirmation_phrase:phrase})
   });
   setPreview(null);await onReset();
  }catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{setBusy(false);}
 }
 return <>
  <button type="button" className={compact?'secondary':'secondary docs-reset-action'} disabled={busy} onClick={()=>void open()}
   title="Очистить документацию" aria-label="Очистить документацию"><Trash2 size={16}/> {compact?'Очистить':'Очистить документацию'}</button>
  {error&&!preview&&<p className="task-action-error" role="alert">{error}</p>}
  {preview&&createPortal(<div className="overlay documentation-reset-overlay" onMouseDown={()=>{if(!busy)setPreview(null);}}>
   <div className="dialog documentation-reset-dialog" role="dialog" aria-modal="true" aria-label="Полная очистка документации" onMouseDown={e=>e.stopPropagation()} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();if(!busy)setPreview(null);}}}>
    <div className="modal-heading"><h2>Очистить документацию проекта?</h2><button type="button" className="task-close" onClick={()=>setPreview(null)} disabled={busy} aria-label="Закрыть"><X size={18}/></button></div>
    <p>{preview.warning}</p>
    <p>Будут удалены <strong>{preview.pages}</strong> страниц, <strong>{preview.questions}</strong> вопросов аналитика и <strong>{preview.imports}</strong> прежних импортов. Системные разделы останутся.</p>
    <p className="task-action-error"><strong>Отменить операцию будет невозможно.</strong> Первоначальный репозиторий GitHub не изменяется.</p>
    <label>Введи название проекта: <strong>{preview.project_name}</strong>
     <input autoFocus value={projectName} onChange={e=>setProjectName(e.target.value)} placeholder={preview.project_name}/>
    </label>
    <label>Введи подтверждение: <strong>{preview.confirmation_phrase}</strong>
     <input value={phrase} onChange={e=>setPhrase(e.target.value)} placeholder={preview.confirmation_phrase}/>
    </label>
    {error&&<p className="task-action-error" role="alert">{error}</p>}
    <div className="docs-actions">
     <button type="button" className="secondary" disabled={busy} onClick={()=>setPreview(null)}>Отмена</button>
     <button type="button" className="task-action-danger" disabled={busy||projectName!==preview.project_name||phrase!==preview.confirmation_phrase} onClick={()=>void confirm()}>Удалить все документы</button>
    </div>
   </div>
  </div>,document.body)}
 </>;
}
