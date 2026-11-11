import {useEffect,useMemo,useState} from 'react';
import {BookOpen,Brain,ChevronRight,History,Pencil,Plus,RefreshCcw,ShieldCheck,Trash2,Users,X} from 'lucide-react';
import {aiAgentName} from './agent-labels.js';
import {KnowledgeInstructions} from './KnowledgeInstructions.js';
import './ProjectTeam.css';

type Responsibility={mission:string;inputs:string[];outcomes:string[];maxConcurrent:number};
type Agent={id:string;role:string;name:string;stage:string;type:'workflow'|'specialist'|'conversation';instructions:string;model:string|null;responsibility:Responsibility|null};
type Memory={id:string;role:string;kind:string;body:string;evidence:string;status:string;origin:'agent'|'user';author_email?:string|null;created_at:string;reviewed_at:string|null};
type Snapshot={agents:Agent[];memory:Memory[]};
type Revision={id:string;previous_name:string;previous_instructions:string;next_name:string;next_instructions:string;created_at:string};
type Request=<T>(path:string,options?:RequestInit)=>Promise<T>;
const roleLabels:Record<string,string>={manager:'ПМ',analyst:'БА',analysis:'СА',development:'Разработчик',testing:'QA',deployment:'DevOps',devops:'DevOps',documentation:'Документатор'};
const kindName=(kind:string)=>kind==='observation'?'Наблюдение':kind==='instruction_suggestion'?'Предложение инструкции':kind;
const statusName=(status:string)=>status==='approved'?'Утверждено':status==='rejected'?'Отклонено':status==='recorded'?'Зафиксировано':status==='pending'?'На рассмотрении':status;
export function ProjectTeam({projectId,request}:{projectId:string;request:Request}){
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null);
 const [selectedId,setSelectedId]=useState('conversation:manager');
 const [filter,setFilter]=useState<'all'|'active'|'pending'>('all');
 const [loading,setLoading]=useState(false);
 const [saving,setSaving]=useState(false);
 const [error,setError]=useState('');
 const [editing,setEditing]=useState(false);
 const [draft,setDraft]=useState({name:'',instructions:''});
 const [adding,setAdding]=useState(false);
 const [memoryText,setMemoryText]=useState('');
 const [memoryEvidence,setMemoryEvidence]=useState('');
 const [historyOpen,setHistoryOpen]=useState(false);
 const [history,setHistory]=useState<Revision[]>([]);
 const refresh=async()=>{setLoading(true);setError('');try{setSnapshot(await request<Snapshot>('/projects/'+projectId+'/team'));}catch(e){setError(e instanceof Error?e.message:'Не удалось получить данные команды');}finally{setLoading(false);}};
 useEffect(()=>{setSnapshot(null);setSelectedId('conversation:manager');setEditing(false);setAdding(false);setHistoryOpen(false);void refresh();},[projectId]);
 const agents=snapshot?.agents||[];
 const selected=agents.find(a=>a.id===selectedId)||agents[0];
 const memories=useMemo(()=>snapshot?.memory.filter(m=>selected?.role===m.role)||[],[snapshot,selected]);
 const active=memories.filter(m=>m.kind==='observation'&&m.status!=='rejected'||m.kind==='instruction_suggestion'&&m.status==='approved');
 const pending=memories.filter(m=>m.kind==='instruction_suggestion'&&m.status!=='approved'&&m.status!=='rejected');
 const visible=filter==='active'?active:filter==='pending'?pending:memories;
 const base=selected?'/projects/'+projectId+'/team/'+selected.role:'';
 const options=(method:string,body?:unknown):RequestInit=>({method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
 function beginEdit(){if(!selected)return;setDraft({name:selected.name,instructions:selected.instructions});setEditing(true);}
 async function mutate(action:()=>Promise<unknown>){if(saving)return;setSaving(true);setError('');try{await action();await refresh();}catch(e){setError(e instanceof Error?e.message:'Не удалось сохранить изменения');}finally{setSaving(false);}}
 async function saveProfile(){if(!selected)return;await mutate(async()=>{await request(base,options('PATCH',draft));setEditing(false);});}
 async function addMemory(){if(!selected||!memoryText.trim())return;await mutate(async()=>{await request(base+'/memory',options('POST',{body:memoryText.trim(),evidence:memoryEvidence.trim()}));setAdding(false);setMemoryText('');setMemoryEvidence('');});}
 async function reviewMemory(id:string,status:'approved'|'rejected'){await mutate(()=>request(base+'/memory/'+id,options('PATCH',{status})));}
 async function removeMemory(id:string){if(!window.confirm('Удалить пользовательскую инструкцию?'))return;await mutate(()=>request(base+'/memory/'+id,options('DELETE')));}
 async function changeModel(value:string){
  if(!selected)return;
  await mutate(()=>request(base+'/model',options('PATCH',{model:value||null})));
 }
 async function showHistory(){if(!selected)return;setHistoryOpen(true);setError('');try{const result=await request<{history:Revision[]}>(base+'/history');setHistory(result.history);}catch(e){setError(e instanceof Error?e.message:'Не удалось загрузить историю');}}
 return <div className="team-page">
  <div className="team-heading"><div><h2><Users size={20}/> Команда</h2><p className="muted">Настройки ролей, рабочие инструкции и накопленные знания. Утверждённые записи становятся частью контекста агента при следующем запуске.</p></div><button className="secondary" type="button" onClick={()=>void refresh()} disabled={loading}><RefreshCcw size={15}/>{loading?'Обновление…':'Обновить'}</button></div>
  {error&&<p className="error" role="alert">{error}</p>}
  <div className="team-layout">
   <nav className="team-agents" aria-label="Агенты проекта">
    <div className="team-list-heading">Роли <span>{agents.length}</span></div>
    {agents.map(agent=><button type="button" key={agent.id} className={'team-agent '+(selected?.id===agent.id?'selected':'')} aria-current={selected?.id===agent.id?'page':undefined} onClick={()=>{setSelectedId(agent.id);setFilter('all');setEditing(false);setAdding(false);setHistoryOpen(false);}}>
     <span className="team-agent-avatar">{(roleLabels[agent.role]||agent.name).slice(0,2).toUpperCase()}</span>
     <span className="team-agent-label"><strong title={aiAgentName(agent.name)}>{aiAgentName(agent.name)}</strong><small>{agent.stage}</small></span><ChevronRight size={15}/>
    </button>)}
    {!agents.length&&<p className="muted">Роли не найдены.</p>}
   </nav>
   <div className="team-detail">
    {selected?<><header className="team-detail-heading"><div><span className="team-kicker">{selected.type==='conversation'?'Диалоговый агент':selected.type==='specialist'?'Специалист':'Роль workflow'}</span><h3>{aiAgentName(selected.name)}</h3><p className="muted">{selected.stage}</p></div></header>
     <section className="team-instruction-block team-model-settings"><h4>Модель агента</h4>
      <label>Исполнитель
       <select value={selected.model??''} disabled={saving} onChange={e=>void changeModel(e.target.value)}>
        <option value="">Наследовать модель проекта</option>
        <option value="gpt-6-luna">GPT-6 Luna</option>
        <option value="gpt-6-sol">GPT-6 Sol</option>
        <option value="gpt-6.1-sol">GPT-6.1 Sol</option>
       </select>
      </label>
      <p className="muted">Переопределение действует только для выбранной роли. Если не указано — используется модель проекта. Изменение применяется к новым запускам.</p>
     </section>
     {selected.responsibility&&<section className="team-instruction-block team-responsibility"><h4><ShieldCheck size={16}/> Зона ответственности</h4><p>{selected.responsibility.mission}</p><div className="team-responsibility-grid"><div><strong>Получает</strong><ul>{selected.responsibility.inputs.map(item=><li key={item}>{item}</li>)}</ul></div><div><strong>Обязательный результат</strong><ul>{selected.responsibility.outcomes.map(item=><li key={item}>{item}</li>)}</ul></div></div><small className="team-source">Одновременных исполнений роли: {selected.responsibility.maxConcurrent}. Очередь продолжает работу после освобождения слота.</small></section>}
     <section className="team-instruction-block"><h4><ShieldCheck size={16}/> Системные ограничения</h4><p className="muted">Ограничения безопасности, права инструментов, порядок проверок и слияния PR остаются в коде. Они не редактируются и не могут быть отменены инструкциями проекта. Внутренние промпты провайдера не раскрываются.</p></section>
     <section className="team-instruction-block"><div className="team-section-toolbar"><h4><BookOpen size={16}/> Инструкции роли</h4><div className="team-actions">{!editing&&<><button className="secondary" type="button" onClick={()=>void showHistory()}><History size={14}/> История</button><button className="secondary" type="button" onClick={beginEdit}><Pencil size={14}/> Изменить</button></>}</div></div>
      {editing?<div className="team-editor"><label>Название агента<input maxLength={120} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label><label>Инструкции<textarea rows={12} maxLength={12000} value={draft.instructions} onChange={e=>setDraft({...draft,instructions:e.target.value})}/></label><div className="team-actions"><button className="secondary" type="button" disabled={saving} onClick={()=>setEditing(false)}>Отмена</button><button className="primary" type="button" disabled={saving||!draft.name.trim()} onClick={()=>void saveProfile()}>{saving?'Сохранение…':'Сохранить'}</button></div></div>:
      selected.instructions?<pre className="team-instruction-text">{selected.instructions}</pre>:<p className="muted">Пока нет инструкций. Добавьте их через редактирование роли.</p>}
      <small className="team-source">Источник: {selected.type==='workflow'?'workflow_stages':selected.type==='specialist'?'project_specialist_agents':'project_conversation_agents'}. Эти инструкции применяются при формировании контекста агента.</small>
      {historyOpen&&<div className="team-history"><div className="team-section-toolbar"><strong>История изменений</strong><button type="button" className="secondary" onClick={()=>setHistoryOpen(false)} aria-label="Закрыть историю"><X size={14}/></button></div>{history.length?history.map(item=><details key={item.id}><summary>{new Date(item.created_at).toLocaleString('ru-RU')} · Изменение инструкций</summary><strong>До</strong><pre className="team-instruction-text">{item.previous_name+'\n'+item.previous_instructions}</pre><strong>После</strong><pre className="team-instruction-text">{item.next_name+'\n'+item.next_instructions}</pre></details>):<p className="muted">Изменений пока нет.</p>}</div>}
     </section>
     <section className="team-instruction-block"><div className="team-memory-title"><h4><Brain size={16}/> Память <span className="team-count">{memories.length}</span></h4><div className="team-actions"><button className="secondary" type="button" onClick={()=>setAdding(value=>!value)}><Plus size={14}/> Добавить инструкцию</button></div></div>
      {adding&&<div className="team-editor"><label>Новая инструкция<textarea rows={4} maxLength={1600} value={memoryText} onChange={e=>setMemoryText(e.target.value)} placeholder="Что агент должен учитывать при дальнейшей работе?"/></label><label>Причина или источник (необязательно)<input maxLength={600} value={memoryEvidence} onChange={e=>setMemoryEvidence(e.target.value)}/></label><div className="team-actions"><button type="button" className="secondary" onClick={()=>setAdding(false)}>Отмена</button><button type="button" className="primary" disabled={saving||memoryText.trim().length<5} onClick={()=>void addMemory()}>Добавить</button></div></div>}
      <div className="team-filters"><button type="button" className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>Все ({memories.length})</button><button type="button" className={filter==='active'?'active':''} onClick={()=>setFilter('active')}>Применяются ({active.length})</button><button type="button" className={filter==='pending'?'active':''} onClick={()=>setFilter('pending')}>На рассмотрении ({pending.length})</button></div>
      {visible.length?visible.map(m=><article className="team-memory-item" key={m.id}><div className="team-memory-meta"><strong>{kindName(m.kind)}</strong><span>{statusName(m.status)}</span><span>{m.origin==='user'?'Пользователь':'Агент'}</span><time dateTime={m.created_at}>{new Date(m.created_at).toLocaleString('ru-RU')}</time></div><p>{m.body}</p>{m.evidence&&<small className="team-source">Основание: {m.evidence}</small>}
       {m.kind==='instruction_suggestion'&&<div className="team-actions">{m.origin==='agent'&&m.status!=='approved'&&<button className="secondary" type="button" disabled={saving} onClick={()=>void reviewMemory(m.id,'approved')}>Принять</button>}{m.origin==='agent'&&m.status!=='rejected'&&<button className="secondary" type="button" disabled={saving} onClick={()=>void reviewMemory(m.id,'rejected')}>Отклонить</button>}{m.origin==='user'&&<button className="secondary" type="button" disabled={saving} onClick={()=>void removeMemory(m.id)}><Trash2 size={13}/> Удалить</button>}</div>}</article>):<p className="muted">Записей в выбранной категории пока нет.</p>}
      <p className="team-source">Предложения агента начинают действовать только после утверждения. Пользовательские инструкции действуют сразу. Наблюдения агента хранятся отдельно от обязательных инструкций.</p>
     </section>
    </>:<p className="muted">Выберите участника команды.</p>}
   </div>
  </div>
  <KnowledgeInstructions key={projectId} projectId={projectId} request={request}/>
 </div>;
}
