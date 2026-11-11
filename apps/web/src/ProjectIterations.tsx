import {useEffect,useState} from 'react';
import {ArrowLeft,Check,ClipboardList,MessageCircle,Pencil,Plus} from 'lucide-react';
type Request=<T>(path:string,options?:RequestInit)=>Promise<T>;
export type IterationSummary={id:string;title:string;revision:number;approved_revision:number|null;task_count:number;done_count:number};
type PlanDocument={id:string;title:string};
type PlannedTask={id:string;title:string;display_number:number|string;type:string;stage:string;parent_id:string|null;depends_on_task_id:string|null;iteration_work_kind:'analysis'|'development'|null};
type PlanRef={id:string;created_at:string;iteration_revision:number;published_at:string|null};
type Question={id:string;question:string;answer:string|null;status:'open'|'answered'};
type IterationDetails=Pick<IterationSummary,'id'|'title'|'revision'|'approved_revision'>&{body:string;documents:PlanDocument[];tasks:PlannedTask[];plans:PlanRef[];recommended_task_ids:string[];planning_runs:{id:string;status:string;message:string}[];questions:Question[]};
type PlanItem={key:string;title:string;description:string;parent?:string;kind?:'analysis'|'development';depends_on?:string;existing?:{id:string;title:string}};
type PlanPreview={id:string;items:PlanItem[];stale:boolean;published_at:string|null};
const initialDraft={title:'',body:'',document_ids:[] as string[]};
const problem=(e:unknown)=>e instanceof Error?e.message:String(e);
const requestBody=(method:string,body:unknown)=>({method,body:JSON.stringify(body)});
const approved=(item:Pick<IterationSummary,'revision'|'approved_revision'>)=>item.approved_revision===item.revision;

