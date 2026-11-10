import React,{useEffect,useState} from 'react';
type Request=(path:string,options?:RequestInit)=>Promise<any>;
type Snapshot={id:string;task_id:string;agent_stage:string;process_id?:string|null;sources:Array<{id:string;title:string;version:string}>;instructions:{modules?:Array<{id:string;title:string;revision:number}>;mandatory_rules?:Array<{id:string}>};created_at:string};
type Read={document_id:string;document_version:string;agent_stage:string;created_at:string;process_id?:string|null};
export function KnowledgeAudit({projectId,taskId,processId,request}:{projectId:string;taskId:string;processId:string;request:Request}){
 const [snapshots,setSnapshots]=useState<Snapshot[]>([]);
 const [reads,setReads]=useState<Read[]>([]);
 const [error,setError]=useState('');
 useEffect(()=>{let live=true;
  Promise.all([
   request('/projects/'+projectId+'/knowledge/context-snapshots?task_id='+taskId),
   request('/projects/'+projectId+'/knowledge/context-reads?task_id='+taskId)
  ]).then(([a,b])=>{
   if(!live)return;
   const matches=(a.snapshots||[]).filter((s:Snapshot)=>s.process_id===processId);
   setSnapshots(matches.length?matches:(a.snapshots||[]).slice(0,3));
   setReads((b.results||[]).slice(0,20));
  }).catch(e=>{if(live)setError(e instanceof Error?e.message:String(e));});
  return()=>{live=false;};
 },[projectId,taskId,processId,request]);
 if(!snapshots.length&&!reads.length&&!error)return null;
 return <details className="knowledge-audit">
  <summary>Контекст агента · источники и версии</summary>
  {snapshots.map(s=><div key={s.id} className="knowledge-audit-snapshot">
   <small>{s.agent_stage} · {new Date(s.created_at).toLocaleString('ru-RU')}</small>
   <div>Выбраны документы:</div>
   {(s.sources||[]).map(doc=><div key={doc.id}><a href={'/projects/'+projectId+'/docs/'+doc.id}>{doc.title}</a> <small>({new Date(doc.version).toLocaleString('ru-RU')})</small></div>)}
   <small>Обязательных правил: {s.instructions?.mandatory_rules?.length||0}; модулей инструкций: {s.instructions?.modules?.length||0}</small>
  </div>)}
  {reads.length>0&&<details><summary>Дополнительные чтения ({reads.length})</summary>
   {reads.map((r,i)=><div key={i}><a href={'/projects/'+projectId+'/docs/'+r.document_id}>Документ</a> · {r.agent_stage||'агент'} · <small>{new Date(r.created_at).toLocaleString('ru-RU')}</small></div>)}
  </details>}
  {error&&<p role="alert">{error}</p>}
 </details>;
}
