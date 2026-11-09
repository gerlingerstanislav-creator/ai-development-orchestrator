import React,{useEffect,useMemo,useState} from 'react';
import {BookOpen,CheckCircle2,ClipboardCheck,FilePlus2,Pencil,RefreshCw,Save,X} from 'lucide-react';

type TestStep={action:string;expected:string};
type Flow={id:string;title:string;description:string;preconditions:string;steps:string[];task_number?:number};
type QaCase={id:string;title:string;area:string;description:string;preconditions:string;steps:TestStep[];priority:'critical'|'high'|'normal'|'low';category:'smoke'|'regression'|'functional';execution_mode:'automated'|'manual'|'hybrid';status:'active'|'needs_review'|'archived';flow_id:string|null;source_task_id?:string;task_number?:number};
type Plan={id:string;task_id:string;task_title:string;task_number:number;summary:string;generated_at:string;cases:Array<{id:string;purpose:string}>};
type Result={case_id:string;result:string;evidence:string;created_at:string;test_run_id:string;task_id:string};
type QaData={flows:Flow[];cases:QaCase[];plans:Plan[];results:Result[]};
type Request=<T=any>(path:string,options?:RequestInit)=>Promise<T>;
const newCase=():Omit<QaCase,'id'|'source_task_id'|'task_number'>=>({
 title:'',area:'general',description:'',preconditions:'',steps:[{action:'',expected:''}],priority:'normal',category:'functional',execution_mode:'hybrid',status:'active',flow_id:null
});
const priorityLabel:Record<string,string>={critical:'Критичный',high:'Высокий',normal:'Обычный',low:'Низкий'};
const categoryLabel:Record<string,string>={smoke:'Smoke',regression:'Регрессия',functional:'Функциональный'};

