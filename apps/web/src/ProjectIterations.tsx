import {useEffect,useState} from 'react';
import {ArrowLeft,Check,ClipboardList,MessageCircle,Pencil,Play,Plus} from 'lucide-react';

type Request=<T>(path:string,options?:RequestInit)=>Promise<T>;
export type IterationSummary={id:string;title:string;revision:number;approved_revision:number|null;task_count:number;done_count:number};
type PlanDocument={id:string;title:string};
type PlannedTask={
 id:string;title:string;display_number:number|string;type:string;stage:string;analysis_state:string;
 spec_review_status:string;spec_version:number;spec_reviewed_version:number;clarification_questions:string[];dependency_ready:boolean;
 parent_id:string|null;depends_on_task_id:string|null;iteration_work_kind:'analysis'|'development'|null;tags:string[];
};
type PlanRef={id:string;created_at:string;iteration_revision:number;published_at:string|null};
type IterationDetails=Pick<IterationSummary,'id'|'title'|'revision'|'approved_revision'>&{
 body:string;documents:PlanDocument[];tasks:PlannedTask[];plans:PlanRef[];recommended_task_ids:string[];
 planning_runs:{id:string;status:string;message:string}[];
};
type PlanItem={key:string;title:string;description:string;parent?:string;kind?:'analysis'|'development';depends_on?:string;tags?:string[];existing?:{id:string;title:string};changes?:string[]};
type PlanPreview={
 id:string;items:PlanItem[];unmentioned:{id:string;title:string}[];stale:boolean;preview_revision:string;published_at:string|null;
 result:{created:string[];existing:string[];updated?:string[]}|null;
};
type LaunchResult={id:string;started:boolean;message:string};
const initialDraft={title:'',body:'',document_ids:[] as string[]};
const problem=(error:unknown)=>error instanceof Error?error.message:String(error);
const requestBody=(method:string,body:unknown)=>({method,body:JSON.stringify(body)});
const ready=(task:PlannedTask)=>task.type!=='epic'&&task.stage==='analysis'&&task.analysis_state==='ready_for_development'&&
 task.spec_review_status==='current'&&task.spec_version===task.spec_reviewed_version&&task.dependency_ready&&!task.clarification_questions?.length;
const approved=(item:Pick<IterationSummary,'revision'|'approved_revision'>)=>item.approved_revision===item.revision;
const kindLabel=(kind:PlannedTask['iteration_work_kind'])=>kind==='analysis'?'Доанализ':kind==='development'?'Разработка':'';

