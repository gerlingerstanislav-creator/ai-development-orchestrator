import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ArrowLeft,ArrowRight,BookOpen,ChevronDown,Columns3,FileText,KeyRound,LayoutGrid,List,Plus,Settings2,Trash2,MessageCircle,Send,X} from 'lucide-react';
import './style.css';

type Project={id:string,name:string,description:string};
type Task={id:string,title:string,description:string,type:string,stage:string,parent_id:string|null,created_at:string,analysis_state?:string,clarification_questions?:string[],related_task_ids?:string[],git_branch?:string|null,pr_url?:string|null};
type Stage={stage:string,label:string,mode:'automatic'|'approval'|'manual',position:number};
type Doc={id:string,title:string,body:string,parent_id:string|null,updated_at:string};
type Connection={id:string,name:string,provider:string};
type GitLink={repository:string,default_branch:string,target_branch?:string,connection_id:string,connection_name?:string};
type AiSettings={model:'gpt-6-luna'|'gpt-6-sol'|'gpt-6.1-sol';reasoning:'low'|'medium';max_runtime_seconds:number;daily_run_limit:number;enabled:boolean};
type AiRun={id:string;task_id:string;model:string;status:string;branch?:string|null;pr_url?:string|null;message?:string;created_at?:string};
type AssistantMessage={id:string;role:'user'|'assistant';body:string;created_task_id?:string|null;created_at?:string};
type AssistantResponse={message:string;created_task_id?:string|null;summary?:string|null};
type CodexState={connected:boolean;detail?:string;error?:string;login?:{state:string;url?:string|null;code?:string|null;instructions?:string;diagnosis?:string;startedAt?:number|null}|null};
const key='ado-token';
const defaultStages=['backlog','analysis','development','merge_queue','done'];
async function api<T=any>(path:string,options:RequestInit={}):Promise<T>{
 const token=sessionStorage.getItem(key);
 const res=await fetch('/api'+path,{...options,headers:{...(options.body!=null?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...options.headers}});
 const data=await res.json().catch(()=>({}));
 if(!res.ok)throw Error(data.error||'Ошибка запроса');
 return data as T;
}
function App(){
 const [token,setToken]=useState(sessionStorage.getItem(key)||'');
 const [login,setLogin]=useState(''); const [password,setPassword]=useState('');
 const [projects,setProjects]=useState<Project[]>([]);const [selected,setSelected]=useState<Project|null>(null);
 const [section,setSection]=useState<'overview'|'tasks'|'docs'|'settings'>('tasks');
 const [accountSettings,setAccountSettings]=useState(false);
 const [tasks,setTasks]=useState<Task[]>([]);const [stages,setStages]=useState<Stage[]>([]);
 const [docs,setDocs]=useState<Doc[]>([]);const [collapsedDocs,setCollapsedDocs]=useState<string[]>([]);const [connections,setConnections]=useState<Connection[]>([]);
 const [projectConnections,setProjectConnections]=useState<Connection[]>([]);
 const [aiSettings,setAiSettings]=useState<AiSettings>({model:'gpt-6-luna',reasoning:'low',max_runtime_seconds:300,daily_run_limit:3,enabled:false});
 const [aiBusy,setAiBusy]=useState(false);const [aiRuns,setAiRuns]=useState<AiRun[]>([]);const [aiMessage,setAiMessage]=useState('');
 const [targetBranch,setTargetBranch]=useState('');const [mergeBusy,setMergeBusy]=useState(false);const [mergeReport,setMergeReport]=useState('');
 const [gitLink,setGitLink]=useState<GitLink|null>(null);const [gitRepository,setGitRepository]=useState('');const [gitTokenId,setGitTokenId]=useState('');const [gitBusy,setGitBusy]=useState(false);const [gitMessage,setGitMessage]=useState('');
 const [view,setView]=useState<'board'|'list'>('board');
 const [activeTask,setActiveTask]=useState<Task|null>(null);const [activeDoc,setActiveDoc]=useState<Doc|null>(null);
 const [showProject,setShowProject]=useState(false);const [showTask,setShowTask]=useState(false);const [showConnection,setShowConnection]=useState(false);
 const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [search,setSearch]=useState('');
 const [form,setForm]=useState({name:'',description:'',title:'',type:'task',parent_id:''});
 const [cred,setCred]=useState({name:'',provider:'openai_api',secret:''});
 const [codex,setCodex]=useState<CodexState|null>(null);const [codexBusy,setCodexBusy]=useState(false);const [codexTest,setCodexTest]=useState('');
 const [events,setEvents]=useState<{id:string,event:string,detail:string,created_at:string}[]>([]);
 const projectThreadRef=useRef<HTMLDivElement|null>(null);const taskThreadRef=useRef<HTMLDivElement|null>(null);
 const [projectChatOpen,setProjectChatOpen]=useState(false);
 const [projectMessages,setProjectMessages]=useState<AssistantMessage[]>([]);
 const [projectInput,setProjectInput]=useState('');const [projectChatBusy,setProjectChatBusy]=useState(false);
 const [taskMessages,setTaskMessages]=useState<AssistantMessage[]>([]);
 const [taskInput,setTaskInput]=useState('');const [taskChatBusy,setTaskChatBusy]=useState(false);
 const [drag,setDrag]=useState<string|null>(null);
 function fail(e:unknown){setError(e instanceof Error?e.message:'Неизвестная ошибка');}
 async function loadProjects(){try{setProjects(await api('/projects'));}catch(e){fail(e);}}
 async function loadProject(id:string){
  try{
   const [t,s,d,c,pc,gl,ai,runs]=await Promise.all([api<Task[]>('/projects/'+id+'/tasks'),api<Stage[]>('/projects/'+id+'/workflow'),api<Doc[]>('/projects/'+id+'/docs'),api<Connection[]>('/connections'),api<Connection[]>('/projects/'+id+'/connections'),api<GitLink|null>('/projects/'+id+'/git'),api<AiSettings>('/projects/'+id+'/ai-settings'),api<AiRun[]>('/projects/'+id+'/ai-runs')]);
   setTasks(t);setStages(s);setDocs(d);setConnections(c);setProjectConnections(pc);setGitLink(gl);setGitRepository(gl?.repository||'');setTargetBranch(gl?.target_branch||gl?.default_branch||'');setGitTokenId(gl?.connection_id||'');setGitMessage('');setAiSettings(ai);setAiRuns(runs);setAiMessage('');
  }catch(e){fail(e);}
 }
 useEffect(()=>{if(token)void loadProjects();},[token]);
 useEffect(()=>{if(selected)void loadProject(selected.id);},[selected?.id]);
 useEffect(()=>{if(projectThreadRef.current)projectThreadRef.current.scrollTop=projectThreadRef.current.scrollHeight;},[projectMessages,projectChatOpen,projectChatBusy]);
 useEffect(()=>{if(taskThreadRef.current)taskThreadRef.current.scrollTop=taskThreadRef.current.scrollHeight;},[taskMessages,taskChatBusy]);
 useEffect(()=>{setProjectChatOpen(false);setProjectMessages([]);setProjectInput('');if(selected&&!accountSettings){void api<AssistantMessage[]>('/projects/'+selected.id+'/assistant/messages').then(setProjectMessages).catch(fail);}},[selected?.id]);
 useEffect(()=>{setTaskMessages([]);setTaskInput('');if(selected&&activeTask){void api<AssistantMessage[]>('/projects/'+selected.id+'/tasks/'+activeTask.id+'/assistant/messages').then(setTaskMessages).catch(fail);}},[selected?.id,activeTask?.id]);
 async function signIn(e:React.FormEvent){e.preventDefault();setError('');try{const d=await api<{token:string}>('/login',{method:'POST',body:JSON.stringify({email:login,password})});sessionStorage.setItem(key,d.token);setToken(d.token);}catch(e){fail(e);}}
 async function createProject(e:React.FormEvent){e.preventDefault();setBusy(true);try{const p=await api<Project>('/projects',{method:'POST',body:JSON.stringify({name:form.name,description:form.description})});await loadProjects();setSelected(p);setShowProject(false);setForm({...form,name:'',description:''});}catch(e){fail(e);}finally{setBusy(false);}}
 async function createTask(e:React.FormEvent){e.preventDefault();if(!selected)return;setBusy(true);try{await api('/projects/'+selected.id+'/tasks',{method:'POST',body:JSON.stringify({title:form.title,description:form.description,type:form.type,parent_id:form.parent_id||null})});await loadProject(selected.id);setShowTask(false);setForm({...form,title:'',description:'',parent_id:''});}catch(e){fail(e);}finally{setBusy(false);}}
 async function saveTask(values:{title:string,description:string,stage:string}){if(!selected||!activeTask)return;try{await api('/projects/'+selected.id+'/tasks/'+activeTask.id,{method:'PATCH',body:JSON.stringify(values)});setActiveTask(null);await loadProject(selected.id);}catch(e){fail(e);}}
 async function moveTask(task:Task,stage:string){if(!selected||stage===task.stage)return;try{await api('/projects/'+selected.id+'/tasks/'+task.id,{method:'PATCH',body:JSON.stringify({stage})});await loadProject(selected.id);}catch(e){fail(e);}}
 async function modeChange(stage:string,mode:string){if(!selected)return;try{await api('/projects/'+selected.id+'/workflow/'+stage,{method:'PATCH',body:JSON.stringify({mode})});await loadProject(selected.id);}catch(e){fail(e);}}
 async function addDoc(parentId:string|null=null){if(!selected)return;try{const added=await api<{id:string}>('/projects/'+selected.id+'/docs',{method:'POST',body:JSON.stringify({title:'Новая страница',body:'',parent_id:parentId})});if(parentId)setCollapsedDocs(items=>items.filter(x=>x!==parentId));await loadProject(selected.id);setActiveDoc({id:added.id,title:'Новая страница',body:'',parent_id:parentId,updated_at:new Date().toISOString()});}catch(e){fail(e);}}
 async function saveDoc(doc:Doc){if(!selected)return;try{await api('/projects/'+selected.id+'/docs/'+doc.id,{method:'PATCH',body:JSON.stringify({title:doc.title,body:doc.body,parent_id:doc.parent_id})});await loadProject(selected.id);setActiveDoc(null);}catch(e){fail(e);}}
 async function addConnection(e:React.FormEvent){e.preventDefault();setBusy(true);try{await api('/connections',{method:'POST',body:JSON.stringify(cred)});setCred({name:'',provider:'openai_api',secret:''});setShowConnection(false);if(selected)await loadProject(selected.id);}catch(e){fail(e);}finally{setBusy(false);}}
 async function attachConnection(connectionId:string){if(!selected)return;try{await api('/projects/'+selected.id+'/connections',{method:'POST',body:JSON.stringify({connectionId})});await loadProject(selected.id);}catch(e){fail(e);}}
 async function saveGitLink(){if(!selected)return;setGitBusy(true);setGitMessage('');try{const r=await api<GitLink>('/projects/'+selected.id+'/git',{method:'PUT',body:JSON.stringify({repository:gitRepository.trim(),connectionId:gitTokenId,targetBranch:targetBranch.trim()||undefined})});setGitLink(r);setTargetBranch(r.target_branch||r.default_branch);setGitMessage('Доступ проверен. Репозиторий привязан.');}catch(e){fail(e);}finally{setGitBusy(false);}}
 async function removeGitLink(){if(!selected)return;setGitBusy(true);try{await api('/projects/'+selected.id+'/git',{method:'DELETE'});setGitLink(null);setGitMessage('Привязка удалена.');}catch(e){fail(e);}finally{setGitBusy(false);}}
 async function saveAiSettings(){if(!selected)return;setAiBusy(true);try{const saved=await api<AiSettings>('/projects/'+selected.id+'/ai-settings',{method:'PUT',body:JSON.stringify(aiSettings)});setAiSettings(saved);setAiMessage('Настройки сохранены');}catch(e){fail(e);}finally{setAiBusy(false);}}
 async function runAiTask(){if(!selected||!activeTask)return;setAiBusy(true);setAiMessage('');try{
   const job=await api<AiRun>('/projects/'+selected.id+'/tasks/'+activeTask.id+'/run-ai',{method:'POST'});
   setAiRuns(old=>[job,...old]);setAiMessage('Codex запущен. Результат появится в истории ниже.');
  }catch(e){fail(e);}finally{setAiBusy(false);}}
 useEffect(()=>{if(!token||!selected||!aiRuns.some(r=>r.status==='running'||r.status==='queued'))return;
  const timer=setInterval(async()=>{const active=aiRuns.filter(r=>r.status==='running'||r.status==='queued');
   const updated=await Promise.all(active.map(async r=>{try{return await api<AiRun>('/projects/'+selected.id+'/ai-runs/'+r.id);}catch{return r;}}));
   setAiRuns(old=>old.map(r=>updated.find(x=>x.id===r.id)||r));
   if(updated.some(r=>r.status==='completed')){try{const currentTasks=await api<Task[]>('/projects/'+selected.id+'/tasks');setTasks(currentTasks);setActiveTask(old=>old?currentTasks.find(t=>t.id===old.id)||old:old);}catch(e){fail(e);}}
  },4000);
  return()=>clearInterval(timer);
 },[token,selected?.id,aiRuns]);
 async function sendProjectMessage(e:React.FormEvent){e.preventDefault();if(!selected||!projectInput.trim()||projectChatBusy)return;
  const message=projectInput.trim();setProjectChatBusy(true);
  try{const response=await api<AssistantResponse>('/projects/'+selected.id+'/assistant',{method:'POST',body:JSON.stringify({message})});
   setProjectMessages(old=>[...old,{id:'u-'+Date.now(),role:'user' as const,body:message},{id:'a-'+Date.now(),role:'assistant' as const,body:response.message,created_task_id:response.created_task_id}]);
   setProjectInput('');if(response.created_task_id)await loadProject(selected.id);
  }catch(e){fail(e);}finally{setProjectChatBusy(false);}
 }
 async function sendTaskMessage(e:React.FormEvent){e.preventDefault();if(!selected||!activeTask||!taskInput.trim()||taskChatBusy)return;
  const message=taskInput.trim();setTaskChatBusy(true);
  try{const response=await api<AssistantResponse>('/projects/'+selected.id+'/tasks/'+activeTask.id+'/assistant',{method:'POST',body:JSON.stringify({message,mode:'chat'})});
   setTaskMessages(old=>[...old,{id:'u-'+Date.now(),role:'user' as const,body:message},{id:'a-'+Date.now(),role:'assistant' as const,body:response.message}]);
   setTaskInput('');if(activeTask.stage==='analysis'){const updated=await api<Task[]>('/projects/'+selected.id+'/tasks');setTasks(updated);const task=updated.find(t=>t.id===activeTask.id);if(task)setActiveTask(task);}
  }catch(e){fail(e);}finally{setTaskChatBusy(false);}
 }
 async function executeTask(){if(!selected||!activeTask||taskChatBusy||aiBusy)return;
  const taskId=activeTask.id;
  try{await api('/projects/'+selected.id+'/tasks/'+taskId,{method:'PATCH',body:JSON.stringify({title:activeTask.title,description:activeTask.description,stage:activeTask.stage})});}
  catch(e){fail(e);return;}
  if(activeTask.stage==='analysis'){
   setTaskChatBusy(true);try{const instruction='Выполни анализ задачи и составь техническое задание с критериями приёмки.';
    const response=await api<AssistantResponse>('/projects/'+selected.id+'/tasks/'+taskId+'/assistant',{method:'POST',body:JSON.stringify({message:instruction,mode:'analyze'})});
    setTaskMessages(old=>[...old,{id:'u-'+Date.now(),role:'user' as const,body:instruction},{id:'a-'+Date.now(),role:'assistant' as const,body:response.message}]);
    if(response.summary){setActiveTask(old=>old?.id===taskId?{...old,description:response.summary||old.description}:old);setTasks(old=>old.map(t=>t.id===taskId?{...t,description:response.summary||t.description}:t));}
   }catch(e){fail(e);}finally{setTaskChatBusy(false);}
  }else if(activeTask.stage==='development'){await runAiTask();}
 }

 async function approveDevelopment(){if(!selected||!activeTask)return;setTaskChatBusy(true);
  try{
   await api('/projects/'+selected.id+'/tasks/'+activeTask.id,{method:'PATCH',body:JSON.stringify({title:activeTask.title,description:activeTask.description})});
   await api('/projects/'+selected.id+'/tasks/'+activeTask.id+'/approve-development',{method:'POST'});
   const updated={...activeTask,stage:'development',analysis_state:'approved'};
   setActiveTask(updated);setTasks(old=>old.map(t=>t.id===updated.id?updated:t));
   try{
    const run=await api<AiRun>('/projects/'+selected.id+'/tasks/'+activeTask.id+'/run-ai',{method:'POST'});
    setAiRuns(old=>[run,...old]);
    setAiMessage('Разработка запущена автоматически после подтверждения анализа.');
   }catch(e){fail(e);}
  }catch(e){fail(e);}finally{setTaskChatBusy(false);}
 }
 async function mergeTask(task:Task){if(!selected||!window.confirm('Слить PR задачи «'+task.title+'» в '+(gitLink?.target_branch||'целевую ветку')+'?'))return;
  setMergeBusy(true);try{
   await api('/projects/'+selected.id+'/tasks/'+task.id+'/merge',{method:'POST'});
   setTasks(old=>old.map(t=>t.id===task.id?{...t,stage:'done'}:t));
   setActiveTask(old=>old?.id===task.id?{...old,stage:'done'}:old);
   setMergeReport('Изменения задачи слиты.');
  }catch(e){fail(e);}finally{setMergeBusy(false);}
 }
 async function mergeReady(){if(!selected||!window.confirm('Последовательно слить все готовые PR в '+(gitLink?.target_branch||'целевую ветку')+'?'))return;
  setMergeBusy(true);try{
   const result=await api<{results:Array<{taskId:string,status:string,reason?:string}>}>('/projects/'+selected.id+'/merge-ready',{method:'POST'});
   setTasks(old=>old.map(t=>result.results.some(r=>r.taskId===t.id&&r.status==='merged')?{...t,stage:'done'}:t));
   setMergeReport('Слито: '+result.results.filter(r=>r.status==='merged').length+'. Пропущено: '+result.results.filter(r=>r.status==='skipped').length+
    (result.results.filter(r=>r.reason).length?'\n'+result.results.filter(r=>r.reason).map(r=>r.reason).join('\n'):''));
  }catch(e){fail(e);}finally{setMergeBusy(false);}
 }
 async function openTask(t:Task){setActiveTask({...t});setEvents([]);if(selected){try{setEvents(await api('/projects/'+selected.id+'/tasks/'+t.id+'/events'));}catch(e){fail(e);}}}
 async function refreshCodex(){try{setCodex(await api<CodexState>('/codex/status'));}catch(e){setCodex({connected:false,error:e instanceof Error?e.message:'Не удалось проверить Codex'});}}
 async function codexAction(action:'login'|'logout'|'test'){setCodexBusy(true);setCodexTest('');try{const res=await api<any>('/codex/'+action,{method:'POST'});if(action==='test')setCodexTest(res.message||'Подключение работает');await refreshCodex();if(action==='login'&&res.login)setCodex(old=>({...old,connected:false,login:res.login}));}catch(e){fail(e);}finally{setCodexBusy(false);}}
 useEffect(()=>{if(token&&accountSettings){void refreshCodex();}},[token,accountSettings]);
 useEffect(()=>{if(!token||!accountSettings||!codex?.login||codex.login.state!=='waiting')return;const interval=setInterval(()=>void refreshCodex(),3500);return ()=>clearInterval(interval);},[token,accountSettings,codex?.login?.state]);
 function logout(){sessionStorage.removeItem(key);setToken('');setSelected(null);setAccountSettings(false);setProjects([]);setCodex(null);}
 function renderDocTree(parentId:string|null,depth=0):React.ReactNode {
  return docs.filter(d=>d.parent_id===parentId).map(d=>{
   const hasChildren=docs.some(c=>c.parent_id===d.id),collapsed=collapsedDocs.includes(d.id);
   return <div key={d.id}>
    <div className="doc-node" style={{paddingLeft:8+Math.min(depth,8)*18}}>
     <button className="doc-toggle" type="button" aria-label={collapsed?'Развернуть':'Свернуть'} onClick={()=>setCollapsedDocs(items=>collapsed?items.filter(x=>x!==d.id):[...items,d.id])}>{hasChildren?(collapsed?'▸':'▾'):'·'}</button>
     <button className="doc-title" type="button" onClick={()=>setActiveDoc({...d})}><FileText size={16}/><span>{d.title}</span></button>
     <button className="doc-add-child" type="button" title="Добавить вложенную страницу" aria-label={'Добавить страницу в '+d.title} onClick={()=>void addDoc(d.id)}><Plus size={15}/></button>
    </div>
    {!collapsed&&hasChildren&&renderDocTree(d.id,depth+1)}
   </div>;
  });
 }
 const filtered=tasks.filter(t=>t.title.toLowerCase().includes(search.toLowerCase()));
 if(!token)return <div className="login-shell"><form className="login-card" onSubmit={signIn}><span className="logo-icon">◈</span><h1>AI Development<br/>Orchestrator</h1><p>Войдите, чтобы управлять проектами</p><label>Электронная почта<input type="text" inputMode="email" autoComplete="username" required value={login} onChange={e=>setLogin(e.target.value)} placeholder="admin@example.com"/></label><label>Пароль<input type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)}/></label><button className="primary">Войти</button>{error&&<div className="error">{error}</div>}</form></div>;
 return <div className="shell">
 <aside className="sidebar"><div className="brand"><span className="logo-icon">◈</span><span>Orchestrator<small>WORKSPACE</small></span></div>
  <div className="sidebar-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
  <button className={'nav '+(!selected&&!accountSettings?'active':'')} onClick={()=>{setAccountSettings(false);setSelected(null);}}><LayoutGrid size={18}/> Мои проекты</button>
  {selected&&<><div className="sidebar-label">{selected.name.toUpperCase()}</div>
   {([['overview','Обзор',LayoutGrid],['tasks','Задачи',Columns3],['docs','Документация',BookOpen],['settings','Настройки',Settings2]] as const).map(([k,label,Icon])=><button key={k} className={'nav '+(section===k?'active':'')} onClick={()=>{setAccountSettings(false);setSection(k);}}><Icon size={18}/>{label}</button>)}
  </>}
  <div className="sidebar-label">АККАУНТ</div>
  <button className={'nav '+(accountSettings?'active':'')} onClick={()=>setAccountSettings(true)}><Settings2 size={18}/> Настройки аккаунта</button>
  <div className="sidebar-bottom"><span className="avatar">AD</span><span>Администратор</span><button onClick={logout} title="Выйти">Выйти</button></div>
 </aside>
 <main className="main"><header className="topbar"><span className="crumb" onClick={()=>{setSelected(null);setAccountSettings(false);}}>Мои проекты</span>{accountSettings?<><span className="slash">/</span><strong>Настройки аккаунта</strong></>:selected&&<><span className="slash">/</span><strong>{selected.name}</strong><span className="slash">/</span><strong>{section==='overview'?'Обзор':section==='tasks'?'Задачи':section==='docs'?'Документация':'Настройки'}</strong></>}<span className="top-right">● {selected?(aiSettings.enabled?"AI: ручной запуск":"AI выключен"):"Ручной режим"}</span></header>
 {error&&<div className="error global" onClick={()=>setError('')}>{error} <X size={16}/></div>}
 {accountSettings?<div className="page compact-project-page">
 <section className="panel codex-panel">
 <div className="codex-heading"><div><h3>Codex CLI · ChatGPT Plus</h3><p className="muted">Отдельный Docker-контейнер. Вход через браузер, без API-ключа и пароля ChatGPT в нашем сервисе.</p></div><span className={'codex-state '+(codex?.connected?'online':'offline')}>{codex?.connected?'Подключён':codex?.error?'Недоступен':'Не подключён'}</span></div>
 {codex?.error&&<p className="error">{codex.error}</p>}
 {codex?.connected?<p className="muted">{codex.detail||'Авторизация ChatGPT активна.'}</p>:<p className="muted">Для входа может потребоваться включить вход по коду устройства в настройках безопасности ChatGPT.</p>}
 {codex?.login&&!codex.connected&&<div className="codex-device">
  <b>{codex.login.state==='waiting'?'Подключение ChatGPT':codex.login.state==='error'?'Ошибка запуска авторизации':codex.login.state==='expired'?'Время авторизации истекло':'Авторизация Codex'}</b>
  <p>{codex.login.state==='waiting'?'Открой ссылку, войди в ChatGPT Plus и введи одноразовый код.':'Проверь сообщение ниже. При необходимости нажми «Подключить ChatGPT Plus» ещё раз.'}</p>
  {codex.login.url&&<a href={codex.login.url} target="_blank" rel="noreferrer">{codex.login.url}</a>}
  {codex.login.code&&<strong className="codex-code">{codex.login.code}</strong>}
  <pre>{codex.login.instructions||'Ожидание ответа Codex CLI…'}</pre>
  {codex.login.diagnosis&&<p className="codex-diagnosis"><strong>Проверка соединения:</strong> {codex.login.diagnosis}</p>}
 </div>}
 <div className="codex-actions">
  {!codex?.connected&&<button className="primary" disabled={codexBusy} onClick={()=>void codexAction('login')}>Подключить ChatGPT Plus</button>}
  <button className="secondary" disabled={codexBusy} onClick={()=>void refreshCodex()}>Проверить состояние</button>
  {codex?.connected&&<><button className="secondary" disabled={codexBusy} onClick={()=>void codexAction('test')}>Проверить запросом</button><button className="secondary" disabled={codexBusy} onClick={()=>void codexAction('logout')}>Отключить</button></>}
 </div>
 {codexTest&&<div className="codex-test">{codexTest}</div>}
 </section>
 </div>:!selected?<div className="page"><div className="page-heading"><div><span className="eyebrow">WORKSPACE</span><h1>Мои проекты</h1><p>Создавайте проекты и управляйте разработкой в одном месте.</p></div><button className="primary" onClick={()=>{setForm({...form,name:'',description:''});setShowProject(true);}}><Plus size={17}/> Новый проект</button></div>
 <div className="project-grid">{projects.map(p=><button key={p.id} className="project-card" onClick={()=>{setSelected(p);setSection('tasks');}}><div className="project-symbol">{p.name.slice(0,1).toUpperCase()}</div><h3>{p.name}</h3><p>{p.description||'Описание проекта пока не добавлено'}</p><span>Открыть проект <ArrowRight size={16}/></span></button>)}{projects.length===0&&<div className="empty">Пока нет проектов. Создайте первый, чтобы начать работу.</div>}</div></div>
 :<div className={section==='tasks'?'page tasks-page':'page compact-project-page'}>
  {section==='docs'&&<div className="toolbar"><button className="primary" onClick={()=>void addDoc()}><Plus size={17}/> Новая страница</button></div>}
 {section==='overview'&&<div className="overview"><div className="panel"><h3>О проекте</h3><p>{selected.description||'Описание пока отсутствует.'}</p></div><div className="stats">{stages.map(s=><div className="stat" key={s.stage}><b>{tasks.filter(t=>t.stage===s.stage).length}</b><span>{s.label}</span></div>)}</div></div>}
 {section==='tasks'&&<><div className="toolbar"><input className="search" aria-label="Поиск по задачам" placeholder="Поиск по задачам…" value={search} onChange={e=>setSearch(e.target.value)}/><div className="segmented"><button className={view==='board'?'chosen':''} onClick={()=>setView('board')}><Columns3 size={16}/> Канбан</button><button className={view==='list'?'chosen':''} onClick={()=>setView('list')}><List size={16}/> Список</button></div><button className="primary create-task" onClick={()=>{setForm({...form,title:'',description:'',type:'task',parent_id:''});setShowTask(true);}}><Plus size={17}/> Создать задачу</button></div>
 {mergeReport&&<div className="panel merge-report">{mergeReport}</div>}{view==='board'?<div className="board">{stages.map(s=><div className="lane" key={s.stage} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(drag){const task=tasks.find(t=>t.id===drag);if(task)void moveTask(task,s.stage);}setDrag(null);}}><div className="lane-heading"><span className={'stage-dot '+s.stage}></span><b>{s.label}</b><span className="count">{filtered.filter(t=>t.stage===s.stage).length}</span>
   {s.stage==='merge_queue'&&<button className="secondary" disabled={mergeBusy||!tasks.some(t=>t.stage==='merge_queue')} onClick={e=>{e.stopPropagation();void mergeReady();}} title="Последовательно слить проверенные PR">Слить готовые</button>}</div><div className="cards">{filtered.filter(t=>t.stage===s.stage).map(t=><button className="task-card" draggable onDragStart={e=>{setDrag(t.id);e.dataTransfer.effectAllowed='move';}} onDragEnd={()=>setDrag(null)} onClick={()=>void openTask(t)} key={t.id}><span className="task-type">{t.type==='bug'?'Ошибка':t.type==='epic'?'Эпик':t.type==='improvement'?'Улучшение':'Задача'}</span><strong>{t.title}</strong><p>{t.description||'Без описания'}</p>{t.analysis_state==='needs_clarification'&&<small className="task-warning">Требуются ответы</small>}{t.stage==='merge_queue'&&<small className="task-warning">PR ожидает слияния</small>}<span className="task-footer">#{t.id.slice(0,6)} <span>↗</span></span></button>)}{filtered.filter(t=>t.stage===s.stage).length===0&&<div className="lane-empty">Перетащите задачу сюда</div>}</div></div>)}</div>:<div className="panel table-wrap"><table><thead><tr><th>Задача</th><th>Тип</th><th>Этап</th><th>Создана</th></tr></thead><tbody>{filtered.map(t=><tr key={t.id} onClick={()=>void openTask(t)}><td><b>{t.title}</b><small>#{t.id.slice(0,6)}</small></td><td>{t.type}</td><td>{stages.find(s=>s.stage===t.stage)?.label}</td><td>{new Date(t.created_at).toLocaleDateString('ru-RU')}</td></tr>)}</tbody></table></div>}</>}
 {section==='docs'&&<div className="docs"><div className="panel docs-list"><div className="docs-list-heading"><b>Страницы проекта</b><button type="button" title="Добавить корневую страницу" onClick={()=>void addDoc()}><Plus size={18}/></button></div><div className="doc-tree">{renderDocTree(null)}</div>{!docs.length&&<p>Создайте первую страницу документации.</p>}</div><div className="panel docs-preview"><BookOpen size={25}/><h3>Документация проекта</h3><p>Страницы можно вкладывать друг в друга. Нажми на страницу для редактирования, плюс справа — для создания дочерней страницы. Родителя можно поменять в редакторе.</p></div></div>}
 {section==='settings'&&<section className="panel">
  <h3>AI · Настройки выполнения</h3>
  <p className="muted">Модель задаётся для проекта. Агент запускается только вручную из карточки задачи. Одновременно выполняется не более одной задачи.</p>
  <div className="settings-grid">
   <label>Модель по умолчанию<select value={aiSettings.model} onChange={e=>setAiSettings({...aiSettings,model:e.target.value as AiSettings['model']})}>
    <option value="gpt-6-luna">GPT-6 Luna — экономный вариант</option>
    <option value="gpt-6-sol">GPT-6 Sol — сложнее задачи</option>
    <option value="gpt-6.1-sol">GPT-6.1 Sol — более мощная</option>
   </select></label>
   <label>Глубина рассуждений<select value={aiSettings.reasoning} onChange={e=>setAiSettings({...aiSettings,reasoning:e.target.value as AiSettings['reasoning']})}>
    <option value="low">Низкая — экономит лимиты</option><option value="medium">Средняя</option>
   </select></label>
   <label>Максимальная длительность задания (сек.)<select value={aiSettings.max_runtime_seconds} onChange={e=>setAiSettings({...aiSettings,max_runtime_seconds:Number(e.target.value)})}>
    <option value={90}>90 секунд</option><option value={180}>3 минуты</option>
    <option value={300}>5 минут</option><option value={600}>10 минут</option>
    <option value={900}>15 минут</option>
   </select></label>
   <label>Запусков за 24 часа<select value={aiSettings.daily_run_limit} onChange={e=>setAiSettings({...aiSettings,daily_run_limit:Number(e.target.value)})}>
    {[1,2,3,5,10].map(n=><option key={n} value={n}>{n}</option>)}
   </select></label>
  </div>
  <label style={{display:'flex',flexDirection:'row',alignItems:'center',gap:10}}>
   <input type="checkbox" checked={aiSettings.enabled} onChange={e=>setAiSettings({...aiSettings,enabled:e.target.checked})} style={{width:18,height:18}}/>
   Разрешить ручной запуск AI-задач
  </label>
  <p className="muted">Лимит запусков за 24 часа, время и модель снижают расход, но не являются точным ограничением токенов. Доступность модели зависит от твоей подписки Codex.</p>
  <button className="primary" disabled={aiBusy} onClick={()=>void saveAiSettings()}>Сохранить настройки AI</button>
  {aiMessage&&<p>{aiMessage}</p>}
 </section>}
 {section==='settings'&&<section className="panel">
  <h3>GitHub · Репозиторий проекта</h3>
  <p className="muted">Подключи репозиторий и токен с правами Contents: Read and write и Pull requests: Read and write. Codex создаёт отдельную ветку и черновик PR после ручного запуска задачи.</p>
  <div className="settings-grid">
   <label>Репозиторий (owner/name)<input value={gitRepository} placeholder="gerlingerstanislav-creator/ai-development-orchestrator" onChange={e=>setGitRepository(e.target.value)} /></label>
   <label>Целевая ветка PR<input value={targetBranch} placeholder={gitLink?.default_branch||'main'} onChange={e=>setTargetBranch(e.target.value)} /></label>
   <label>GitHub token<select value={gitTokenId} onChange={e=>setGitTokenId(e.target.value)}><option value="">Выбери подключение</option>{connections.filter(c=>c.provider==='github_token').map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label>
  </div>
  {connections.every(c=>c.provider!=='github_token')&&<p className="muted">Сначала добавь подключение типа GitHub token ниже в разделе «Подключения».</p>}
  {gitLink&&<p className="muted">Привязан: <strong>{gitLink.repository}</strong> · целевая ветка PR: <strong>{gitLink.target_branch||gitLink.default_branch}</strong></p>}
  {gitMessage&&<p>{gitMessage}</p>}
  <div className="codex-actions">
   <button className="primary" disabled={gitBusy||!gitTokenId||!gitRepository.trim()} onClick={()=>void saveGitLink()}>Проверить и сохранить</button>
   {gitLink&&<button className="secondary" disabled={gitBusy} onClick={()=>void removeGitLink()}>Отвязать репозиторий</button>}
  </div>
 </section>}
 
 {section==='settings'&&aiRuns.length>0&&<section className="panel">
  <h3>Последние AI-запуски</h3>
  {aiRuns.slice(0,10).map(r=><div className="setting-row" key={r.id}>
   <div><strong>{tasks.find(t=>t.id===r.task_id)?.title||r.task_id.slice(0,8)}</strong>
   <small>{r.model} · {r.status} · {r.message||''}</small></div>
   {r.pr_url&&<a href={r.pr_url} target="_blank" rel="noreferrer">Pull Request</a>}
  </div>)}
 </section>}
  {section==='settings'&&<div className="settings-grid"><div className="panel"><h3>Этапы workflow</h3><p className="muted">Пока все перемещения выполняются вручную. Режимы определяют будущие правила исполнения.</p>{stages.map(s=><div key={s.stage} className="setting-row"><div><strong>{s.label}</strong><small>{s.stage}</small></div><select value={s.mode} onChange={e=>void modeChange(s.stage,e.target.value)}><option value="manual">Ручной</option><option value="approval">С подтверждением</option><option value="automatic">Автоматический</option></select></div>)}</div>
 <div className="panel"><h3>Подключения</h3><p className="muted">Храним ключи в зашифрованном виде. GitHub token используется исполнителем для отправки ветки и создания Pull Request.</p><button className="secondary" onClick={()=>setShowConnection(true)}><KeyRound size={16}/> Добавить подключение</button>{projectConnections.map(c=><div className="setting-row" key={c.id}><div><strong>{c.name}</strong><small>{c.provider}</small></div><span className="badge">Назначено</span></div>)}{connections.filter(c=>!projectConnections.some(p=>p.id===c.id)).map(c=><div key={c.id} className="setting-row"><div><strong>{c.name}</strong><small>{c.provider}</small></div><button className="textbtn" onClick={()=>void attachConnection(c.id)}>Назначить проекту</button></div>)}</div></div>}
 </div>}
 </main>
 {selected&&!accountSettings&&!activeTask&&!activeDoc&&!showTask&&!showProject&&!showConnection&&<>
  {projectChatOpen&&<section className="project-chat" aria-label="Чат проекта">
   <header className="project-chat-heading"><div><strong>AI-помощник проекта</strong><small>{aiSettings.model}</small></div><button onClick={()=>setProjectChatOpen(false)} title="Свернуть чат"><X size={17}/></button></header>
   <div ref={projectThreadRef} className="assistant-thread" role="log" aria-live="polite">
    {projectMessages.length===0&&<p className="assistant-hint">Напиши, например: «Создай задачу на добавление поиска по документации».</p>}
    {projectMessages.map(m=><div className={'assistant-bubble '+(m.role==='user'?'mine':'bot')} key={m.id}>
      <span className="assistant-author">{m.role==='user'?'Вы':'AI'}</span>
      <div>{m.body}</div>
      {m.created_task_id&&<button className="textbtn" onClick={()=>{const t=tasks.find(t=>t.id===m.created_task_id);if(t)void openTask(t);}}>Открыть созданную задачу</button>}
    </div>)}
    {projectChatBusy&&<p className="assistant-hint">Codex готовит ответ…</p>}
   </div>
   <form className="assistant-composer" onSubmit={sendProjectMessage}>
    <textarea rows={2} value={projectInput} onChange={e=>setProjectInput(e.target.value)} placeholder="Напиши запрос или попроси создать задачу" aria-label="Сообщение AI-помощнику"/>
    <button className="primary" disabled={projectChatBusy||!projectInput.trim()||!aiSettings.enabled} type="submit"><Send size={16}/> Отправить</button>
   </form>
   {!aiSettings.enabled&&<p className="assistant-disabled">Включи AI в настройках проекта.</p>}
  </section>}
  <button className="chat-fab" onClick={()=>setProjectChatOpen(open=>!open)} title={projectChatOpen?'Закрыть чат':'Открыть AI-чат'} aria-label={projectChatOpen?'Закрыть чат':'Открыть AI-чат'}>
   {projectChatOpen?<X size={22}/>:<MessageCircle size={22}/>}
  </button>
 </>}
 {showProject&&<div className="overlay" onMouseDown={()=>setShowProject(false)}><form className="dialog" onMouseDown={e=>e.stopPropagation()} onSubmit={createProject}><div className="modal-heading"><h2>Новый проект</h2><button type="button" onClick={()=>setShowProject(false)}><X/></button></div><label>Название<input required value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label><label>Описание<textarea value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></label><footer><button type="button" className="secondary" onClick={()=>setShowProject(false)}>Отмена</button><button className="primary" disabled={busy}>Создать</button></footer></form></div>}
 {showTask&&<div className="overlay" onMouseDown={()=>setShowTask(false)}><form className="dialog" onMouseDown={e=>e.stopPropagation()} onSubmit={createTask}><div className="modal-heading"><h2>Новая задача</h2><button type="button" onClick={()=>setShowTask(false)}><X/></button></div><label>Название<input required value={form.title} onChange={e=>setForm({...form,title:e.target.value})}/></label><label>Тип<select value={form.type} onChange={e=>setForm({...form,type:e.target.value})}><option value="task">Задача</option><option value="bug">Ошибка</option><option value="improvement">Улучшение</option><option value="epic">Эпик</option></select></label><label>Родительская задача<select value={form.parent_id} onChange={e=>setForm({...form,parent_id:e.target.value})}><option value="">Нет</option>{tasks.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></label><label>Описание<textarea rows={5} value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></label><footer><button type="button" className="secondary" onClick={()=>setShowTask(false)}>Отмена</button><button className="primary" disabled={busy}>Создать задачу</button></footer></form></div>}
 {activeTask&&<div className="overlay" onMouseDown={()=>setActiveTask(null)}>
  <div className="dialog task-dialog task-dialog-wide" onMouseDown={e=>e.stopPropagation()}>
   <div className="modal-heading"><span className="eyebrow">ЗАДАЧА #{activeTask.id.slice(0,6)}</span><button onClick={()=>setActiveTask(null)} title="Закрыть задачу"><X/></button></div>
   <div className="task-dialog-columns">
    <section className="task-details">
     <label>Название<input value={activeTask.title} onChange={e=>setActiveTask({...activeTask,title:e.target.value})}/></label>
     <label>Описание / краткое ТЗ<textarea rows={12} value={activeTask.description} onChange={e=>setActiveTask({...activeTask,description:e.target.value})}/></label>
     <label>Этап<select value={activeTask.stage} onChange={e=>setActiveTask({...activeTask,stage:e.target.value})}>{stages.map(st=><option key={st.stage} value={st.stage}>{st.label}</option>)}</select></label>
     {activeTask.stage==='analysis'&&<>
       <p className="muted"><strong>{activeTask.analysis_state==='needs_clarification'?'Ожидает уточнений':activeTask.analysis_state==='ready_for_development'?'Анализ завершён':'Анализ не завершён'}</strong></p>
       {Boolean(activeTask.clarification_questions?.length)&&<div className="task-ai-action"><strong>Открытые вопросы</strong>{activeTask.clarification_questions?.map((q,i)=><p key={i}>{i+1}. {q}</p>)}</div>}
       {activeTask.related_task_ids?.length? <p className="muted">Связанные задачи: {activeTask.related_task_ids.map(id=>tasks.find(t=>t.id===id)?.title||id.slice(0,8)).join(', ')}</p>:null}
       <button className="primary" disabled={taskChatBusy||!aiSettings.enabled||!gitLink||activeTask.analysis_state!=='ready_for_development'} onClick={()=>void approveDevelopment()}>Отправить в разработку</button>
     </>}
     {activeTask.git_branch&&<p className="muted">Ветка: <code>{activeTask.git_branch}</code></p>}
     {activeTask.pr_url&&<p><a href={activeTask.pr_url} target="_blank" rel="noreferrer">Открыть Pull Request</a></p>}
     {activeTask.stage==='merge_queue'&&<button className="primary" disabled={mergeBusy} onClick={()=>void mergeTask(activeTask)}>Слить</button>}
     <section className="task-ai-action">
      <div className="task-ai-heading"><strong>Исполнение</strong><small>Модель: {aiSettings.model}</small></div>
      <button className="primary" disabled={!aiSettings.enabled||taskChatBusy||aiBusy||!['analysis','development'].includes(activeTask.stage)||(activeTask.stage==='development'&&(!gitLink||aiRuns.some(r=>r.status==='running'||r.status==='queued')))} onClick={()=>void executeTask()}>
       Выполнить
      </button>
      {activeTask.stage==='analysis'&&<p className="muted">AI составит ТЗ в описании слева и подробный разбор в переписке справа.</p>}
      {activeTask.stage==='development'&&<p className="muted">Codex создаст отдельную ветку и черновик PR. После подготовки PR задача перейдёт в «Ожидает слияния».</p>}
      {activeTask.stage==='testing'&&<p className="muted">Автоматическое тестирование пока не подключено.</p>}
      {(activeTask.stage==='backlog'||activeTask.stage==='done')&&<p className="muted">Для AI-исполнения перенеси задачу в «Анализ» или «Разработку».</p>}
      {!aiSettings.enabled&&<p className="muted">Сначала включи ручной AI в настройках проекта.</p>}
      <p className="muted">Кнопка «Выполнить» сначала сохраняет поля задачи, затем запускает действие.</p>
      {aiRuns.filter(r=>r.task_id===activeTask.id).slice(0,4).map(run=><div className="task-run" key={run.id}>
       <b>{run.status==='completed'?'Готово':run.status==='failed'?'Ошибка':run.status==='running'?'Выполняется':'В очереди'}</b> · {run.model}
       {run.message&&<p>{run.message}</p>}
       {run.pr_url&&<a href={run.pr_url} target="_blank" rel="noreferrer">Открыть Pull Request</a>}
      </div>)}
     </section>
     <h4>История действий</h4>
     <div className="events">{events.map(ev=><div key={ev.id}><b>{ev.event==='created'?'Задача создана':ev.event==='analyzed'?'Анализ выполнен':'Изменение задачи'}</b><small>{ev.detail} · {new Date(ev.created_at).toLocaleString('ru-RU')}</small></div>)}{!events.length&&<span className="muted">История пуста</span>}</div>
     <footer className="task-details-footer"><button className="secondary" onClick={()=>setActiveTask(null)}>Отмена</button><button className="primary" onClick={()=>void saveTask({title:activeTask.title,description:activeTask.description,stage:activeTask.stage})}>Сохранить</button></footer>
    </section>
    <aside className="task-conversation">
     <header><MessageCircle size={17}/><strong>Обсуждение с AI</strong></header>
     <div ref={taskThreadRef} className="assistant-thread" role="log" aria-live="polite">
      {taskMessages.length===0&&<p className="assistant-hint">Здесь будет подробный анализ и переписка по задаче. Можно уточнять требования и обсуждать реализацию.</p>}
      {taskMessages.map(m=><div className={'assistant-bubble '+(m.role==='user'?'mine':'bot')} key={m.id}>
       <span className="assistant-author">{m.role==='user'?'Вы':'AI'}</span><div>{m.body}</div>
      </div>)}
      {taskChatBusy&&<p className="assistant-hint">Codex отвечает…</p>}
     </div>
     <form className="assistant-composer" onSubmit={sendTaskMessage}>
      <textarea rows={3} value={taskInput} onChange={e=>setTaskInput(e.target.value)} placeholder="Обсуди задачу, задай вопрос..." aria-label="Сообщение в чат задачи"/>
      <button className="primary" type="submit" disabled={taskChatBusy||!taskInput.trim()||!aiSettings.enabled}><Send size={15}/> Отправить</button>
     </form>
    </aside>
   </div>
  </div>
 </div>}
 {activeDoc&&<div className="overlay" onMouseDown={()=>setActiveDoc(null)}><div className="dialog doc-dialog" onMouseDown={e=>e.stopPropagation()}><div className="modal-heading"><h2>Редактор документа</h2><button onClick={()=>setActiveDoc(null)}><X/></button></div><label>Заголовок<input value={activeDoc.title} onChange={e=>setActiveDoc({...activeDoc,title:e.target.value})}/></label><label>Расположение<select value={activeDoc.parent_id||""} onChange={e=>setActiveDoc({...activeDoc,parent_id:e.target.value||null})}><option value="">Корень документации</option>{docs.filter(d=>d.id!==activeDoc.id).map(d=><option key={d.id} value={d.id}>{d.title}</option>)}</select></label><label>Содержание<textarea rows={17} value={activeDoc.body} onChange={e=>setActiveDoc({...activeDoc,body:e.target.value})}/></label><footer><button className="secondary" onClick={()=>setActiveDoc(null)}>Отмена</button><button className="primary" onClick={()=>void saveDoc(activeDoc)}>Сохранить</button></footer></div></div>}
 {showConnection&&<div className="overlay" onMouseDown={()=>setShowConnection(false)}><form className="dialog" onMouseDown={e=>e.stopPropagation()} onSubmit={addConnection}><div className="modal-heading"><h2>Новое подключение</h2><button type="button" onClick={()=>setShowConnection(false)}><X/></button></div><p className="muted">{cred.provider==='github_token'?'Подключение GitHub для выбранного проекта. Токен создаётся в GitHub и хранится в сервисе зашифрованным.':'Подключение по API-ключу. ChatGPT Plus / Codex CLI настраивается отдельно в разделе «Настройки аккаунта».'}</p>
 {cred.provider==='github_token'&&<div className="panel" style={{marginBottom:16,padding:16}}>
  <strong>Как получить GitHub token</strong>
  <ol style={{paddingLeft:20,marginBottom:8,lineHeight:1.65}}>
   <li>Открой <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">создание Fine-grained token в GitHub</a>.</li>
   <li>Выбери владельца и <b>Only select repositories</b> — только нужный репозиторий.</li>
   <li>В Repository permissions установи <b>Contents: Read and write</b>, <b>Pull requests: Read and write</b> и <b>Checks: Read</b> (Metadata: Read — автоматически).</li>
   <li>Создай токен, скопируй его и вставь в поле «Секрет» ниже.</li>
   <li>После сохранения выбери токен в блоке «GitHub · Репозиторий проекта» и нажми «Проверить и сохранить».</li>
  </ol>
  <small className="muted">Не отправляй токен в чат, не добавляй его в Git и не выдавай доступ ко всем репозиториям.</small>
 </div>}
 <label>Название подключения<input required placeholder={cred.provider==='github_token'?'GitHub — мой репозиторий':'OpenAI API — основной'} value={cred.name} onChange={e=>setCred({...cred,name:e.target.value})}/></label><label>Тип<select value={cred.provider} onChange={e=>setCred({...cred,provider:e.target.value})}><option value="openai_api">OpenAI API</option><option value="github_token">GitHub token</option></select></label><label>{cred.provider==='github_token'?'Секрет — GitHub personal access token':'Секрет — API-ключ'}<input required type="password" autoComplete="off" placeholder={cred.provider==='github_token'?'github_pat_...':'Вставь ключ'} value={cred.secret} onChange={e=>setCred({...cred,secret:e.target.value})}/></label><footer><button type="button" className="secondary" onClick={()=>setShowConnection(false)}>Отмена</button><button className="primary" disabled={busy}>Сохранить</button></footer></form></div>}
 </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