export function ProjectIterations({projectId,iterationId,summaries,documents,request,onSelect,onChange,onChat,documentLink,taskLink,stages,renderBody}:{
 projectId:string;iterationId:string|null;summaries:IterationSummary[];documents:PlanDocument[];request:Request;
 onSelect:(id:string|null)=>void;onChange:()=>Promise<void>;
 onChat:(role:'project'|'documentation',message:string)=>void;documentLink:(id:string)=>string;taskLink:(id:string)=>string;
 stages:{stage:string;label:string;description:string}[];renderBody:(body:string)=>React.ReactNode;
}){
 const base='/projects/'+projectId+'/iterations',url=iterationId?base+'/'+iterationId:base;
 const [details,setDetails]=useState<IterationDetails|null>(null);
 const [draft,setDraft]=useState(initialDraft),[editing,setEditing]=useState(false),[draftRevision,setDraftRevision]=useState<number>();
 const [preview,setPreview]=useState<PlanPreview|null>(null),[answers,setAnswers]=useState<Record<string,string>>({});
 const [busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 useEffect(()=>{
  if(!iterationId){setDetails(null);setPreview(null);return;}
  const controller=new AbortController();let first=true;
  const refresh=async()=>{
   try{const item=await request<IterationDetails>(url,{signal:controller.signal});if(controller.signal.aborted)return;
    setDetails(item);if(first){setError('');first=false;}}
   catch(e){if(!controller.signal.aborted&&first)setError(problem(e));}
   finally{if(!controller.signal.aborted)setLoading(false);}
  };
  setLoading(true);void refresh();
  const timer=window.setInterval(()=>{if(!document.hidden)void refresh();},7000);
  return()=>{controller.abort();window.clearInterval(timer);};
 },[url,iterationId,request]);
 const planSignature=details?.plans.map(p=>p.id+':'+p.published_at).join('|')??'';
 useEffect(()=>{
  const candidate=details?.plans.find(p=>!p.published_at)||details?.plans[0];
  if(!candidate){setPreview(null);return;}
  let active=true;
  void request<PlanPreview>(url+'/plans/'+candidate.id).then(result=>{if(active)setPreview(result);}).catch(()=>{if(active)setPreview(null);});
  return()=>{active=false;};
 },[url,planSignature,request]);
 async function refresh(){if(iterationId)setDetails(await request<IterationDetails>(url));}
 async function perform(action:()=>Promise<void>){if(busy)return;setBusy(true);setError('');setNotice('');
  try{await action();}catch(e){setError(problem(e));}finally{setBusy(false);}}
 function edit(){setDraft(details?{title:details.title,body:details.body,document_ids:details.documents.map(d=>d.id)}:initialDraft);setDraftRevision(details?.revision);setEditing(true);}
 function save(event:React.FormEvent){event.preventDefault();void perform(async()=>{
  const value=await request<{id:string}>(url,requestBody(details?'PUT':'POST',{...draft,expected_revision:draftRevision}));
  setEditing(false);if(iterationId)await refresh();else onSelect(value.id);await onChange();
 });}
 function approve(){if(!details)return;void perform(async()=>{
  await request(url+'/approve',requestBody('POST',{expected_revision:details.revision}));
  await refresh();await onChange();setNotice('Итерация согласована. Подготовка единого плана передана аналитику.');
 });}
 function answer(question:Question){if(!answers[question.id]?.trim())return;void perform(async()=>{
  await request(url+'/questions/'+question.id+'/answer',requestBody('POST',{answer:answers[question.id].trim()}));
  setAnswers(old=>({...old,[question.id]:''}));await refresh();setNotice('Ответ сохранён и будет учтён при следующей декомпозиции.');
 });}
 const currentPlan=preview?.items??[],epics=currentPlan.filter(item=>!item.parent);
 const planning=details?.planning_runs.some(run=>run.status==='queued'||run.status==='running');
 const taskName=(id:string)=>details?.tasks.find(t=>t.id===id)?.title??id;
 const roots=details?.tasks.filter(task=>!task.parent_id||!details.tasks.some(parent=>parent.id===task.parent_id))??[];
 return <div className="iteration-workspace">
  <header className="iteration-header"><div>
   {iterationId&&<button type="button" className="textbtn iteration-back" onClick={()=>onSelect(null)}><ArrowLeft size={14}/> Все итерации</button>}
   <h2>{details?.title??(iterationId?'Итерация':'План разработки')}</h2>
   {details&&<small className="muted">Редакция {details.revision} · {approved(details)?'Согласована':'Черновик'}</small>}
  </div>{!editing&&(!iterationId||details)&&<button type="button" className="secondary" disabled={busy} onClick={edit}>
   {details?<><Pencil size={15}/> Изменить</>:<><Plus size={15}/> Итерация</>}
  </button>}</header>
  {loading&&<p className="muted" role="status">Загрузка…</p>}
  {error&&<p className="error" role="alert">{error}</p>}
  {notice&&<p role="status">{notice}</p>}
  {editing&&<form className="iteration-editor" onSubmit={save}>
   <label>Название<input value={draft.title} maxLength={180} required onChange={e=>setDraft({...draft,title:e.target.value})}/></label>
   <label>Цель, объём и критерии готовности<textarea value={draft.body} maxLength={16000} required rows={7} onChange={e=>setDraft({...draft,body:e.target.value})}/></label>
   {documents.length>0&&<details><summary>Связанные документы ({draft.document_ids.length})</summary><div className="iteration-doc-picker">
    {documents.map(d=><label key={d.id}><input type="checkbox" checked={draft.document_ids.includes(d.id)}
     disabled={draft.document_ids.length>=30&&!draft.document_ids.includes(d.id)}
     onChange={e=>setDraft({...draft,document_ids:e.target.checked?[...draft.document_ids,d.id]:draft.document_ids.filter(id=>id!==d.id)})}/>{d.title}</label>)}
   </div></details>}
   <div className="iteration-actions"><button className="secondary" type="button" onClick={()=>setEditing(false)}>Отмена</button><button className="primary" type="submit" disabled={busy||!draft.title.trim()||!draft.body.trim()}>Сохранить</button></div>
  </form>}
  {!iterationId&&!editing&&<div className="iteration-list">
   {summaries.map(item=><button key={item.id} type="button" className="secondary iteration-list-item" onClick={()=>onSelect(item.id)}>
    <strong>{item.title}</strong><span>{approved(item)?'Согласована':'Черновик'} · {item.done_count}/{item.task_count} задач</span></button>)}
   {!summaries.length&&<p className="muted">Создай первую итерацию или попроси ПМ сформировать её.</p>}
  </div>}
  {details&&!editing&&<>
   <section className="iteration-description">{renderBody(details.body)}</section>
   {details.documents.length>0&&<ul className="iteration-links">{details.documents.map(d=><li key={d.id}><a href={documentLink(d.id)}>{d.title}</a></li>)}</ul>}
   <section className="iteration-section">
    <h3><MessageCircle size={16}/> Вопросы перед стартом</h3>
    {!details.questions?.length&&<p className="muted">Открытых вопросов пока нет.</p>}
    {details.questions?.map(q=><div key={q.id} className="iteration-question">
     <strong>{q.question}</strong>
     {q.status==='answered'?<p>Ответ: {q.answer}</p>:<>
      <textarea value={answers[q.id]??''} aria-label={'Ответ на вопрос '+q.question} placeholder="Ваше решение…" onChange={e=>setAnswers(old=>({...old,[q.id]:e.target.value}))}/>
      <div className="iteration-actions"><button className="secondary" type="button" disabled={busy||!answers[q.id]?.trim()} onClick={()=>answer(q)}>Ответить</button></div>
     </>}
    </div>)}
   </section>
   <div className="iteration-actions">
    {!approved(details)&&<button type="button" className="primary" disabled={busy||details.questions?.some(q=>q.status==='open')} onClick={approve}><Check size={15}/> Согласовать итерацию</button>}
    <button type="button" className="secondary" onClick={()=>onChat('project','Проверь итерацию «'+details.title+'» (ID '+details.id+'), принятые решения и план. Доведи подготовку до результата. Запуск готовых задач организуй после моей команды.')}>
     <MessageCircle size={15}/> Поручить ПМ</button>
    {planning&&<small className="muted">СА готовит план задач…</small>}
   </div>
   <section className="iteration-section">
    <h3><ClipboardList size={17}/> План задач</h3>
    {details.planning_runs[0]&&<p className="muted" role="status">{details.planning_runs[0].message}</p>}
    {preview?.stale&&<p className="muted">План устарел после изменения итерации. Актуальная декомпозиция будет подготовлена после согласования.</p>}
    {epics.length>0&&<ul className="iteration-plan-tree">{epics.map(epic=><li key={epic.key}><details open>
     <summary><strong>{epic.title}</strong> <small className="muted">Эпик</small></summary>
     <ul className="iteration-plan-tree">{currentPlan.filter(child=>child.parent===epic.key).map(child=><li className="iteration-child" key={child.key}>
      <details><summary>{child.title} <small className="muted">{child.kind==='analysis'?'Доанализ':'Разработка'} · {child.existing?'Существующая':'Новая'}</small></summary>
       <p>{child.description}</p>{child.existing&&<a href={taskLink(child.existing.id)}>Открыть задачу</a>}</details>
     </li>)}</ul></details></li>)}</ul>}
    {!epics.length&&roots.length>0&&<ul className="iteration-plan-tree">{roots.map(task=><li key={task.id}>
     <div className="iteration-task"><a href={taskLink(task.id)}>#{task.display_number} {task.title}</a><small>{task.type==='epic'?'Эпик':stages.find(s=>s.stage===task.stage)?.label??task.stage}</small></div>
     {details.tasks.filter(child=>child.parent_id===task.id).map(child=><div className="iteration-task iteration-child" key={child.id}>
      <a href={taskLink(child.id)}>#{child.display_number} {child.title}</a><small>{child.depends_on_task_id?'Зависит от '+taskName(child.depends_on_task_id):stages.find(s=>s.stage===child.stage)?.label??child.stage}</small>
     </div>)}</li>)}</ul>}
    {!epics.length&&!roots.length&&<p className="muted">Список задач появится после декомпозиции итерации.</p>}
    <p className="muted">Публикацию плана и запуск разработки организует ПМ. Кнопок ручного запуска задач здесь нет.</p>
   </section>
  </>}
 </div>;
}

export type PlanningOptions={
 sprints:{id:string;name:string;starts_on:string;ends_on:string}[];
 versions:{id:string;name:string}[];
};
export function TaskPlanningFields({task,summaries,save,projectId,request,options,onOptionsChange}:{
 task:{iteration_id?:string|null;tags?:string[];sprint_id?:string|null;version_id?:string|null};
 summaries:IterationSummary[];projectId:string;request:Request;options:PlanningOptions;onOptionsChange:(options:PlanningOptions)=>void;
 save:(values:{iteration_id:string|null;tags:string[];sprint_id:string|null;version_id:string|null})=>Promise<{iteration_id:string|null;tags:string[];sprint_id:string|null;version_id:string|null}>;
}){
 const [iteration,setIteration]=useState(task.iteration_id??'');
 const [tags,setTags]=useState(task.tags?.join(', ')??'');
 const [sprint,setSprint]=useState(task.sprint_id??'');
 const [version,setVersion]=useState(task.version_id??'');
 const [sprintName,setSprintName]=useState('');
 const [from,setFrom]=useState('');
 const [to,setTo]=useState('');
 const [versionName,setVersionName]=useState('');
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const changed=iteration!==(task.iteration_id??'')||tags!==(task.tags?.join(', ')??'')||
  sprint!==(task.sprint_id??'')||version!==(task.version_id??'');
 async function createSprint(){
  if(!sprintName.trim()||!from||!to)return;
  setBusy(true);setError('');
  try{
   const saved=await request<PlanningOptions['sprints'][number]>('/projects/'+projectId+'/sprints',{
    method:'POST',body:JSON.stringify({name:sprintName,starts_on:from,ends_on:to})});
   onOptionsChange({...options,sprints:[saved,...options.sprints]});
   setSprint(saved.id);setSprintName('');setFrom('');setTo('');
  }catch(e){setError(problem(e));}finally{setBusy(false);}
 }
 async function createVersion(){
  if(!versionName.trim())return;
  setBusy(true);setError('');
  try{
   const saved=await request<PlanningOptions['versions'][number]>('/projects/'+projectId+'/versions',{method:'POST',body:JSON.stringify({name:versionName})});
   onOptionsChange({...options,versions:[saved,...options.versions]});
   setVersion(saved.id);setVersionName('');
  }catch(e){setError(problem(e));}finally{setBusy(false);}
 }
 async function submit(event:React.FormEvent){
  event.preventDefault();setBusy(true);setError('');
  try{
   const saved=await save({iteration_id:iteration||null,tags:tags.split(',').map(tag=>tag.trim()).filter(Boolean),
    sprint_id:sprint||null,version_id:version||null});
   setIteration(saved.iteration_id??'');setTags(saved.tags.join(', '));
   setSprint(saved.sprint_id??'');setVersion(saved.version_id??'');
  }catch(e){setError(problem(e));}finally{setBusy(false);}
 }
 return <form className="task-planning-fields" onSubmit={submit}>
  <label>Итерация<select value={iteration} onChange={e=>setIteration(e.target.value)} disabled={busy}>
   <option value="">Без итерации</option>{summaries.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}
  </select></label>
  <label>Спринт<select value={sprint} onChange={e=>setSprint(e.target.value)} disabled={busy}>
   <option value="">Без спринта</option>{options.sprints.map(item=><option key={item.id} value={item.id}>
    {item.name} ({String(item.starts_on).slice(0,10)} — {String(item.ends_on).slice(0,10)})
   </option>)}
  </select></label>
  <details><summary>Создать спринт</summary><div className="iteration-actions">
   <input aria-label="Название спринта" placeholder="Спринт 1" value={sprintName} onChange={e=>setSprintName(e.target.value)} maxLength={180}/>
   <input aria-label="Начало спринта" type="date" value={from} onChange={e=>setFrom(e.target.value)}/>
   <input aria-label="Конец спринта" type="date" value={to} onChange={e=>setTo(e.target.value)}/>
   <button type="button" className="secondary" disabled={busy||!sprintName.trim()||!from||!to||to<from} onClick={()=>void createSprint()}>Создать</button>
  </div></details>
  <label>Версия поставки<select value={version} onChange={e=>setVersion(e.target.value)} disabled={busy}>
   <option value="">Без версии</option>{options.versions.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
  </select></label>
  <details><summary>Создать версию</summary><div className="iteration-actions">
   <input aria-label="Название версии" placeholder="v1.0" value={versionName} onChange={e=>setVersionName(e.target.value)} maxLength={180}/>
   <button type="button" className="secondary" disabled={busy||!versionName.trim()} onClick={()=>void createVersion()}>Создать</button>
  </div></details>
  <label>Теги<input value={tags} onChange={e=>setTags(e.target.value)} maxLength={650} placeholder="Через запятую" disabled={busy}/></label>
  <button type="submit" className="secondary" disabled={busy||!changed}>Сохранить</button>
  {error&&<p className="error" role="alert">{error}</p>}
 </form>;
}
