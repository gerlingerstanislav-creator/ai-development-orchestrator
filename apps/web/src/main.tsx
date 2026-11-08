import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ArrowLeft,ArrowRight,BookOpen,ChevronDown,Columns3,FileText,KeyRound,LayoutGrid,List,Plus,Settings2,Trash2,MessageCircle,Send,Pencil,CheckCircle2,LoaderCircle,Clock3,ArrowRightCircle,X} from 'lucide-react';
import './style.css';

type Project={id:string,name:string,description:string};
type Task={id:string,title:string,description:string,type:string,stage:string,parent_id:string|null,created_at:string,analysis_state?:string,clarification_questions?:string[],related_task_ids?:string[],depends_on_task_id?:string|null,git_branch?:string|null,pr_url?:string|null,pr_base_branch?:string|null};
type Stage={stage:string,label:string,mode:'automatic'|'approval'|'manual',position:number};
type Doc={id:string,title:string,body:string,parent_id:string|null,updated_at:string};
type Connection={id:string,name:string,provider:string};
type GitLink={repository:string,default_branch:string,target_branch?:string,connection_id:string,connection_name?:string};
type AiSettings={model:'gpt-6-luna'|'gpt-6-sol'|'gpt-6.1-sol';reasoning:'low'|'medium';enabled:boolean};
type CodexRateWindow={usedPercent:number;windowDurationMins:number|null;resetsAt:number|null};
type CodexRateBucket={id:string;name:string|null;primary:CodexRateWindow|null;secondary:CodexRateWindow|null;planType:string|null;reachedType:string|null};
type CodexRateLimits={windows:CodexRateBucket[];resetCredits:number|null;checkedAt:string};
type TokenTotals={input_tokens:string;cached_input_tokens:string;output_tokens:string;requests:number};
type TokenUsageResponse={totals:TokenTotals;latest:Array<{operation:string;model:string;input_tokens:string;cached_input_tokens:string;output_tokens:string;created_at:string}>};
type AiRun={id:string;task_id:string;model:string;status:string;branch?:string|null;pr_url?:string|null;message?:string;created_at?:string;started_at?:string|null};
type ProjectRule={id:string,body:string,origin:string,created_at:string};
type RuleSuggestion={id:string,body:string,task_id:string};
type DocVersion={id:string,task_ids:string[],created_at:string};
type AssistantMessage={id:string;role:'user'|'assistant';body:string;created_task_id?:string|null;created_document_id?:string|null;created_at?:string};
type AssistantResponse={message:string;created_task_id?:string|null;created_document_id?:string|null;summary?:string|null;questions?:string[]};
type ActivityItem={id:string;kind:'user'|'assistant'|'event'|'run';text:string;time:string;title?:string;link?:string;status?:string};
type CodexState={connected:boolean;detail?:string;error?:string;login?:{state:string;url?:string|null;code?:string|null;instructions?:string;diagnosis?:string;startedAt?:number|null}|null};
const key='ado-token';
const defaultStages=['backlog','analysis','development','merge_queue','documentation','done'];

