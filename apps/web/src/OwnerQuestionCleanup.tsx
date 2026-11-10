import React,{useState} from 'react';
import {createPortal} from 'react-dom';
import {Trash2,X} from 'lucide-react';

type Candidate={id:string;display_number:number;title:string;blocked_reason:string|null};

export function OwnerQuestionCleanup({projectId,taskIds,request,onDeleted,onOpenTask}:{
 projectId:string;
 taskIds?:string[];
 request:<T>(path:string,options?:RequestInit)=>Promise<T>;
 onDeleted:()=>Promise<void>;
 onOpenTask:(id:string)=>void;
}){
 const selectedIds=taskIds?.length?[...new Set(taskIds)]:null;
 const path='/projects/'+projectId+'/tasks/'+(selectedIds?'delete':'owner-questions/delete');
 const [tasks,setTasks]=useState<Candidate[]|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [deleted,setDeleted]=useState<number|null>(null);
 const eligible=tasks?.filter(task=>!task.blocked_reason)??[];
 const blocked=tasks?.filter(task=>task.blocked_reason)??[];
 function close(){if(!busy){setTasks(null);setError('');}}
 async function preview(){
  setBusy(true);setError('');setDeleted(null);
  try{setTasks((await request<{tasks:Candidate[]}>(path+'/preview'+(selectedIds?'?ids='+encodeURIComponent(selectedIds.join(',')):''))).tasks);}
  catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{setBusy(false);}
 }
 async function confirm(){
  if(!eligible.length||busy)return;
  setBusy(true);setError('');
  try{
   const result=await request<{deleted_task_ids:string[]}>(path+'/confirm',{
    method:'POST',body:JSON.stringify({confirm:true,task_ids:eligible.map(task=>task.id)})
   });
   setTasks(null);setDeleted(result.deleted_task_ids.length);
   await onDeleted();
  }catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{setBusy(false);}
 }
 return <>
  <button type="button" className="secondary docs-reset-action" disabled={busy} onClick={()=>void preview()}>
   <Trash2 size={15}/> {selectedIds?'Проверить выбранные задачи':'Проверить задачи к удалению'}
  </button>
  {deleted!==null&&<p role="status">Удалено задач: {deleted}</p>}
  {error&&!tasks&&<p className="task-action-error" role="alert">{error}</p>}
  {tasks&&createPortal(<div className="overlay documentation-reset-overlay" onMouseDown={close}>
   <div className="dialog documentation-reset-dialog" role="dialog" aria-modal="true" aria-label={selectedIds?'Подтверждение удаления выбранных задач':'Удаление задач из «Вопросов к ПО»'}
    onMouseDown={e=>e.stopPropagation()} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();close();}}}>
    <div className="modal-heading"><h2>{selectedIds?'Удаление выбранных задач':'Удаление задач из «Вопросов к ПО»'}</h2>
     <button type="button" className="task-close" disabled={busy} onClick={close} aria-label="Закрыть"><X size={18}/></button>
    </div>
    {!tasks.length&&<p>В колонке нет задач.</p>}
    {eligible.length>0&&<>
     <p>Эти задачи и их вопросы будут удалены. Отменить действие будет невозможно.</p>
     <ul>{eligible.map(task=><li key={task.id}>#{task.display_number} {task.title}</li>)}</ul>
    </>}
    {blocked.length>0&&<>
     <p><strong>Защищённые задачи</strong></p>
     <ul>{blocked.map(task=><li key={task.id}>
      #{task.display_number} {task.title}. {task.blocked_reason}{' '}
      <button type="button" className="textbtn" disabled={busy} onClick={()=>{close();onOpenTask(task.id);}}>Открыть задачу</button>
     </li>)}</ul>
    </>}
    {error&&<p className="task-action-error" role="alert">{error}</p>}
    <div className="docs-actions">
     <button type="button" className="secondary" autoFocus disabled={busy} onClick={close}>Закрыть</button>
     {error&&<button type="button" className="secondary" disabled={busy} onClick={()=>void preview()}>Обновить список</button>}
     {eligible.length>0&&<button type="button" className="task-action-danger" disabled={busy||!!error} onClick={()=>void confirm()}>
      Удалить задачи ({eligible.length})
     </button>}
    </div>
   </div>
  </div>,document.body)}
 </>;
}
