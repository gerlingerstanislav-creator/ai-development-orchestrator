import React,{useEffect,useState} from 'react';
type Request=(path:string,options?:RequestInit)=>Promise<any>;
type Task={id:string;title:string;pr_url?:string|null;display_number?:number};
type TaskLink={id:string;document_id:string;task_id:string;relation:string;title:string};
type ArtifactLink={id:string;artifact_kind:string;artifact_ref:string;relation:string};
export function KnowledgeTraceability({projectId,documentId,tasks,request}:{projectId:string;documentId:string;tasks:Task[];request:Request}){
 const [links,setLinks]=useState<TaskLink[]>([]);
 const [artifacts,setArtifacts]=useState<ArtifactLink[]>([]);
 const [taskId,setTaskId]=useState('');
 const [relation,setRelation]=useState('requires');
 const [artifactKind,setArtifactKind]=useState('component');
 const [artifactRef,setArtifactRef]=useState('');
 const [artifactRelation,setArtifactRelation]=useState('describes');
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);
 async function refresh(){
  const [taskLinks,artifactLinks]=await Promise.all([
   request('/projects/'+projectId+'/knowledge/task-links?document_id='+documentId),
   request('/projects/'+projectId+'/knowledge/artifact-links?document_id='+documentId)
  ]);
  setLinks(taskLinks.links||[]);setArtifacts(artifactLinks.links||[]);
 }
 useEffect(()=>{let active=true;
  Promise.all([
   request('/projects/'+projectId+'/knowledge/task-links?document_id='+documentId),
   request('/projects/'+projectId+'/knowledge/artifact-links?document_id='+documentId)
  ]).then(([t,a])=>{if(active){setLinks(t.links||[]);setArtifacts(a.links||[]);}})
   .catch(e=>{if(active)setError(e instanceof Error?e.message:String(e));});
  return()=>{active=false;};
 },[projectId,documentId,request]);
 async function post(path:string,body:any){
  setError('');setBusy(true);
  try{await request(path,{method:'POST',body:JSON.stringify(body)});await refresh();}
  catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{setBusy(false);}
 }
 async function remove(path:string){
  setError('');setBusy(true);
  try{await request(path,{method:'DELETE'});await refresh();}
  catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{setBusy(false);}
 }
 const taskMap=new Map(tasks.map(t=>[t.id,t]));
 return <details className="knowledge-traceability">
  <summary>Трассировка требований ({links.length+artifacts.length})</summary>
  <p className="muted">Связи помогают агентам находить требования по задачам, PR, тестам и компонентам кода.</p>
  {links.map(link=><div className="knowledge-link" key={link.id}><span>{link.relation}: </span><a href={'/projects/'+projectId+'/tasks/'+link.task_id}>{taskMap.get(link.task_id)?.title||link.task_id}</a><button disabled={busy} onClick={()=>void remove('/projects/'+projectId+'/knowledge/task-links/'+link.id)}>×</button></div>)}
  <div className="knowledge-inline-fields"><label>Задача<select value={taskId} onChange={e=>setTaskId(e.target.value)}><option value="">Выбрать задачу</option>{tasks.map(t=><option key={t.id} value={t.id}>{t.display_number?'#'+t.display_number+' · ':''}{t.title}</option>)}</select></label>
   <label>Связь<select value={relation} onChange={e=>setRelation(e.target.value)}>{['requires','implements','tests','documents','affected_by'].map(v=><option key={v}>{v}</option>)}</select></label>
   <button disabled={busy||!taskId} onClick={()=>void post('/projects/'+projectId+'/knowledge/task-links',{document_id:documentId,task_id:taskId,relation})}>Связать</button>
  </div>
  <h4>Код, PR и QA</h4>
  {artifacts.map(a=><div className="knowledge-link" key={a.id}><span>{a.artifact_kind} · {a.relation}: </span><code>{a.artifact_ref}</code><button disabled={busy} onClick={()=>void remove('/projects/'+projectId+'/knowledge/artifact-links/'+a.id)}>×</button></div>)}
  <div className="knowledge-inline-fields">
   <select aria-label="Тип артефакта" value={artifactKind} onChange={e=>setArtifactKind(e.target.value)}><option value="component">Компонент</option><option value="pr">Pull Request</option><option value="qa_case">QA-кейс</option></select>
   <input aria-label="Ссылка на артефакт" value={artifactRef} onChange={e=>setArtifactRef(e.target.value)} placeholder={artifactKind==='qa_case'?'UUID тест-кейса':artifactKind==='pr'?'Ссылка PR':'apps/api/src/...'}/>
   <input aria-label="Тип связи" value={artifactRelation} onChange={e=>setArtifactRelation(e.target.value)} placeholder="describes"/>
   <button disabled={busy||!artifactRef.trim()} onClick={()=>void post('/projects/'+projectId+'/knowledge/artifact-links',{document_id:documentId,artifact_kind:artifactKind,artifact_ref:artifactRef.trim(),relation:artifactRelation})}>Добавить</button>
  </div>
  {error&&<p role="alert" className="error">{error}</p>}
 </details>;
}
