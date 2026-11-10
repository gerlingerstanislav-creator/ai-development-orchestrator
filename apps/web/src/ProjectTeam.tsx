import {useEffect,useMemo,useState} from 'react';
import {BookOpen,Brain,ChevronRight,RefreshCcw,ShieldCheck,Users} from 'lucide-react';
import './ProjectTeam.css';

type Agent={id:string;role:string;name:string;stage:string;type:string;instructions:string};
type Memory={id:string;role:string;kind:string;body:string;evidence:string;status:string;created_at:string;reviewed_at:string|null};
type Snapshot={agents:Agent[];memory:Memory[]};
type Request=<T>(path:string,options?:RequestInit)=>Promise<T>;
const roleLabels:Record<string,string>={manager:'ПМ',analyst:'БА',analysis:'Аналитик',development:'Разработчик',testing:'QA',deployment:'DevOps',documentation:'Документатор',merge_queue:'Интегратор',backlog:'Оператор',done:'Система'};
const memoryRoles=(role:string)=>role==='manager'?['manager']:role==='analyst'||role==='analysis'?['analyst','manager']:[role];
function kindName(kind:string){return kind==='observation'?'Наблюдение':kind==='instruction_suggestion'?'Предложение инструкции':kind;}
function statusName(status:string){return status==='approved'?'Утверждено':status==='rejected'?'Отклонено':status==='recorded'?'Зафиксировано':status==='pending'?'Ожидает решения':status;}
export function ProjectTeam({projectId,request}:{projectId:string;request:Request}){
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null);
 const [selectedId,setSelectedId]=useState('conversation:manager');
 const [filter,setFilter]=useState<'all'|'active'|'pending'>('all');
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState('');
 const refresh=async()=>{setLoading(true);setError('');try{setSnapshot(await request<Snapshot>('/projects/'+projectId+'/team'));}catch(e){setError(e instanceof Error?e.message:'Не удалось получить данные команды');}finally{setLoading(false);}};
 useEffect(()=>{setSnapshot(null);setSelectedId('conversation:manager');void refresh();},[projectId]);
 const agents=snapshot?.agents||[];
 const selected=agents.find(a=>a.id===selectedId)||agents[0];
 const memories=useMemo(()=>snapshot?.memory.filter(m=>selected&&memoryRoles(selected.role).includes(m.role))||[],[snapshot,selected]);
 const active=memories.filter(m=>m.kind==='observation'||(m.kind==='instruction_suggestion'&&m.status==='approved'));
 const pending=memories.filter(m=>m.kind==='instruction_suggestion'&&m.status!=='approved'&&m.status!=='rejected');
 const visible=filter==='active'?active:filter==='pending'?pending:memories;
 return <div className="team-page">
  <div className="team-heading"><div><h2><Users size={20}/> Команда</h2><p className="muted">Роли проекта, действующие инструкции и накопленный опыт агентов. Все данные читаются из используемых системой настроек и памяти.</p></div><button className="secondary" type="button" onClick={()=>void refresh()} disabled={loading}><RefreshCcw size={15}/>{loading?'Обновление…':'Обновить'}</button></div>
  {error&&<p className="error" role="alert">{error}</p>}
  <div className="team-layout">
   <nav className="team-agents" aria-label="Агенты проекта">
    <div className="team-list-heading">Роли <span>{agents.length}</span></div>
    {agents.map(agent=><button type="button" key={agent.id} className={'team-agent '+(selected?.id===agent.id?'selected':'')} aria-current={selected?.id===agent.id?'page':undefined} onClick={()=>{setSelectedId(agent.id);setFilter('all');}}>
     <span className="team-agent-avatar">{(roleLabels[agent.role]||agent.name).slice(0,2).toUpperCase()}</span>
     <span className="team-agent-label"><strong>{agent.name}</strong><small>{agent.stage}</small></span><ChevronRight size={15}/>
    </button>)}
    {!agents.length&&<p className="muted">Роли не найдены.</p>}
   </nav>
   <div className="team-detail">
    {selected?<><header className="team-detail-heading"><div><span className="team-kicker">{selected.type==='conversation'?'Диалоговый агент':selected.type==='specialist'?'Специалист':'Роль workflow'}</span><h3>{selected.name}</h3><p className="muted">{selected.stage}</p></div></header>
     <section className="team-instruction-block"><h4><ShieldCheck size={16}/> Системные инструкции</h4><p className="muted">Базовые ограничения и внутренние системные промпты исполняющего провайдера не хранятся в настройках проекта и не раскрываются этим API. Ниже показаны только доступные проектные настройки.</p></section>
     <section className="team-instruction-block"><h4><BookOpen size={16}/> Инструкции проекта</h4>{selected.instructions?<pre className="team-instruction-text">{selected.instructions}</pre>:<p className="muted">Для этой роли отдельные инструкции в настройках workflow не заданы. Диалоговые агенты также используют инструкции, определённые кодом сервиса.</p>}<small className="team-source">Источник: {selected.type==='workflow'?'workflow_stages':selected.type==='specialist'?'project_specialist_agents':'программная конфигурация агента'} · изменения выполняются в настройках соответствующей роли.</small></section>
     <section className="team-instruction-block"><div className="team-memory-title"><h4><Brain size={16}/> Накопленная память <span className="team-count">{memories.length}</span></h4><div className="team-filters"><button type="button" className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>Все</button><button type="button" className={filter==='active'?'active':''} onClick={()=>setFilter('active')}>Применяются ({active.length})</button><button type="button" className={filter==='pending'?'active':''} onClick={()=>setFilter('pending')}>На рассмотрении ({pending.length})</button></div></div>
     {selected.role!=='manager'&&selected.role!=='analyst'&&selected.role!=='analysis'&&<p className="muted">Автоматическое накопление памяти для этой роли пока не подключено. Показаны только существующие записи; отсутствие записей не означает, что агент не использует инструкции проекта.</p>}
     {visible.length?visible.map(m=><article className="team-memory-item" key={m.id}><div className="team-memory-meta"><strong>{kindName(m.kind)}</strong><span>{statusName(m.status)}</span><time dateTime={m.created_at}>{new Date(m.created_at).toLocaleString('ru-RU')}</time></div><p>{m.body}</p>{m.evidence&&<small className="team-source">Основание: {m.evidence}</small>}</article>):<p className="muted">Записей в выбранной категории пока нет.</p>}
     <p className="team-source">Наблюдения и утверждённые предложения включаются в контекст ПМ и БА. Неутверждённые предложения не являются обязательными инструкциями.</p></section>
    </>:<p className="muted">Выберите участника команды.</p>}
   </div>
  </div>
 </div>;
}
