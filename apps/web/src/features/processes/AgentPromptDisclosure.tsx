import {useState} from 'react';
import {api} from '../../api/client.js';

export type AgentPromptAudit={id:string;role:string;operation:string;prompt:string;original_chars:number;truncated:boolean;created_at:string};

export function AgentPromptDisclosure({projectId,processId}:{projectId:string;processId:string}){
 const [entries,setEntries]=useState<AgentPromptAudit[]|null>(null);
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState('');
 const load=async()=>{
  setLoading(true);setError('');
  try{const result=await api<{prompts:AgentPromptAudit[]}>('/projects/'+projectId+'/processes/'+processId+'/prompts');setEntries(result.prompts);}
  catch(e){setError(e instanceof Error?e.message:'Не удалось получить инструкции');}
  finally{setLoading(false);}
 };
 const initial=entries?.length?[...entries].sort((a,b)=>a.created_at.localeCompare(b.created_at))[0]:null;
 return <details className="agent-prompt-disclosure" onToggle={event=>{if(event.currentTarget.open)void load();}}>
  <summary>Посмотреть инструкции агента</summary>
  {loading&&<small className="muted">Загрузка инструкций…</small>}
  {!loading&&error&&<small className="muted">{error}</small>}
  {!loading&&!error&&entries?.length===0&&<small className="muted">Промпт этого запуска не сохранён.</small>}
  {initial&&!loading&&<div className="agent-prompt-detail">
   <small className="muted">Первоначальный запрос · {new Date(initial.created_at).toLocaleString('ru-RU')} · {initial.original_chars} символов</small>
   <pre>{initial.prompt}</pre>
   {entries&&entries.length>1&&<details className="agent-prompt-retries"><summary>Последующие запросы ({entries.length-1})</summary>
    {[...entries].sort((a,b)=>a.created_at.localeCompare(b.created_at)).slice(1).map(entry=><div key={entry.id}><small>{entry.operation} · {new Date(entry.created_at).toLocaleString('ru-RU')}</small><pre>{entry.prompt}</pre></div>)}
   </details>}
  </div>}
 </details>;
}