export function ProjectIterations({projectId,iterationId,summaries,documents,request,onSelect,onChange,onChat,documentLink,taskLink,stages,renderBody}:{
 projectId:string;iterationId:string|null;summaries:IterationSummary[];documents:PlanDocument[];request:Request;
 onSelect:(id:string|null)=>void;onChange:()=>Promise<void>;
 onChat:(role:'project'|'documentation',message:string)=>void;documentLink:(id:string)=>string;taskLink:(id:string)=>string;
 stages:{stage:string;label:string}[];renderBody:(body:string)=>React.ReactNode;
}){
 const base='/projects/'+projectId+'/iterations';
 const url=iterationId?base+'/'+iterationId:base;
 const [details,setDetails]=useState<IterationDetails|null>(null);
 const [draft,setDraft]=useState(initialDraft);
 const [editing,setEditing]=useState(false);
 const [draftRevision,setDraftRevision]=useState<number|undefined>();
 const [preview,setPreview]=useState<PlanPreview|null>(null);
 const [selectedChanges,setSelectedChanges]=useState<string[]>([]);
 const [selectedTasks,setSelectedTasks]=useState<string[]>([]);
 const [recommendation,setRecommendation]=useState(false);
 const [launchResults,setLaunchResults]=useState<LaunchResult[]>([]);
 const [loading,setLoading]=useState(false);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 useEffect(()=>{
  if(!iterationId)return;
  const controller=new AbortController();
  let first=true;
  const refresh=async()=>{
   try{
    const current=await request<IterationDetails>(url,{signal:controller.signal});
    if(controller.signal.aborted)return;
    setDetails(current);
    if(first){setError('');first=false;}
   }catch(e){if(!controller.signal.aborted&&first)setError(problem(e));}
   finally{if(!controller.signal.aborted)setLoading(false);}
  };
  setLoading(true);
  void refresh();
  const timer=window.setInterval(()=>{if(!document.hidden)void refresh();},7000);
  return()=>{controller.abort();window.clearInterval(timer);};
 },[url,iterationId,request]);
 async function refreshDetails(){if(iterationId)setDetails(await request<IterationDetails>(url));}
 async function perform(action:()=>Promise<void>){
  if(busy)return;
  setBusy(true);setError('');setNotice('');
  try{await action();}catch(e){setError(problem(e));}
  finally{setBusy(false);}
 }
 function edit(){setDraft(details?{title:details.title,body:details.body,document_ids:details.documents.map(doc=>doc.id)}:initialDraft);setDraftRevision(details?.revision);setEditing(true);}
 function save(event:React.FormEvent){
  event.preventDefault();
  void perform(async()=>{
   const saved=await request<{id:string}>(url,requestBody(details?'PUT':'POST',{...draft,expected_revision:draftRevision}));
   setEditing(false);
   if(iterationId)await refreshDetails();
   else onSelect(saved.id);
   await onChange();
  });
 }
 function approve(){
  if(!details)return;
  void perform(async()=>{
   await request(url+'/approve',requestBody('POST',{expected_revision:details.revision}));
   await refreshDetails();await onChange();setNotice('Объём итерации согласован.');
  });
 }
 function openPlan(id:string){
  void perform(async()=>{setPreview(await request<PlanPreview>(url+'/plans/'+id));setSelectedChanges([]);});
 }
 function publish(){
  if(!preview)return;
  void perform(async()=>{
   const result=await request<{created:string[];existing:string[]}>(url+'/plans/'+preview.id+'/publish',requestBody('POST',{confirm:true,preview_revision:preview.preview_revision,selected_changes:selectedChanges}));
   await refreshDetails();await onChange();setPreview(null);
   setNotice('Создано карточек: '+result.created.length+'. Обновлено: '+(result as {updated?:string[]}).updated?.length+'. Уже существовало: '+result.existing.length+'.');
  });
 }
 function useRecommendation(){
  if(!details)return;
  setRecommendation(true);setLaunchResults([]);
  const allowed=new Set(details.tasks.filter(ready).map(task=>task.id));
  setSelectedTasks(details.recommended_task_ids.filter(id=>allowed.has(id)));
 }
 function launch(){
  if(!details||!selectedTasks.length||!window.confirm('Запустить разработку для выбранных задач ('+selectedTasks.length+')?'))return;
  const ids=selectedTasks;
  void perform(async()=>{
   const result=await request<{results:LaunchResult[]}>(url+'/launch',requestBody('POST',{confirm:true,task_ids:ids,expected_revision:details.revision}));
   setLaunchResults(result.results);setSelectedTasks([]);
   await refreshDetails();await onChange();
  });
 }
 const validSelection=!!details&&selectedTasks.every(id=>details.tasks.some(task=>task.id===id&&ready(task)));
 const groupedTasks=details?.tasks.filter(task=>!task.parent_id||!details.tasks.some(parent=>parent.id===task.parent_id&&parent.type==='epic'))
  .flatMap(task=>task.type==='epic'?[task,...details.tasks.filter(child=>child.parent_id===task.id&&child.type!=='epic')]:[task])??[];
 const taskName=(id:string)=>details?.tasks.find(task=>task.id===id)?.title||id;
 const planning=details?.planning_runs.some(run=>run.status==='queued'||run.status==='running');
 function preparePlan(){
  void perform(async()=>{
   await request(url+'/prepare',requestBody('POST',{}));
   await refreshDetails();
  });
 }
 const askLaunch=(item:IterationDetails)=>onChat('project','Предложи первый пакет задач для запуска по итерации «'+item.title+'» (ID '+item.id+'). Учти готовность и зависимости.');
 return <div className="iteration-workspace">
  <header className="iteration-header">
   <div>{iterationId&&<button type="button" className="textbtn iteration-back" onClick={()=>onSelect(null)}><ArrowLeft size={14}/> План разработки</button>}
    <h2>{details?.title??(iterationId?'Итерация':'План разработки')}</h2>
    {details?<small className="muted">Редакция {details.revision} · {approved(details)?'Согласована':'Черновик'}</small>:
     !iterationId&&<p className="muted">Итерации проекта, эпики и порядок запуска задач</p>}
   </div>
   {!editing&&(!iterationId||details)&&<button type="button" className="secondary" disabled={busy} onClick={edit}>
    {details?<><Pencil size={15}/> Изменить</>:<><Plus size={16}/> Итерация</>}
   </button>}
  </header>
  {loading&&<p className="muted" role="status">Загрузка…</p>}
  {error&&<p className="error" role="alert">{error}</p>}
  {notice&&<p role="status">{notice}</p>}
  {editing&&<form className="iteration-editor" onSubmit={save}>
   <label>Название<input value={draft.title} maxLength={180} required onChange={e=>setDraft({...draft,title:e.target.value})} placeholder="MVP"/></label>
   <label>Цель, границы и критерии готовности<textarea value={draft.body} maxLength={16000} required rows={7}
    onChange={e=>setDraft({...draft,body:e.target.value})} placeholder={'## Цель\n\n## Входит в итерацию\n\n## За пределами итерации\n\n## Критерии готовности'}/></label>
   {documents.length>0&&<details><summary>Связанные документы ({draft.document_ids.length})</summary><div className="iteration-doc-picker">
    {documents.map(doc=><label key={doc.id}><input type="checkbox" checked={draft.document_ids.includes(doc.id)}
     disabled={draft.document_ids.length>=30&&!draft.document_ids.includes(doc.id)}
     onChange={e=>setDraft({...draft,document_ids:e.target.checked?[...draft.document_ids,doc.id]:draft.document_ids.filter(id=>id!==doc.id)})}/>{doc.title}</label>)}
   </div></details>}
   <div className="iteration-actions"><button type="button" className="secondary" disabled={busy} onClick={()=>setEditing(false)}>Отмена</button>
    <button type="submit" className="primary" disabled={busy||!draft.title.trim()||!draft.body.trim()}>Сохранить</button></div>
  </form>}
  {!iterationId&&!editing&&<div className="iteration-list">
   {summaries.map(item=><button key={item.id} type="button" className="secondary iteration-list-item" onClick={()=>onSelect(item.id)}>
    <strong>{item.title}</strong><span>{approved(item)?'Согласована':'Черновик'} · Готово {item.done_count} из {item.task_count}</span></button>)}
   {!summaries.length&&<p className="muted">Создай первую итерацию здесь или попроси БА сохранить обсуждённый объём.</p>}
  </div>}
  {details&&!editing&&<>
   <div className="iteration-description">{renderBody(details.body)}</div>
   {details.documents.length>0&&<ul className="iteration-links">{details.documents.map(doc=><li key={doc.id}><a href={documentLink(doc.id)}>{doc.title}</a></li>)}</ul>}
   <div className="iteration-actions">
    {!approved(details)&&<button type="button" className="primary" disabled={busy} onClick={approve}><Check size={16}/> Согласовать объём</button>}
    <button type="button" className="secondary" disabled={busy||planning||!approved(details)} onClick={preparePlan}><ClipboardList size={15}/> Подготовить план задач</button>
    <button type="button" className="secondary" disabled={busy||!details.tasks.some(task=>task.type!=='epic')} onClick={()=>askLaunch(details)}><MessageCircle size={15}/> Обсудить запуск с ПМ</button>
   </div>
   <section className="iteration-section">
    <h3><ClipboardList size={17}/> Планы задач</h3>
    {details.planning_runs[0]&&<p role="status">{details.planning_runs[0].message}</p>}
    {details.plans.length===0&&<p className="muted">Черновик декомпозиции появится здесь после работы СА.</p>}
    <div className="iteration-actions">{details.plans.map(plan=><button type="button" key={plan.id} className="secondary" disabled={busy}
     onClick={()=>openPlan(plan.id)}>{plan.published_at?'Опубликован':'Предпросмотр'} · {new Date(plan.created_at).toLocaleString('ru-RU')}</button>)}</div>
    {preview&&<div className="iteration-preview">
     <h4>{preview.published_at?'Опубликованный план':'Предпросмотр плана'}</h4>
     {!preview.published_at&&<p>Задачи на разработку будут готовы к отдельному запуску. Задачи на доанализ появятся в колонке «Анализ».</p>}
     {preview.stale&&!preview.published_at&&<p className="error">Объём или исходные документы изменились. Подготовь новый черновик.</p>}
     {preview.result&&<p>Создано карточек: {preview.result.created.length}. Обновлено: {preview.result.updated?.length??0}. Уже существовало: {preview.result.existing.length}.</p>}
     {preview.items.map(item=><details key={item.key} className={item.parent?'iteration-child':''}>
      <summary>{item.parent?kindLabel(item.kind??null):'Эпик'} · {item.title} · {item.existing?(item.changes?.length?'Изменена':'Без изменений'):'Новая карточка'}</summary>
      <p>{item.description}</p>
      {item.existing&&<p>Сохранится текущая карточка <a href={taskLink(item.existing.id)}>{item.existing.title}</a>.</p>}
       {item.existing&&!!item.changes?.length&&<label><input type="checkbox" checked={selectedChanges.includes(item.key)} onChange={e=>setSelectedChanges(old=>e.target.checked?[...old,item.key]:old.filter(k=>k!==item.key))}/> Применить изменения: {item.changes.join(', ')}</label>}
      {!!item.tags?.length&&<small>Теги: {item.tags.join(', ')}. </small>}
      {item.depends_on&&<small>Зависит от {preview.items.find(task=>task.key===item.depends_on)?.title}</small>}
     </details>)}
     {!!preview.unmentioned.length&&<p className="muted">В черновик не входят и сохранятся: {preview.unmentioned.map(item=>item.title).join(', ')}.</p>}
     <div className="iteration-actions">
      <button type="button" className="secondary" disabled={busy} onClick={()=>setPreview(null)}>Закрыть</button>
      {!preview.published_at&&<button type="button" className="primary" disabled={busy||preview.stale} onClick={publish}>Опубликовать задачи</button>}
     </div>
    </div>}
   </section>
   <section className="iteration-section">
    <h3><Play size={17}/> Эпики и задачи</h3>
    {!details.tasks.length&&<p className="muted">Связанных задач пока нет.</p>}
    {!!details.recommended_task_ids.length&&<div className="iteration-actions">
     <button type="button" className="secondary" disabled={busy} onClick={useRecommendation}>Выбрать рекомендованные ПМ</button>
     <small className="muted">{details.recommended_task_ids.map(taskName).join(' → ')}</small>
    </div>}
    {groupedTasks.map(task=><div key={task.id} className={'iteration-task '+(task.parent_id?'iteration-child':'')}>
     {task.type!=='epic'&&<input type="checkbox" aria-label={'Выбрать задачу '+task.title} checked={selectedTasks.includes(task.id)}
      disabled={busy||!ready(task)||selectedTasks.length>=5&&!selectedTasks.includes(task.id)}
      onChange={e=>{setRecommendation(false);setSelectedTasks(old=>e.target.checked?[...old,task.id]:old.filter(id=>id!==task.id));}}/>}
     <a href={taskLink(task.id)}>#{task.display_number} {task.title}</a>
     <small>{task.type==='epic'?'Эпик':ready(task)?'Готова к запуску':stages.find(stage=>stage.stage===task.stage)?.label??task.stage}{task.iteration_work_kind?' · '+kindLabel(task.iteration_work_kind):''}</small>
     {task.depends_on_task_id&&<small>{task.dependency_ready?'Зависит от':'Ждёт зависимости'} <a href={taskLink(task.depends_on_task_id)}>{taskName(task.depends_on_task_id)}</a></small>}
    </div>)}
    {details.tasks.some(task=>task.type!=='epic')&&<div className="iteration-actions">
     <button type="button" className="primary" disabled={busy||!approved(details)||!selectedTasks.length||!validSelection} onClick={launch}><Play size={15}/> Запустить выбранные ({selectedTasks.length})</button>
     <small className="muted">{recommendation&&!selectedTasks.length?'В рекомендации ПМ пока нет задач, готовых к запуску.':'До 5 готовых задач за один запуск.'}</small>
    </div>}
    {!!launchResults.length&&<ul aria-label="Результат запуска">{launchResults.map(item=><li key={item.id}><strong>{taskName(item.id)}</strong> — {item.started?'Принята в очередь':'Ожидает'} · {item.message}</li>)}</ul>}
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