function markdownInline(source:string):React.ReactNode[]{
 const pattern=/(\[([^\]]+)\]\((https?:\/\/[^ )]+)\)|\*\*([^*]+)\*\*|\x60([^\x60]+)\x60)/g;
 const nodes:React.ReactNode[]=[];
 let last=0,match:RegExpExecArray|null;
 while((match=pattern.exec(source))!==null){
  if(match.index>last)nodes.push(source.slice(last,match.index));
  if(match[2]&&match[3])nodes.push(<a key={match.index} href={match[3]} target="_blank" rel="noopener noreferrer">{match[2]}</a>);
  else if(match[4])nodes.push(<strong key={match.index}>{match[4]}</strong>);
  else if(match[5])nodes.push(<code key={match.index}>{match[5]}</code>);
  last=pattern.lastIndex;
 }
 if(last<source.length)nodes.push(source.slice(last));
 return nodes;
}
function DocumentMarkdown({source}:{source:string}){
 const rows=source.replace(/\r\n/g,'\n').split('\n');
 const result:React.ReactNode[]=[];
 let index=0;
 while(index<rows.length){
  const line=rows[index];
  if(!line.trim()){index++;continue;}
  if(/^\s*\x60{3}/.test(line)){
   const language=line.trim().slice(3);
   const code:string[]=[];
   index++;
   while(index<rows.length&&!/^\s*\x60{3}/.test(rows[index]))code.push(rows[index++]);
   if(index<rows.length)index++;
   result.push(<pre key={'block-'+index} className="docs-code"><code data-language={language}>{code.join('\n')}</code></pre>);
   continue;
  }
  const heading=/^(#{1,6})\s+(.+)$/.exec(line);
  if(heading){
   const level=heading[1].length;
   const contents=markdownInline(heading[2]);
   const props={key:'heading-'+index,className:'docs-heading docs-h'+level};
   result.push(level===1?<h1 {...props}>{contents}</h1>:level===2?<h2 {...props}>{contents}</h2>:level===3?<h3 {...props}>{contents}</h3>:<h4 {...props}>{contents}</h4>);
   index++;continue;
  }
  if(line.trim().startsWith('|')&&index+1<rows.length&&
     /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(rows[index+1])){
   const cells=(value:string)=>value.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(x=>x.trim());
   const headings=cells(line);
   index+=2;
   const content:React.ReactNode[]=[];
   while(index<rows.length&&rows[index].trim().startsWith('|')){
    const values=cells(rows[index]);
    content.push(<tr key={'row-'+index}>{headings.map((_,col)=><td key={col}>{markdownInline(values[col]||'')}</td>)}</tr>);
    index++;
   }
   result.push(<div key={'table-'+index} className="docs-table-wrap"><table><thead><tr>{headings.map((h,col)=><th key={col}>{markdownInline(h)}</th>)}</tr></thead><tbody>{content}</tbody></table></div>);
   continue;
  }
  if(/^\s*([-*+] |\d+\. )/.test(line)){
   const ordered=/^\s*\d+\. /.test(line);
   const items:React.ReactNode[]=[];
   while(index<rows.length&&/^\s*([-*+] |\d+\. )/.test(rows[index])){
    items.push(<li key={'li-'+index}>{markdownInline(rows[index].replace(/^\s*(?:[-*+] |\d+\. )/,''))}</li>);
    index++;
   }
   result.push(ordered?<ol key={'list-'+index}>{items}</ol>:<ul key={'list-'+index}>{items}</ul>);
   continue;
  }
  if(/^\s*>\s?/.test(line)){
   const text:string[]=[];
   while(index<rows.length&&/^\s*>\s?/.test(rows[index]))text.push(rows[index++].replace(/^\s*>\s?/,''));
   result.push(<blockquote key={'quote-'+index}>{text.map((x,i)=><React.Fragment key={i}>{i>0&&' '}{markdownInline(x)}</React.Fragment>)}</blockquote>);
   continue;
  }
  if(/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)){result.push(<hr key={'hr-'+index}/>);index++;continue;}
  const paragraphs:string[]=[];
  while(index<rows.length&&rows[index].trim()&&!/^(#{1,6})\s+/.test(rows[index])&&!/^\s*\x60{3}/.test(rows[index])&&!/^\s*([-*+] |\d+\. )/.test(rows[index])&&!/^\s*>\s?/.test(rows[index])){
   paragraphs.push(rows[index++]);
  }
  if(paragraphs.length)result.push(<p key={'p-'+index}>{paragraphs.map((text,i)=><React.Fragment key={i}>{i>0&&' '}{markdownInline(text)}</React.Fragment>)}</p>);
 }
 return <article className="docs-markdown">{result}</article>;
}

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
 const [section,setSection]=useState<'overview'|'tasks'|'docs'|'rules'|'settings'>('tasks');
 const [accountSettings,setAccountSettings]=useState(false);
 const [rateLimits,setRateLimits]=useState<CodexRateLimits|null>(null);
 const [tokenUsage,setTokenUsage]=useState<TokenUsageResponse|null>(null);
 const [rateLimitsBusy,setRateLimitsBusy]=useState(false);
 const [rateLimitsError,setRateLimitsError]=useState('');
 const [tasks,setTasks]=useState<Task[]>([]);const [stages,setStages]=useState<Stage[]>([]);
 const [docs,setDocs]=useState<Doc[]>([]);
 const [rules,setRules]=useState<ProjectRule[]>([]);const [ruleSuggestions,setRuleSuggestions]=useState<RuleSuggestion[]>([]);
 const [ruleDraft,setRuleDraft]=useState('');const [knowledgeBusy,setKnowledgeBusy]=useState(false);
 const [documentVersions,setDocumentVersions]=useState<DocVersion[]>([]);const [documentationNotice,setDocumentationNotice]=useState('');
const [collapsedDocs,setCollapsedDocs]=useState<string[]>([]);const [connections,setConnections]=useState<Connection[]>([]);
 const [projectConnections,setProjectConnections]=useState<Connection[]>([]);
 const [aiSettings,setAiSettings]=useState<AiSettings>({model:'gpt-6-luna',reasoning:'low',enabled:false});
 const [aiBusy,setAiBusy]=useState(false);const [aiRuns,setAiRuns]=useState<AiRun[]>([]);const [aiMessage,setAiMessage]=useState('');
 const [targetBranch,setTargetBranch]=useState('');const [mergeBusy,setMergeBusy]=useState(false);const [mergeReport,setMergeReport]=useState('');
 const [gitLink,setGitLink]=useState<GitLink|null>(null);const [gitRepository,setGitRepository]=useState('');const [gitTokenId,setGitTokenId]=useState('');const [gitBusy,setGitBusy]=useState(false);const [gitMessage,setGitMessage]=useState('');
 const [view,setView]=useState<'board'|'list'>('board');
 const [activeTask,setActiveTask]=useState<Task|null>(null);
 const [elapsedNow,setElapsedNow]=useState(Date.now());
 const [editingField,setEditingField]=useState<'title'|'description'|null>(null);
 const [savingField,setSavingField]=useState(false);const [taskFeedback,setTaskFeedback]=useState('');
 const [selectedDocId,setSelectedDocId]=useState<string|null>(null);
 const [editingDoc,setEditingDoc]=useState<Doc|null>(null);
 const [docBusy,setDocBusy]=useState(false);
 const [showProject,setShowProject]=useState(false);const [showTask,setShowTask]=useState(false);const [showConnection,setShowConnection]=useState(false);
 useEffect(()=>{
  const modalOpen=!!(activeTask||showProject||showTask||showConnection);
  if(!modalOpen)return;
  const previous=document.body.style.overflow;
  document.body.style.overflow='hidden';
  return()=>{document.body.style.overflow=previous;};
 },[activeTask,showProject,showTask,showConnection]);
 useEffect(()=>{
  if(!aiRuns.some(r=>r.status==='running'||r.status==='queued'))return;
  const interval=window.setInterval(()=>setElapsedNow(Date.now()),1000);
  return()=>window.clearInterval(interval);
 },[aiRuns]);


 const [error,setError]=useState('');
 useEffect(()=>{if(!error)return;const timeout=window.setTimeout(()=>setError(''),9500);return()=>window.clearTimeout(timeout);},[error]);
 const [busy,setBusy]=useState(false);const [search,setSearch]=useState('');
 const [form,setForm]=useState({name:'',description:'',title:'',type:'task',parent_id:''});
 const [cred,setCred]=useState({name:'',provider:'openai_api',secret:''});
 const [codex,setCodex]=useState<CodexState|null>(null);const [codexBusy,setCodexBusy]=useState(false);const [codexTest,setCodexTest]=useState('');
 const [events,setEvents]=useState<{id:string,event:string,detail:string,created_at:string}[]>([]);
 const projectThreadRef=useRef<HTMLDivElement|null>(null);const taskThreadRef=useRef<HTMLDivElement|null>(null);
 const projectInputRef=useRef<HTMLTextAreaElement|null>(null);
 const [projectChatOpen,setProjectChatOpen]=useState(false);
 useEffect(()=>{if(projectChatOpen)projectInputRef.current?.focus();},[projectChatOpen]);
 const [projectMessages,setProjectMessages]=useState<AssistantMessage[]>([]);
 const [projectInput,setProjectInput]=useState('');const [projectChatBusy,setProjectChatBusy]=useState(false);
 const [taskMessages,setTaskMessages]=useState<AssistantMessage[]>([]);
 const [taskInput,setTaskInput]=useState('');const [taskChatBusy,setTaskChatBusy]=useState(false);
 function timeline(taskId:string):ActivityItem[]{
  return [
   ...taskMessages.map(m=>({id:'msg-'+m.id,kind:m.role,text:m.body,time:m.created_at||new Date().toISOString()})),
   ...events.map(ev=>({id:'evt-'+ev.id,kind:'event' as const,title:ev.event==='created'?'Задача создана':ev.event==='analyzed'?'Анализ обновлён':ev.event==='merged'?'PR слит':ev.event==='documentation_updated'?'Документация обновлена':'Изменение задачи',text:ev.detail,time:ev.created_at})),
   ...aiRuns.filter(r=>r.task_id===taskId).map(r=>({id:'run-'+r.id,kind:'run' as const,title:r.status==='completed'?'Разработка завершена':r.status==='failed'?'Ошибка разработки':r.status==='running'?'Codex работает':'Задача в очереди',text:r.message||'Агент выполняет задачу',time:r.created_at||new Date().toISOString(),status:r.status,link:r.pr_url||undefined}))
  ].sort((a,b)=>new Date(a.time).getTime()-new Date(b.time).getTime());
 }
 async function refreshTaskActivity(projectId:string,taskId:string){
  try{
   const [ts,ev,ms]=await Promise.all([
    api<Task[]>('/projects/'+projectId+'/tasks'),
    api<typeof events>('/projects/'+projectId+'/tasks/'+taskId+'/events'),
    api<AssistantMessage[]>('/projects/'+projectId+'/tasks/'+taskId+'/assistant/messages')
   ]);
   setTasks(ts);setEvents(ev);setTaskMessages(ms);
   setActiveTask(current=>current?.id===taskId?ts.find(t=>t.id===taskId)||current:current);
  }catch(e){fail(e);}
 }
 function canAdvance(task:Task,from:string,to:string){
  if(task.stage!==from)return false;
  if(from==='backlog'&&to==='analysis')return true;
  if(from==='analysis'&&to==='development')return task.analysis_state==='ready_for_development'&&!taskChatBusy&&!!gitLink&&aiSettings.enabled;
  if(from==='development'&&to==='merge_queue')return !aiBusy&&!aiRuns.some(r=>r.task_id===task.id&&['running','queued'].includes(r.status));
  if(from==='merge_queue'&&to==='documentation')return !mergeBusy;
  if(from==='documentation'&&to==='done')return !knowledgeBusy;
  return false;
 }
 async function advanceTask(task:Task,from:string,to:string){
  if(!selected||!canAdvance(task,from,to))return;
  if(from==='backlog'){
   try{await api('/projects/'+selected.id+'/tasks/'+task.id,{method:'PATCH',body:JSON.stringify({stage:'analysis'})});
    await refreshTaskActivity(selected.id,task.id);
   }catch(e){fail(e);}
  }else if(from==='analysis')await approveDevelopment();
  else if(from==='development')await runAiTask();
  else if(from==='merge_queue')await mergeTask(task);
  else if(from==='documentation')await updateDocumentation();
 }
 const [drag,setDrag]=useState<string|null>(null);
 function fail(e:unknown){setError(e instanceof Error?e.message:'Неизвестная ошибка');}
 async function loadProjects(){try{setProjects(await api('/projects'));}catch(e){fail(e);}}
 async function loadProject(id:string){
  try{
   const [t,s,d,c,pc,gl,ai,runs,pr,suggestions,versions]=await Promise.all([api<Task[]>('/projects/'+id+'/tasks'),api<Stage[]>('/projects/'+id+'/workflow'),api<Doc[]>('/projects/'+id+'/docs'),api<Connection[]>('/connections'),api<Connection[]>('/projects/'+id+'/connections'),api<GitLink|null>('/projects/'+id+'/git'),api<AiSettings>('/projects/'+id+'/ai-settings'),api<AiRun[]>('/projects/'+id+'/ai-runs'),api<ProjectRule[]>('/projects/'+id+'/rules'),api<RuleSuggestion[]>('/projects/'+id+'/rule-suggestions'),api<DocVersion[]>('/projects/'+id+'/documentation/versions')]);
   setTasks(t);setStages(s);setDocs(d);setConnections(c);setProjectConnections(pc);setGitLink(gl);setGitRepository(gl?.repository||'');setTargetBranch(gl?.target_branch||gl?.default_branch||'');setGitTokenId(gl?.connection_id||'');setGitMessage('');setAiSettings(ai);setAiRuns(runs);setAiMessage('');setRules(pr);setRuleSuggestions(suggestions);setDocumentVersions(versions);
  }catch(e){fail(e);}
 }
 useEffect(()=>{if(token)void loadProjects();},[token]);
 useEffect(()=>{if(selected)void loadProject(selected.id);},[selected?.id]);
 useEffect(()=>{if(projectThreadRef.current)projectThreadRef.current.scrollTop=projectThreadRef.current.scrollHeight;},[projectMessages,projectChatOpen,projectChatBusy]);
 useEffect(()=>{
  const element=taskThreadRef.current;
  if(!element)return;
  element.scrollTop=element.scrollHeight;
 },[taskMessages,taskChatBusy,events,aiRuns,activeTask?.id,taskFeedback]);
 useEffect(()=>{setProjectChatOpen(false);setProjectMessages([]);setProjectInput('');if(selected&&!accountSettings){void api<AssistantMessage[]>('/projects/'+selected.id+'/assistant/messages').then(setProjectMessages).catch(fail);}},[selected?.id]);
 useEffect(()=>{setTaskMessages([]);setTaskInput('');if(selected&&activeTask){void api<AssistantMessage[]>('/projects/'+selected.id+'/tasks/'+activeTask.id+'/assistant/messages').then(setTaskMessages).catch(fail);}},[selected?.id,activeTask?.id]);
 async function signIn(e:React.FormEvent){e.preventDefault();setError('');try{const d=await api<{token:string}>('/login',{method:'POST',body:JSON.stringify({email:login,password})});sessionStorage.setItem(key,d.token);setToken(d.token);}catch(e){fail(e);}}
 async function createProject(e:React.FormEvent){e.preventDefault();setBusy(true);try{const p=await api<Project>('/projects',{method:'POST',body:JSON.stringify({name:form.name,description:form.description})});await loadProjects();setSelected(p);setShowProject(false);setForm({...form,name:'',description:''});}catch(e){fail(e);}finally{setBusy(false);}}
 async function createTask(e:React.FormEvent){e.preventDefault();if(!selected)return;setBusy(true);try{await api('/projects/'+selected.id+'/tasks',{method:'POST',body:JSON.stringify({title:form.title,description:form.description,type:form.type,parent_id:form.parent_id||null})});await loadProject(selected.id);setShowTask(false);setForm({...form,title:'',description:'',parent_id:''});}catch(e){fail(e);}finally{setBusy(false);}}
 async function autoSaveField(field:'title'|'description',value:string){if(!selected||!activeTask)return;
  const taskId=activeTask.id;
  setEditingField(null);setSavingField(true);
  try{
   await api('/projects/'+selected.id+'/tasks/'+taskId,{method:'PATCH',body:JSON.stringify({[field]:value})});
   setTasks(old=>old.map(t=>t.id===taskId?{...t,[field]:value}:t));
  }catch(e){setTaskFeedback(e instanceof Error?e.message:'Ошибка автосохранения');fail(e);}finally{setSavingField(false);}
 }
 async function moveTask(task:Task,stage:string){if(!selected||stage===task.stage)return;try{await api('/projects/'+selected.id+'/tasks/'+task.id,{method:'PATCH',body:JSON.stringify({stage})});await loadProject(selected.id);}catch(e){fail(e);}}
 async function modeChange(stage:string,mode:string){if(!selected)return;try{await api('/projects/'+selected.id+'/workflow/'+stage,{method:'PATCH',body:JSON.stringify({mode})});await loadProject(selected.id);}catch(e){fail(e);}}
 async function addDoc(parentId:string|null=null){
  if(!selected||docBusy)return;
  setDocBusy(true);
  try{
   const added=await api<{id:string}>('/projects/'+selected.id+'/docs',{method:'POST',body:JSON.stringify({title:'Новая страница',body:'',parent_id:parentId})});
   const doc:Doc={id:added.id,title:'Новая страница',body:'',parent_id:parentId,updated_at:new Date().toISOString()};
   if(parentId)setCollapsedDocs(items=>items.filter(x=>x!==parentId));
   setDocs(old=>[...old,doc]);
   setSelectedDocId(doc.id);
   setEditingDoc({...doc});
  }catch(e){fail(e);}finally{setDocBusy(false);}
 }
 async function saveDoc(){
  if(!selected||!editingDoc||docBusy)return;
  const doc={...editingDoc,title:editingDoc.title.trim()};
  if(!doc.title){setError('У документа должно быть название');return;}
  setDocBusy(true);
  try{
   await api('/projects/'+selected.id+'/docs/'+doc.id,{method:'PATCH',body:JSON.stringify({title:doc.title,body:doc.body,parent_id:doc.parent_id})});
   setDocs(old=>old.map(d=>d.id===doc.id?{...doc,updated_at:new Date().toISOString()}:d));
   setEditingDoc(null);
  }catch(e){fail(e);}finally{setDocBusy(false);}
 }
 async function deleteDoc(doc:Doc){
  if(!selected||docBusy)return;
  const children=docs.filter(d=>d.parent_id===doc.id);
  if(children.length){setError('У страницы «'+doc.title+'» есть вложенные документы. Сначала перемести или удали их.');return;}
  if(!window.confirm('Удалить документ «'+doc.title+'»? Это действие нельзя отменить.'))return;
  setDocBusy(true);
  try{
   await api('/projects/'+selected.id+'/docs/'+doc.id,{method:'DELETE'});
   setDocs(old=>old.filter(d=>d.id!==doc.id));
   setSelectedDocId(null);setEditingDoc(null);
  }catch(e){fail(e);}finally{setDocBusy(false);}
 }
 function selectDoc(doc:Doc){
  if(editingDoc&&(editingDoc.title!==docs.find(d=>d.id===editingDoc.id)?.title||editingDoc.body!==docs.find(d=>d.id===editingDoc.id)?.body||editingDoc.parent_id!==docs.find(d=>d.id===editingDoc.id)?.parent_id)){
   if(!window.confirm('Изменения документа не сохранены. Перейти без сохранения?'))return;
  }
  setSelectedDocId(doc.id);setEditingDoc(null);
 }
 async function addConnection(e:React.FormEvent){e.preventDefault();setBusy(true);try{const saved=await api<Connection>('/connections',{method:'POST',body:JSON.stringify(cred)});setCred({name:'',provider:'github_token',secret:''});setShowConnection(false);if(selected)await loadProject(selected.id);if(saved.provider==='github_token')setGitTokenId(saved.id);}catch(e){fail(e);}finally{setBusy(false);}}
 async function attachConnection(connectionId:string){if(!selected)return;try{await api('/projects/'+selected.id+'/connections',{method:'POST',body:JSON.stringify({connectionId})});await loadProject(selected.id);}catch(e){fail(e);}}
 async function saveGitLink(){if(!selected)return;setGitBusy(true);setGitMessage('');try{const r=await api<GitLink>('/projects/'+selected.id+'/git',{method:'PUT',body:JSON.stringify({repository:gitRepository.trim(),connectionId:gitTokenId,targetBranch:targetBranch.trim()||undefined})});setGitLink(r);setTargetBranch(r.target_branch||r.default_branch);setGitMessage('Доступ проверен. Репозиторий привязан.');}catch(e){fail(e);}finally{setGitBusy(false);}}
 async function removeGitLink(){if(!selected)return;setGitBusy(true);try{await api('/projects/'+selected.id+'/git',{method:'DELETE'});setGitLink(null);setGitMessage('Привязка удалена.');}catch(e){fail(e);}finally{setGitBusy(false);}}
 async function updateDocumentation(){if(!selected||knowledgeBusy)return;
  setKnowledgeBusy(true);setDocumentationNotice('');
  try{
   const r=await api<{updated_tasks:number}>('/projects/'+selected.id+'/documentation/update',{method:'POST'});
   setDocumentationNotice('Документация обновлена по '+r.updated_tasks+' задачам. Задачи переведены в «Готово».');
   await loadProject(selected.id);
  }catch(e){fail(e);}finally{setKnowledgeBusy(false);}
 }
 async function addRule(e:React.FormEvent){e.preventDefault();if(!selected||!ruleDraft.trim())return;
  setKnowledgeBusy(true);
  try{const r=await api<ProjectRule>('/projects/'+selected.id+'/rules',{method:'POST',body:JSON.stringify({body:ruleDraft.trim()})});
   setRules(old=>[...old,r]);setRuleDraft('');
  }catch(e){fail(e);}finally{setKnowledgeBusy(false);}
 }
 async function removeRule(ruleId:string){if(!selected)return;
  setKnowledgeBusy(true);try{await api('/projects/'+selected.id+'/rules/'+ruleId,{method:'DELETE'});setRules(old=>old.filter(r=>r.id!==ruleId));}
  catch(e){fail(e);}finally{setKnowledgeBusy(false);}
 }
 async function decideRule(id:string,decision:'approve'|'reject'){if(!selected)return;
  setKnowledgeBusy(true);
  try{await api('/projects/'+selected.id+'/rule-suggestions/'+id+'/decision',{method:'POST',body:JSON.stringify({decision})});
   await loadProject(selected.id);
  }catch(e){fail(e);}finally{setKnowledgeBusy(false);}
 }
 async function refreshTokenUsage(){
  try{setTokenUsage(await api<TokenUsageResponse>('/ai/token-usage'));}catch(e){fail(e);}
 }
 async function refreshRateLimits(){
  setRateLimitsBusy(true);setRateLimitsError('');
  try{const data=await api<CodexRateLimits>('/codex/rate-limits');setRateLimits(data);}
  catch(e){setRateLimits(null);setRateLimitsError('');fail(e);}
  finally{setRateLimitsBusy(false);}
 }
 useEffect(()=>{if(token&&accountSettings){void refreshRateLimits();void refreshTokenUsage();}},[token,accountSettings]);
 async function saveAiSettings(){if(!selected)return;setAiBusy(true);try{const saved=await api<AiSettings>('/projects/'+selected.id+'/ai-settings',{method:'PUT',body:JSON.stringify(aiSettings)});setAiSettings(saved);setAiMessage('Настройки сохранены');}catch(e){fail(e);}finally{setAiBusy(false);}}
 async function runAiTask(){if(!selected||!activeTask)return;setAiBusy(true);setAiMessage('');try{
   const response=await api<AiRun&{recovered?:boolean}>('/projects/'+selected.id+'/tasks/'+activeTask.id+'/run-ai',{method:'POST'});
   if(response.recovered){
    setTaskFeedback(response.message||'Изменения уже готовы. PR автоматически создан без повторного вызова Codex.');
    await loadProject(selected.id);
    const currentId=activeTask.id;
    const current=await api<Task[]>('/projects/'+selected.id+'/tasks');
    setActiveTask(old=>old?.id===currentId?current.find(t=>t.id===currentId)||old:old);
    setEvents(await api<Array<{id:string;event:string;detail:string;created_at:string}>>('/projects/'+selected.id+'/tasks/'+currentId+'/events'));
   }else{
    setAiRuns(old=>[response,...old]);
    setAiMessage('Codex запущен. PR будет создан автоматически после завершения разработки.');
   }
  }catch(e){setTaskFeedback(e instanceof Error?e.message:'Не удалось начать разработку');fail(e);}finally{setAiBusy(false);}}
 useEffect(()=>{if(!token||!selected||!aiRuns.some(r=>r.status==='running'||r.status==='queued'))return;
  const timer=setInterval(async()=>{const active=aiRuns.filter(r=>r.status==='running'||r.status==='queued');
   const updated=await Promise.all(active.map(async r=>{try{return await api<AiRun>('/projects/'+selected.id+'/ai-runs/'+r.id);}catch(e){return {...r,message:'Не удалось обновить статус: '+(e instanceof Error?e.message:'ошибка сети')};}}));
   setAiRuns(old=>old.map(r=>updated.find(x=>x.id===r.id)||r));
   if(activeTask){
    try{const latestEvents=await api<typeof events>('/projects/'+selected.id+'/tasks/'+activeTask.id+'/events');setEvents(latestEvents);}
    catch(e){fail(e);}
   }
   if(updated.some(r=>r.status==='completed'||r.status==='failed')){try{const currentTasks=await api<Task[]>('/projects/'+selected.id+'/tasks');setTasks(currentTasks);setActiveTask(old=>old?currentTasks.find(t=>t.id===old.id)||old:old);}catch(e){fail(e);}}
  },4000);
  return()=>clearInterval(timer);
 },[token,selected?.id,aiRuns,activeTask?.id]);
 async function sendProjectMessage(e:React.FormEvent){e.preventDefault();if(!selected||!projectInput.trim()||projectChatBusy)return;
  const message=projectInput.trim();setProjectChatBusy(true);
  try{const response=await api<AssistantResponse>('/projects/'+selected.id+'/assistant',{method:'POST',body:JSON.stringify({message})});
   setProjectMessages(old=>[...old,{id:'u-'+Date.now(),role:'user' as const,body:message},{id:'a-'+Date.now(),role:'assistant' as const,body:response.message,created_task_id:response.created_task_id,created_document_id:response.created_document_id}]);
   setProjectInput('');if(response.created_task_id||response.created_document_id)await loadProject(selected.id);
  }catch(e){fail(e);}finally{setProjectChatBusy(false);}
 }
 async function sendTaskMessage(e:React.FormEvent){e.preventDefault();if(!selected||!activeTask||!taskInput.trim()||taskChatBusy)return;
  const message=taskInput.trim();setTaskChatBusy(true);
  try{const response=await api<AssistantResponse>('/projects/'+selected.id+'/tasks/'+activeTask.id+'/assistant',{method:'POST',body:JSON.stringify({message,mode:'chat'})});
   setTaskMessages(old=>[...old,{id:'u-'+Date.now(),role:'user' as const,body:message},{id:'a-'+Date.now(),role:'assistant' as const,body:response.message}]);
   setTaskInput('');await refreshTaskActivity(selected.id,activeTask.id);
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

 async function setDependency(task:Task,parent:string|null){
  if(!selected)return;
  try{
   const result=await api<{depends_on_task_id:string|null}>('/projects/'+selected.id+'/tasks/'+task.id+'/dependency',{method:'PUT',body:JSON.stringify({depends_on_task_id:parent})});
   setTasks(old=>old.map(t=>t.id===task.id?{...t,depends_on_task_id:result.depends_on_task_id}:t));
   setActiveTask(old=>old?.id===task.id?{...old,depends_on_task_id:result.depends_on_task_id}:old);
   const log=await api<Array<{id:string;event:string;detail:string;created_at:string}>>('/projects/'+selected.id+'/tasks/'+task.id+'/events');
   setEvents(log);
  }catch(e){fail(e);}
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
   }catch(e){setTaskFeedback(e instanceof Error?e.message:'Разработка не началась');fail(e);}
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
 async function openTask(t:Task){setActiveTask({...t});setEditingField(null);setTaskFeedback('');setEvents([]);if(selected){try{setEvents(await api('/projects/'+selected.id+'/tasks/'+t.id+'/events'));}catch(e){fail(e);}}}
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
     <button className={'doc-title '+(selectedDocId===d.id?'selected':'')} type="button" onClick={()=>selectDoc(d)}><FileText size={16}/><span>{d.title}</span></button>
     <button className="doc-add-child" type="button" title="Добавить вложенную страницу" aria-label={'Добавить страницу в '+d.title} onClick={()=>void addDoc(d.id)}><Plus size={15}/></button>
    </div>
    {!collapsed&&hasChildren&&renderDocTree(d.id,depth+1)}
   </div>;
  });
 }
 const filtered=tasks.filter(t=>t.title.toLowerCase().includes(search.toLowerCase()));
 if(!token)return <div className="login-shell"><form className="login-card" onSubmit={signIn}><span className="logo-icon">◈</span><h1>AI Development<br/>Orchestrator</h1><p>Войдите, чтобы управлять проектами</p><label>Электронная почта<input type="text" inputMode="email" autoComplete="username" required value={login} onChange={e=>setLogin(e.target.value)} placeholder="admin@example.com"/></label><label>Пароль<input type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)}/></label><button className="primary">Войти</button></form>{error&&<div className="error-toast" role="alert"><span>{error}</span><button type="button" title="Закрыть уведомление" aria-label="Закрыть уведомление" onClick={()=>setError('')}><X size={17}/></button></div>}</div>;
 return <div className="shell">
 <aside className="sidebar"><div className="brand"><span className="logo-icon">◈</span><span>Orchestrator<small>WORKSPACE</small></span></div>
  <div className="sidebar-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
  <button className={'nav '+(!selected&&!accountSettings?'active':'')} onClick={()=>{setAccountSettings(false);setSelected(null);}}><LayoutGrid size={18}/> Мои проекты</button>
  {selected&&<><div className="sidebar-label">{selected.name.toUpperCase()}</div>
   {([['overview','Обзор',LayoutGrid],['tasks','Задачи',Columns3],['docs','Документация',BookOpen],['rules','Правила',FileText],['settings','Настройки',Settings2]] as const).map(([k,label,Icon])=><button key={k} className={'nav '+(section===k?'active':'')} onClick={()=>{setAccountSettings(false);setSection(k);}}><Icon size={18}/>{label}</button>)}
  </>}
  <div className="sidebar-label">АККАУНТ</div>
  <button className={'nav '+(accountSettings?'active':'')} onClick={()=>setAccountSettings(true)}><Settings2 size={18}/> Настройки аккаунта</button>

  <div className="sidebar-bottom"><span className="avatar">AD</span><span>Администратор</span><button onClick={logout} title="Выйти">Выйти</button></div>
 </aside>
 <main className="main"><header className="topbar"><span className="crumb" onClick={()=>{setSelected(null);setAccountSettings(false);}}>Мои проекты</span>{accountSettings?<><span className="slash">/</span><strong>Настройки аккаунта</strong></>:selected&&<><span className="slash">/</span><strong>{selected.name}</strong><span className="slash">/</span><strong>{section==='overview'?'Обзор':section==='tasks'?'Задачи':section==='docs'?'Документация':section==='rules'?'Правила':'Настройки'}</strong></>}<span className="top-right">● {selected?(aiSettings.enabled?"AI: ручной запуск":"AI выключен"):"Ручной режим"}</span></header>
 
 {accountSettings?<div className="page compact-project-page">
 <section className="panel codex-panel">
  <div className="row-line"><h3>Использованные токены Codex</h3><button className="secondary" onClick={()=>void refreshTokenUsage()}>Обновить</button></div>
  <p className="muted">Фактический расход токенов, сообщённый Codex CLI в JSON-событиях. Учёт начнётся с новых запросов после обновления; прошлые запуски без сохранённой статистики не включены.</p>
  {tokenUsage?<div className="token-usage-grid">
   <div><small>Входящие</small><strong>{Number(tokenUsage.totals.input_tokens).toLocaleString('ru-RU')}</strong></div>
   <div><small>Из кеша</small><strong>{Number(tokenUsage.totals.cached_input_tokens).toLocaleString('ru-RU')}</strong></div>
   <div><small>Исходящие</small><strong>{Number(tokenUsage.totals.output_tokens).toLocaleString('ru-RU')}</strong></div>
   <div><small>Запросов с учётом</small><strong>{tokenUsage.totals.requests}</strong></div>
  </div>:<p className="muted">Пока нет данных об использовании.</p>}
 </section>
  <section className="panel codex-panel">
  <div className="row-line"><h3>Лимиты Codex · ChatGPT</h3><button className="secondary" disabled={rateLimitsBusy} onClick={()=>void refreshRateLimits()}>{rateLimitsBusy?'Обновление…':'Обновить'}</button></div>
  <p className="muted">Данные текущего подключённого аккаунта Codex: использованная доля лимита и время его сброса. Это не лимит сообщений обычного ChatGPT и не ручные ограничения сервиса.</p>
  {rateLimitsError&&<p className="error">{rateLimitsError}</p>}
  {rateLimits&&!rateLimits.windows.length&&<p className="muted">Codex не предоставил доступных окон лимитов для этого аккаунта.</p>}
  {rateLimits?.windows.map(bucket=><div className="codex-limit-bucket" key={bucket.id}>
   <strong>{bucket.name||bucket.id}{bucket.planType?' · '+bucket.planType:''}</strong>
   {[bucket.primary,bucket.secondary].map((win,i)=>win&&<div key={i} className="codex-limit-window">
    <div className="row-line"><span>{win.windowDurationMins?win.windowDurationMins>=1440?Math.round(win.windowDurationMins/1440)+' дн.':win.windowDurationMins>=60?(win.windowDurationMins/60).toFixed(1)+' ч.':win.windowDurationMins+' мин.':'Окно'}</span>
     <strong>{Math.round(100-win.usedPercent)}% доступно</strong></div>
    <div className="codex-limit-track"><div style={{width:Math.min(100,Math.max(0,100-win.usedPercent))+'%'}}/></div>
    <small>{win.resetsAt?'Обновится: '+new Date(win.resetsAt*1000).toLocaleString('ru-RU'):'Время сброса не указано'}</small>
   </div>)}
  </div>)}
  {rateLimits&&<p className="muted">Обновлено: {new Date(rateLimits.checkedAt).toLocaleString('ru-RU')}{rateLimits.resetCredits!==null?' · Доступно сбросов лимита: '+rateLimits.resetCredits:''}</p>}
 </section>
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
 {section==='tasks'&&<><div className="toolbar"><input className="search" aria-label="Поиск по задачам" placeholder="Поиск по задачам…" value={search} onChange={e=>setSearch(e.target.value)}/><div className="segmented"><button className={view==='board'?'chosen':''} onClick={()=>setView('board')}><Columns3 size={16}/> Канбан</button><button className={view==='list'?'chosen':''} onClick={()=>setView('list')}><List size={16}/> Список</button></div><div className="task-create-actions"><button className="primary create-task" onClick={()=>{setForm({...form,title:'',description:'',type:'task',parent_id:''});setShowTask(true);}}><Plus size={17}/> Создать задачу</button><button className="primary create-task-text" type="button" title="Создать задачу текстом через AI" aria-label="Создать задачу текстом" onClick={()=>{setProjectInput(old=>old.trim()?old:'Создай задачу: ');setProjectChatOpen(true);}}><FileText size={17}/></button></div></div>
 {mergeReport&&<div className="panel merge-report">{mergeReport}</div>}{documentationNotice&&<div className="panel merge-report">{documentationNotice}</div>}{view==='board'?<div className="board">{stages.map(s=><div className="lane" key={s.stage} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(drag){const task=tasks.find(t=>t.id===drag);if(task)void moveTask(task,s.stage);}setDrag(null);}}><div className="lane-heading"><span className={'stage-dot '+s.stage}></span><b>{s.label}</b><span className="count">{filtered.filter(t=>t.stage===s.stage).length}</span>
   {s.stage==='merge_queue'&&<button className="secondary" disabled={mergeBusy||!tasks.some(t=>t.stage==='merge_queue')} onClick={e=>{e.stopPropagation();void mergeReady();}} title="Последовательно слить проверенные PR">Слить готовые</button>}
   {s.stage==='documentation'&&<button className="secondary" disabled={knowledgeBusy||!tasks.some(t=>t.stage==='documentation')} onClick={e=>{e.stopPropagation();void updateDocumentation();}} title="Обновить документацию по всем слитым задачам">Обновить документацию</button>}</div><div className="cards">{filtered.filter(t=>t.stage===s.stage).map(t=><button className="task-card" draggable onDragStart={e=>{setDrag(t.id);e.dataTransfer.effectAllowed='move';}} onDragEnd={()=>setDrag(null)} onClick={()=>void openTask(t)} key={t.id}><span className="task-type">{t.type==='bug'?'Ошибка':t.type==='epic'?'Эпик':t.type==='improvement'?'Улучшение':'Задача'}</span><span className="task-id-label" title={"Полный ID задачи: "+t.id}>#{t.id}</span><strong>{t.title}</strong><p>{t.description||'Без описания'}</p>{t.analysis_state==='needs_clarification'&&<small className="task-warning">Требуются ответы</small>}{t.stage==='merge_queue'&&<small className="task-warning">PR ожидает слияния</small>}<span className="task-footer"><span>Задача</span><span>↗</span></span></button>)}{filtered.filter(t=>t.stage===s.stage).length===0&&<div className="lane-empty">Перетащите задачу сюда</div>}</div></div>)}</div>:<div className="panel table-wrap"><table><thead><tr><th>Задача</th><th>Тип</th><th>Этап</th><th>Создана</th></tr></thead><tbody>{filtered.map(t=><tr key={t.id} onClick={()=>void openTask(t)}><td><b>{t.title}</b><small>#{t.id}</small></td><td>{t.type}</td><td>{stages.find(s=>s.stage===t.stage)?.label}</td><td>{new Date(t.created_at).toLocaleDateString('ru-RU')}</td></tr>)}</tbody></table></div>}</>}
 {section==='docs'&&<div className="docs">
  <aside className="panel docs-list">
   <div className="docs-list-heading"><b>Страницы проекта</b><button type="button" disabled={docBusy} title="Добавить корневую страницу" onClick={()=>void addDoc()}><Plus size={18}/></button></div>
   <div className="doc-tree">{renderDocTree(null)}</div>
   {!docs.length&&<p className="muted">Создай первую страницу документации.</p>}
  </aside>
  <section className="panel docs-reading">
   {selectedDocId&&docs.some(d=>d.id===selectedDocId)?(()=>{
    const doc=docs.find(d=>d.id===selectedDocId)!;
    return <>
     <header className="docs-reading-header">
      <div>{editingDoc?.id===doc.id?
       <input className="docs-title-input" aria-label="Название документа" value={editingDoc.title} onChange={e=>setEditingDoc({...editingDoc,title:e.target.value})}/>:
       <h2>{doc.title}</h2>}
       <small>Обновлено: {new Date(doc.updated_at).toLocaleString('ru-RU')}</small>
      </div>
      <div className="docs-actions">
       {editingDoc?.id===doc.id?<>
        <button className="secondary" type="button" disabled={docBusy} onClick={()=>setEditingDoc(null)}>Отмена</button>
        <button className="primary" type="button" disabled={docBusy||!editingDoc.title.trim()} onClick={()=>void saveDoc()}>Сохранить</button>
       </>:<>
        <button className="secondary docs-icon-button" type="button" title="Редактировать документ" aria-label="Редактировать документ" onClick={()=>setEditingDoc({...doc})}><Pencil size={17}/></button>
        <button className="secondary docs-icon-button docs-delete" type="button" disabled={docBusy} title="Удалить документ" aria-label="Удалить документ" onClick={()=>void deleteDoc(doc)}><Trash2 size={17}/></button>
       </>}
      </div>
     </header>
     {editingDoc?.id===doc.id? <div className="docs-editing">
      <label>Расположение<select value={editingDoc.parent_id||''} onChange={e=>setEditingDoc({...editingDoc,parent_id:e.target.value||null})}>
       <option value="">Корень документации</option>
       {docs.filter(d=>d.id!==doc.id).map(d=><option key={d.id} value={d.id}>{d.title}</option>)}
      </select></label>
      <label>Содержание (Markdown)
       <textarea className="docs-editor-area" rows={22} value={editingDoc.body} onChange={e=>setEditingDoc({...editingDoc,body:e.target.value})} placeholder="Введите текст документа…"/>
      </label>
     </div>:
     <div className="docs-content">{doc.body.trim()?<DocumentMarkdown source={doc.body}/>:<p className="muted">Документ пуст. Нажми карандаш, чтобы добавить содержимое.</p>}</div>}
    </>;
   })():<div className="docs-empty"><BookOpen size={30}/><h3>Документация проекта</h3><p>Выбери страницу слева, чтобы прочитать её содержимое.</p></div>}
  </section>
 </div>}
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
  </div>
  <label style={{display:'flex',flexDirection:'row',alignItems:'center',gap:10}}>
   <input type="checkbox" checked={aiSettings.enabled} onChange={e=>setAiSettings({...aiSettings,enabled:e.target.checked})} style={{width:18,height:18}}/>
   Разрешить ручной запуск AI-задач
  </label>
  <p className="muted">Лимиты использования общие для сервиса и настраиваются в разделе «Настройки сервиса». Здесь выбирается модель для этого проекта.</p>
  <button className="primary" disabled={aiBusy} onClick={()=>void saveAiSettings()}>Сохранить настройки AI</button>
  {aiMessage&&<p>{aiMessage}</p>}
 </section>}
 {section==='rules'&&<section className="panel">
  <h3>Правила проекта</h3>
  <p className="muted">Правила отделены от документации. AI учитывает утверждённые правила при постановке, анализе и разработке. Новые предложения AI требуют твоего подтверждения.</p>
  <form onSubmit={addRule}>
   <label>Добавить правило<textarea rows={3} placeholder="Например: все новые API-эндпоинты должны иметь проверку прав доступа" value={ruleDraft} onChange={e=>setRuleDraft(e.target.value)}/></label>
   <button className="primary" type="submit" disabled={knowledgeBusy||ruleDraft.trim().length<5}>Добавить правило</button>
  </form>
  {rules.map(r=><div className="setting-row" key={r.id}><div><strong>{r.body}</strong><small>{r.origin==='ai_approved'?'Предложено AI, утверждено':'Добавлено вручную'}</small></div><button className="secondary" disabled={knowledgeBusy} onClick={()=>void removeRule(r.id)}>Удалить</button></div>)}
  {ruleSuggestions.length>0&&<><h4>Предложения AI — на утверждение</h4>
   {ruleSuggestions.map(r=><div className="setting-row" key={r.id}><div><strong>{r.body}</strong><small>По задаче #{r.task_id?.slice(0,8)}</small></div>
    <div className="codex-actions"><button className="primary" disabled={knowledgeBusy} onClick={()=>void decideRule(r.id,'approve')}>Принять</button><button className="secondary" disabled={knowledgeBusy} onClick={()=>void decideRule(r.id,'reject')}>Отклонить</button></div>
   </div>)}</>}
 </section>}
 {section==='settings'&&<section className="panel">
  <div className="row-line"><h3>GitHub · Репозиторий проекта</h3><button className="secondary" onClick={()=>{setCred({name:'',provider:'github_token',secret:''});setShowConnection(true);}}><KeyRound size={15}/> Добавить GitHub token</button></div>
  <p className="muted">Подключи репозиторий и токен с правами Contents: Read and write и Pull requests: Read and write. Codex создаёт отдельную ветку и черновик PR после ручного запуска задачи.</p>
  <div className="settings-grid">
   <label>Репозиторий (owner/name)<input value={gitRepository} placeholder="gerlingerstanislav-creator/ai-development-orchestrator" onChange={e=>setGitRepository(e.target.value)} /></label>
   <label>Целевая ветка PR<input value={targetBranch} placeholder={gitLink?.default_branch||'main'} onChange={e=>setTargetBranch(e.target.value)} /></label>
   <label>GitHub token<select value={gitTokenId} onChange={e=>setGitTokenId(e.target.value)}><option value="">Выбери подключение</option>{connections.filter(c=>c.provider==='github_token').map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label>
  </div>
  {connections.every(c=>c.provider!=='github_token')&&<p className="muted">Добавь GitHub token кнопкой выше, затем выбери его здесь.</p>}
  {gitLink&&<p className="muted">Привязан: <strong>{gitLink.repository}</strong> · целевая ветка PR: <strong>{gitLink.target_branch||gitLink.default_branch}</strong></p>}
  {gitMessage&&<p>{gitMessage}</p>}
  <div className="codex-actions">
   <button className="primary" disabled={gitBusy||!gitTokenId||!gitRepository.trim()} onClick={()=>void saveGitLink()}>Проверить и сохранить</button>
   {gitLink&&<button className="secondary" disabled={gitBusy} onClick={()=>void removeGitLink()}>Отвязать репозиторий</button>}
  </div>
 </section>}
 
  {section==='settings'&&<div className="settings-grid"><div className="panel"><h3>Этапы workflow</h3><p className="muted">Пока все перемещения выполняются вручную. Режимы определяют будущие правила исполнения.</p>{stages.map(s=><div key={s.stage} className="setting-row"><div><strong>{s.label}</strong><small>{s.stage}</small></div><select value={s.mode} onChange={e=>void modeChange(s.stage,e.target.value)}><option value="manual">Ручной</option><option value="approval">С подтверждением</option><option value="automatic">Автоматический</option></select></div>)}</div>
</div>}
 </div>}
 </main>
 {selected&&!accountSettings&&!activeTask&&!showTask&&!showProject&&!showConnection&&<>
  {projectChatOpen&&<section className="project-chat" aria-label="Чат проекта">
   <header className="project-chat-heading"><div><strong>AI-помощник проекта</strong><small>{aiSettings.model}</small></div><button onClick={()=>setProjectChatOpen(false)} title="Свернуть чат"><X size={17}/></button></header>
   <div ref={projectThreadRef} className="assistant-thread" role="log" aria-live="polite">
    {projectMessages.length===0&&<p className="assistant-hint">Напиши, например: «Создай задачу на добавление поиска по документации».</p>}
    {projectMessages.map(m=><div className={'assistant-bubble '+(m.role==='user'?'mine':'bot')} key={m.id}>
      <span className="assistant-author">{m.role==='user'?'Вы':'AI'}</span>
      <div>{m.body}</div>
      {m.created_task_id&&<button className="textbtn" onClick={()=>{const t=tasks.find(t=>t.id===m.created_task_id);if(t)void openTask(t);}}>Открыть созданную задачу</button>}
      {m.created_document_id&&<button className="textbtn" onClick={()=>{setSection('docs');setSelectedDocId(m.created_document_id||null);setEditingDoc(null);setProjectChatOpen(false);}}>Открыть документ</button>}
    </div>)}
    {projectChatBusy&&<p className="assistant-hint">Codex готовит ответ…</p>}
   </div>
   <form className="assistant-composer" onSubmit={sendProjectMessage}>
    <textarea ref={projectInputRef} rows={2} value={projectInput} onChange={e=>setProjectInput(e.target.value)} placeholder="Сообщение, задача или документ… (Shift+Enter — новая строка)" aria-label="Сообщение AI-помощнику" onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}/>
    <button className="primary assistant-send-icon" title="Отправить сообщение" aria-label="Отправить сообщение" disabled={projectChatBusy||!projectInput.trim()||!aiSettings.enabled} type="submit"><Send size={17}/></button>
   </form>
   {!aiSettings.enabled&&<p className="assistant-disabled">Включи AI в настройках проекта.</p>}
  </section>}
  <button className="chat-fab" onClick={()=>setProjectChatOpen(open=>!open)} title={projectChatOpen?'Закрыть чат':'Открыть AI-чат'} aria-label={projectChatOpen?'Закрыть чат':'Открыть AI-чат'}>
   {projectChatOpen?<X size={22}/>:<MessageCircle size={22}/>}
  </button>
 </>}
 {showProject&&<div className="overlay" onMouseDown={()=>setShowProject(false)}><form className="dialog" onMouseDown={e=>e.stopPropagation()} onSubmit={createProject}><div className="modal-heading"><h2>Новый проект</h2><button type="button" onClick={()=>setShowProject(false)}><X/></button></div><label>Название<input required value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label><label>Описание<textarea value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></label><footer><button type="button" className="secondary" onClick={()=>setShowProject(false)}>Отмена</button><button className="primary" disabled={busy}>Создать</button></footer></form></div>}
 {showTask&&<div className="overlay" onMouseDown={()=>setShowTask(false)}><form className="dialog" onMouseDown={e=>e.stopPropagation()} onSubmit={createTask}><div className="modal-heading"><h2>Новая задача</h2><button type="button" onClick={()=>setShowTask(false)}><X/></button></div><label>Название<input required value={form.title} onChange={e=>setForm({...form,title:e.target.value})}/></label><label>Тип<select value={form.type} onChange={e=>setForm({...form,type:e.target.value})}><option value="task">Задача</option><option value="bug">Ошибка</option><option value="improvement">Улучшение</option><option value="epic">Эпик</option></select></label><label>Родительская задача<select value={form.parent_id} onChange={e=>setForm({...form,parent_id:e.target.value})}><option value="">Нет</option>{tasks.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></label><label>Описание<textarea rows={5} value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></label><footer><button type="button" className="secondary" onClick={()=>setShowTask(false)}>Отмена</button><button className="primary" disabled={busy}>Создать задачу</button></footer></form></div>}
 {activeTask&&<div className="overlay" onMouseDown={()=>{if(!editingField)setActiveTask(null);}}>
  <div className="dialog task-dialog task-dialog-wide" onMouseDown={e=>e.stopPropagation()}>
   <div className="task-modal-top">
    <div className="task-modal-heading">
     <span className="eyebrow">ЗАДАЧА #{activeTask.id} · {stages.find(s=>s.stage===activeTask.stage)?.label||activeTask.stage}</span>
     <div className="task-editable task-title-editable">
      {editingField==='title'?
       <input autoFocus value={activeTask.title} onChange={e=>setActiveTask({...activeTask,title:e.target.value})}
        onBlur={e=>void autoSaveField('title',e.currentTarget.value)}
        onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();e.currentTarget.blur();}if(e.key==='Escape'){setEditingField(null);}}}/>:
       <><h2>{activeTask.title}</h2><button className="pencil" title="Изменить название" onClick={()=>setEditingField('title')}><Pencil size={15}/></button></>}
     </div>
    </div>
    <div className="task-modal-actions">
     {activeTask.stage==='analysis'&&<button className="primary" disabled={taskChatBusy||!aiSettings.enabled||!gitLink||activeTask.analysis_state!=='ready_for_development'} onClick={()=>void approveDevelopment()}>Отправить в разработку</button>}
     {activeTask.stage==='analysis'&&<button className="secondary" disabled={taskChatBusy||!aiSettings.enabled} onClick={()=>void executeTask()}>Повторить анализ</button>}
     
     {activeTask.stage==='development'&&<button className="primary" disabled={aiBusy||aiRuns.some(r=>r.task_id===activeTask.id&&['running','queued'].includes(r.status))} onClick={()=>void runAiTask()}>Запустить разработку</button>}
     {activeTask.stage==='merge_queue'&&<button className="primary" disabled={mergeBusy} onClick={()=>void mergeTask(activeTask)}>Слить PR</button>}
     {activeTask.stage==='documentation'&&<button className="primary" disabled={knowledgeBusy} onClick={()=>void updateDocumentation()}>Обновить документацию</button>}
     {savingField&&<span className="muted">Сохранение…</span>}
     <button className="task-close" onClick={()=>setActiveTask(null)} title="Закрыть задачу"><X size={20}/></button>
    </div>
   </div>
   <div className="task-dialog-columns">
    <section className="task-details">
     <div className="task-editable task-description-editable">
      <div className="task-field-label">Описание / техническое задание</div>
      {editingField==='description'?
       <textarea autoFocus rows={17} value={activeTask.description} onChange={e=>setActiveTask({...activeTask,description:e.target.value})}
        onBlur={e=>void autoSaveField('description',e.currentTarget.value)}/>:
       <><div className="task-readonly">{activeTask.description||'Описание пока пустое'}</div>
        <button className="pencil" title="Изменить описание" onClick={()=>setEditingField('description')}><Pencil size={15}/></button></>}
     </div>
     <div className="task-metadata">
      <span>Этап: <strong>{stages.find(x=>x.stage===activeTask.stage)?.label||activeTask.stage}</strong></span>
      <span>Модель: <strong>{aiSettings.model}</strong></span>
     </div>
     {activeTask.stage==='analysis'&&<div className="task-questions">
      <strong>{activeTask.analysis_state==='needs_clarification'?'Нужно уточнить требования':activeTask.analysis_state==='ready_for_development'?'Анализ завершён':'Требуется анализ'}</strong>
      {!!activeTask.clarification_questions?.length&&<ol>{activeTask.clarification_questions.map((q,i)=><li key={i}>{q}</li>)}</ol>}
      {activeTask.analysis_state==='ready_for_development'&&<p className="muted">Блокирующих вопросов нет. Можно отправлять в разработку.</p>}
     </div>}
     <div className="task-dependency">
      <label>Зависит от задачи
       <select value={activeTask.depends_on_task_id||''} disabled={!!activeTask.git_branch||['merge_queue','documentation','done'].includes(activeTask.stage)}
        onChange={e=>void setDependency(activeTask,e.target.value||null)}>
        <option value="">Нет кодовой зависимости</option>
        {tasks.filter(t=>t.id!==activeTask.id).map(t=><option key={t.id} value={t.id}>{t.title} · {stages.find(x=>x.stage===t.stage)?.label||t.stage}</option>)}
       </select>
      </label>
      {activeTask.depends_on_task_id&&<p className="muted">После подготовки PR родительской задачи разработка начнётся от её ветки. Если родитель уже слит — от целевой ветки проекта.</p>}
     </div>
     {!!activeTask.related_task_ids?.length&&<p className="muted">Связанные задачи: {activeTask.related_task_ids.map(id=>tasks.find(t=>t.id===id)?.title||id.slice(0,8)).join(', ')}</p>}
     {activeTask.pr_base_branch&&<div className="task-git-ref"><span>База PR</span><code>{activeTask.pr_base_branch}</code></div>}
     {activeTask.git_branch&&<div className="task-git-ref"><span>Ветка</span><code>{activeTask.git_branch}</code></div>}
     {activeTask.pr_url&&<div className="task-git-ref"><span>Pull Request</span><a href={activeTask.pr_url} target="_blank" rel="noreferrer">Открыть PR в GitHub</a></div>}
     {activeTask.stage==='documentation'&&<p className="muted">PR уже слит. Задача ожидает обновления проектной документации.</p>}
    </section>
    <aside className="task-conversation">
     <header><MessageCircle size={17}/><strong>Переписка и ход работы</strong><small>{taskChatBusy?'AI отвечает…':aiRuns.some(r=>r.task_id===activeTask.id&&r.status==='running')?'Выполняется':'История сохранена'}</small></header>
     <div ref={taskThreadRef} className="assistant-thread" role="log" aria-live="polite">
      {timeline(activeTask.id).length===0&&<p className="assistant-hint">Здесь будут вопросы, ответы AI, действия и ход разработки.</p>}
      {timeline(activeTask.id).map(item=><div key={item.id} className={'assistant-bubble '+(item.kind==='user'?'mine':item.kind==='event'?'activity-event':item.kind==='run'?'activity-run':'bot')}>
       <span className="assistant-author">{item.kind==='user'?'Вы':item.kind==='assistant'?'AI':item.kind==='run'?item.title:item.title} · {new Date(item.time).toLocaleString('ru-RU')}</span>
       <div>{item.text}</div>
       {item.link&&<a href={item.link} target="_blank" rel="noreferrer">Открыть Pull Request</a>}
      </div>)}
      {aiRuns.filter(r=>r.task_id===activeTask.id&&['running','queued'].includes(r.status)).map(r=><div className="task-execution-live" key={'live-'+r.id}>
   <LoaderCircle size={16}/>
   <div><strong>{r.status==='queued'?'Ожидает свободного AI-исполнителя':'Разработка выполняется'}</strong>
    <p>{r.message||'Ожидание ответа Codex'}</p>
    <small>{r.status==='queued'?'В очереди: ': 'Выполняется: '}{Math.max(0,Math.floor((elapsedNow-new Date(r.started_at||r.created_at||Date.now()).getTime())/60000))} мин.</small>
   </div>
  </div>)}
    {taskChatBusy&&<p className="assistant-hint"><LoaderCircle size={15}/> Codex отвечает…</p>}
      {taskFeedback&&<p className="task-feedback">{taskFeedback}</p>}
     </div>
     <form className="assistant-composer" onSubmit={sendTaskMessage}>
      <textarea rows={3} value={taskInput} onChange={e=>setTaskInput(e.target.value)}
       onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}
       placeholder="Задай вопрос или ответь на все уточнения… (Shift+Enter — новая строка)" aria-label="Сообщение в чат задачи"/>
      <button className="primary" type="submit" disabled={taskChatBusy||!taskInput.trim()||!aiSettings.enabled}><Send size={15}/> Отправить</button>
     </form>
    </aside>
   </div>
   <div className="task-workflow" aria-label="Этапы выполнения">
    {stages.map((stage,i)=><React.Fragment key={stage.stage}>
     {i>0&&<button className="workflow-arrow" disabled={!canAdvance(activeTask,stages[i-1].stage,stage.stage)}
       title={canAdvance(activeTask,stages[i-1].stage,stage.stage)?'Перейти: '+stage.label:'Для этого перехода нужны выполненные условия предыдущего этапа'}
       onClick={()=>void advanceTask(activeTask,stages[i-1].stage,stage.stage)}><ArrowRight size={18}/></button>}
     <div className={'workflow-step '+(stage.stage===activeTask.stage?'current':stages.findIndex(x=>x.stage===stage.stage)<stages.findIndex(x=>x.stage===activeTask.stage)?'passed':'pending')}>
      {stage.stage===activeTask.stage?(activeTask.stage==='done'?<CheckCircle2 size={16}/>:<LoaderCircle size={16}/>):stages.findIndex(x=>x.stage===stage.stage)<stages.findIndex(x=>x.stage===activeTask.stage)?<CheckCircle2 size={16}/>:<Clock3 size={16}/>}
      <span>{stage.label}</span>
     </div>
    </React.Fragment>)}
   </div>
  </div>
 </div>}
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
 {error&&<div className="error-toast" role="alert"><span>{error}</span><button type="button" title="Закрыть уведомление" aria-label="Закрыть уведомление" onClick={()=>setError('')}><X size={17}/></button></div>}
 </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