export function QaPanel({projectId,api,onError}:{projectId:string;api:Request;onError:(error:unknown)=>void}){
 const [data,setData]=useState<QaData|null>(null);
 const [selectedId,setSelectedId]=useState<string|null>(null);
 const [filter,setFilter]=useState('');
 const [editor,setEditor]=useState<QaCase|ReturnType<typeof newCase>|null>(null);
 const [busy,setBusy]=useState(false);
 const [manualResult,setManualResult]=useState<'passed'|'failed'|'blocked'>('passed');
 const [manualEvidence,setManualEvidence]=useState('');
 const [manualSuccess,setManualSuccess]=useState('');
 const [flowExpanded,setFlowExpanded]=useState<string|null>(null);
 const [creatingFlow,setCreatingFlow]=useState(false);
 const [flowDraft,setFlowDraft]=useState({title:'',description:'',preconditions:'',steps:'Шаг 1'});
 const reload=async()=>{
  const result=await api<QaData>('/projects/'+projectId+'/qa');
  setData(result);
  setSelectedId(id=>id&&result.cases.some(c=>c.id===id)?id:(result.cases[0]?.id||null));
 };
 useEffect(()=>{setData(null);setSelectedId(null);void reload().catch(onError);},[projectId]);
 const cases=useMemo(()=>data?.cases.filter(c=>[c.title,c.area,String(c.task_number||'')].join(' ').toLowerCase().includes(filter.toLowerCase()))||[],[data,filter]);
 const selected=data?.cases.find(c=>c.id===selectedId)||null;
 const save=async()=>{
  if(!editor||busy)return;
  if(!editor.title.trim()||!editor.area.trim()||editor.steps.some(s=>!s.action.trim()||!s.expected.trim())){onError(new Error('Заполни название, область и все шаги с ожидаемыми результатами'));return;}
  setBusy(true);
  try{
   const id='id' in editor?editor.id:null;
   await api('/projects/'+projectId+'/qa/cases'+(id?'/'+id:''),{method:id?'PATCH':'POST',body:JSON.stringify(editor)});
   await reload();setEditor(null);
  }catch(e){onError(e);}finally{setBusy(false);}
 };
 const saveFlow=async()=>{
  const steps=flowDraft.steps.split('\n').map(v=>v.trim()).filter(Boolean);
  if(!flowDraft.title.trim()||!steps.length)return onError(new Error('Укажи название и шаги сценария'));
  setBusy(true);
  try{
   await api('/projects/'+projectId+'/qa/flows',{method:'POST',body:JSON.stringify({...flowDraft,steps})});
   setCreatingFlow(false);setFlowDraft({title:'',description:'',preconditions:'',steps:'Шаг 1'});await reload();
  }catch(e){onError(e);}finally{setBusy(false);}
 };
 const submitManualResult=async()=>{
  if(!selected||!manualEvidence.trim())return onError(new Error('Опиши доказательство результата проверки'));
  setBusy(true);
  try{
   await api('/projects/'+projectId+'/qa/cases/'+selected.id+'/manual-result',{method:'POST',body:JSON.stringify({result:manualResult,evidence:manualEvidence})});
   setManualSuccess('Результат ручной проверки сохранён отдельно от AI-прогонов');
   setManualEvidence('');
  }catch(e){onError(e);}finally{setBusy(false);}
 };
 return <div className="qa-page">
  <div className="row-line qa-heading">
   <div><h2>Тестирование · Библиотека проверок</h2><p className="muted">AI-тестировщик готовит сценарии по утверждённым требованиям перед разработкой. Позже они используются при проверке PR и регрессии.</p></div>
   <div className="qa-buttons"><button className="secondary" onClick={()=>void reload().catch(onError)}><RefreshCw size={15}/> Обновить</button><button className="secondary" onClick={()=>setCreatingFlow(true)}><BookOpen size={15}/> Сценарий</button><button className="primary" onClick={()=>setEditor(newCase())}><FilePlus2 size={15}/> Тест-кейс</button></div>
  </div>
  {!data?<div className="panel"><p className="muted">Загрузка тестовой документации…</p></div>:<>
   <div className="qa-summary">
    <span>Сценарии: <strong>{data.flows.length}</strong></span>
    <span>Тест-кейсы: <strong>{data.cases.length}</strong></span>
    <span>Планы задач: <strong>{data.plans.length}</strong></span>
    <span>Нуждаются в проверке: <strong>{data.cases.filter(c=>c.status==='needs_review').length}</strong></span>
   </div>
   <div className="qa-layout">
    <aside className="panel qa-sidebar">
     <h3>Тест-кейсы</h3>
     <input className="search" placeholder="Название, область, № задачи…" value={filter} onChange={e=>setFilter(e.target.value)}/>
     <div className="qa-case-list">{cases.map(c=><button key={c.id} className={'qa-case-item '+(selectedId===c.id?'chosen':'')} onClick={()=>{setSelectedId(c.id);setManualSuccess('');}}>
      <strong>{c.title}</strong><small>{c.area} · {categoryLabel[c.category]} · {priorityLabel[c.priority]}{c.task_number?' · #'+c.task_number:''}</small>{c.status==='needs_review'&&<small className="qa-warning">Ожидания требуют проверки</small>}
     </button>)}{cases.length===0&&<p className="muted">Пока нет тест-кейсов.</p>}</div>
    </aside>
    <section className="panel qa-details">
     {selected?<><div className="row-line"><h3>{selected.title}</h3><button className="secondary" onClick={()=>setEditor({...selected,steps:selected.steps.map(s=>({...s}))})}><Pencil size={15}/> Редактировать</button></div>
      <div className="qa-tags"><span>{categoryLabel[selected.category]}</span><span>{priorityLabel[selected.priority]}</span><span>{selected.execution_mode}</span><span>{selected.status}</span></div>
      {selected.description&&<p>{selected.description}</p>}
      <p><strong>Предусловия:</strong> {selected.preconditions||'Без специальных условий'}</p>
      <table className="qa-steps"><thead><tr><th>№</th><th>Действие</th><th>Ожидаемый результат</th></tr></thead><tbody>{selected.steps.map((s,i)=><tr key={i}><td>{i+1}</td><td>{s.action}</td><td>{s.expected}</td></tr>)}</tbody></table>
      {selected.flow_id&&<p className="muted">Сценарий: {data.flows.find(f=>f.id===selected.flow_id)?.title||'Не найден'}</p>}
      <div className="qa-related"><h4>Последние AI-проверки</h4>{data.results.filter(r=>r.case_id===selected.id).slice(0,5).map(r=><p key={r.test_run_id}><strong>{r.result}</strong> · {new Date(r.created_at).toLocaleString('ru-RU')} · {r.evidence||'Нет доказательства'}</p>)}{!data.results.some(r=>r.case_id===selected.id)&&<p className="muted">Проверок пока нет.</p>}</div>
      <div className="qa-manual"><h4>Зафиксировать ручную проверку</h4><div className="qa-buttons"><select value={manualResult} onChange={e=>setManualResult(e.target.value as typeof manualResult)}><option value="passed">Пройден</option><option value="failed">Ошибка</option><option value="blocked">Заблокирован</option></select><input value={manualEvidence} onChange={e=>setManualEvidence(e.target.value)} placeholder="Окружение, версия, фактический результат" /><button className="secondary" disabled={busy||!manualEvidence.trim()} onClick={()=>void submitManualResult()}><CheckCircle2 size={15}/> Сохранить</button></div>{manualSuccess&&<small>{manualSuccess}</small>}</div>
     </>:<p className="muted">Выбери тест-кейс слева или создай новый.</p>}
    </section>
   </div>
   <div className="qa-bottom">
    <section className="panel"><h3>Пользовательские сценарии</h3>{data.flows.map(f=><div className="qa-flow" key={f.id}><button className="qa-flow-toggle" onClick={()=>setFlowExpanded(id=>id===f.id?null:f.id)}><strong>{f.title}</strong><small>{f.task_number?'Задача #'+f.task_number:''}</small></button>{flowExpanded===f.id&&<div><p>{f.description}</p><p><strong>Условия:</strong> {f.preconditions||'Нет'}</p><ol>{f.steps.map((s,i)=><li key={i}>{s}</li>)}</ol></div>}</div>)}{data.flows.length===0&&<p className="muted">Сценарии будут сформированы при следующем запуске разработки.</p>}</section>
    <section className="panel"><h3>Автоматически сформированные планы</h3>{data.plans.map(p=><div className="qa-plan" key={p.id}><a href={'/projects/'+projectId+'/tasks/'+p.task_id}>Задача #{p.task_number} · {p.task_title}</a><p>{p.summary}</p><small>Выбрано проверок: {p.cases.length}, из них регрессия: {p.cases.filter(c=>c.purpose==='regression').length}</small></div>)}{data.plans.length===0&&<p className="muted">Планы создаются AI-тестировщиком до запуска разработчика.</p>}</section>
   </div>
  </>}
  {editor&&<div className="overlay" onMouseDown={()=>setEditor(null)}><div className="dialog qa-editor" onMouseDown={e=>e.stopPropagation()}>
   <div className="modal-heading"><h2>{'id' in editor?'Редактировать тест-кейс':'Новый тест-кейс'}</h2><button onClick={()=>setEditor(null)}><X size={18}/></button></div>
   <label>Название<input value={editor.title} onChange={e=>setEditor({...editor,title:e.target.value})}/></label>
   <div className="qa-edit-row"><label>Область<input value={editor.area} onChange={e=>setEditor({...editor,area:e.target.value})}/></label><label>Приоритет<select value={editor.priority} onChange={e=>setEditor({...editor,priority:e.target.value as QaCase['priority']})}>{Object.entries(priorityLabel).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></div>
   <div className="qa-edit-row"><label>Набор<select value={editor.category} onChange={e=>setEditor({...editor,category:e.target.value as QaCase['category']})}>{Object.entries(categoryLabel).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>Тип<select value={editor.execution_mode} onChange={e=>setEditor({...editor,execution_mode:e.target.value as QaCase['execution_mode']})}><option value="hybrid">Гибридный</option><option value="automated">Автоматизируемый</option><option value="manual">Ручной</option></select></label></div>
   <div className="qa-edit-row"><label>Сценарий<select value={editor.flow_id||''} onChange={e=>setEditor({...editor,flow_id:e.target.value||null})}><option value="">Без сценария</option>{data?.flows.map(f=><option key={f.id} value={f.id}>{f.title}</option>)}</select></label><label>Состояние<select value={editor.status} onChange={e=>setEditor({...editor,status:e.target.value as QaCase['status']})}><option value="active">Активный</option><option value="needs_review">Требует пересмотра</option><option value="archived">Архив</option></select></label></div>
   <label>Описание<textarea rows={2} value={editor.description} onChange={e=>setEditor({...editor,description:e.target.value})}/></label>
   <label>Предусловия<textarea rows={2} value={editor.preconditions} onChange={e=>setEditor({...editor,preconditions:e.target.value})}/></label>
   <div className="qa-editor-steps"><h4>Шаги и ожидаемые результаты</h4>{editor.steps.map((s,i)=><div className="qa-edit-step" key={i}><input placeholder={'Действие '+(i+1)} value={s.action} onChange={e=>setEditor({...editor,steps:editor.steps.map((v,j)=>i===j?{...v,action:e.target.value}:v)})}/><input placeholder="Ожидаемый результат" value={s.expected} onChange={e=>setEditor({...editor,steps:editor.steps.map((v,j)=>i===j?{...v,expected:e.target.value}:v)})}/><button className="secondary" disabled={editor.steps.length<=1} onClick={()=>setEditor({...editor,steps:editor.steps.filter((_,j)=>j!==i)})}><X size={14}/></button></div>)}<button className="secondary" disabled={editor.steps.length>=20} onClick={()=>setEditor({...editor,steps:[...editor.steps,{action:'',expected:''}]})}>+ Шаг</button></div>
   <footer><button className="secondary" onClick={()=>setEditor(null)}>Отмена</button><button className="primary" disabled={busy} onClick={()=>void save()}><Save size={15}/> Сохранить</button></footer>
  </div></div>}
  {creatingFlow&&<div className="overlay" onMouseDown={()=>setCreatingFlow(false)}><div className="dialog" onMouseDown={e=>e.stopPropagation()}><div className="modal-heading"><h2>Новый пользовательский сценарий</h2><button onClick={()=>setCreatingFlow(false)}><X size={18}/></button></div><label>Название<input value={flowDraft.title} onChange={e=>setFlowDraft({...flowDraft,title:e.target.value})}/></label><label>Описание<textarea rows={3} value={flowDraft.description} onChange={e=>setFlowDraft({...flowDraft,description:e.target.value})}/></label><label>Предусловия<textarea rows={2} value={flowDraft.preconditions} onChange={e=>setFlowDraft({...flowDraft,preconditions:e.target.value})}/></label><label>Шаги (один на строку)<textarea rows={6} value={flowDraft.steps} onChange={e=>setFlowDraft({...flowDraft,steps:e.target.value})}/></label><footer><button className="secondary" onClick={()=>setCreatingFlow(false)}>Отмена</button><button className="primary" disabled={busy} onClick={()=>void saveFlow()}>Сохранить</button></footer></div></div>}
 </div>;
}
