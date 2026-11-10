import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ArrowLeft,ArrowRight,BookOpen,ChevronDown,Columns3,FileText,KeyRound,LayoutGrid,List,Plus,Settings2,Trash2,MessageCircle,Send,Pencil,CheckCircle2,LoaderCircle,Paperclip,Clock3,ArrowRightCircle,ChevronRight,RotateCcw,X} from 'lucide-react';
import './style.css';
import {QaPanel} from './QaPanel.js';
import {KnowledgeInstructions} from './KnowledgeInstructions.js';

type Project={id:string,name:string,description:string};
type Task={awaits_product_owner?:boolean;spec_version?:number;spec_review_status?:'current'|'pending'|'needs_approval'|'rejected';spec_review_note?:string;test_feedback?:string;test_attempts?:number;id:string,display_number:number,title:string,description:string,type:string,stage:string,parent_id:string|null,created_at:string,analysis_state?:string,clarification_questions?:string[],related_task_ids?:string[],depends_on_task_id?:string|null,git_branch?:string|null,pr_url?:string|null,pr_base_branch?:string|null};
type Stage={stage:string,label:string,mode:'automatic'|'approval'|'manual',position:number,agent_name:string,agent_instructions:string};
const mentionOptions=[{alias:'Analyst',stage:'analysis'},{alias:'QA',stage:'testing'}] as const;
function mentionMatches(value:string,stages:Stage[]){
 const tail=/(?:^|\s)@([a-z]*)$/i.exec(value);
 if(!tail)return [];
 return mentionOptions.filter(item=>item.alias.toLowerCase().startsWith(tail[1].toLowerCase())&&stages.some(s=>s.stage===item.stage));
}
function addMention(value:string,alias:string){return value.replace(/@([a-z]*)$/i,'@'+alias+' ');}
function addressedAgent(value:string){return /^\\s*@(Analyst|QA)(?=\\s|[:,.!?]|$)/i.exec(value)?.[1]?.toLowerCase()==='qa'?'QA':/^\\s*@Analyst(?=\\s|[:,.!?]|$)/i.test(value)?'Analyst':null;}

type RequirementReview={id:string;classification:string;status:string;summary:string;proposed_description:string;questions:string[];spec_version:number;commit_sha:string;created_at:string};
type RequirementHistory={version:number;description:string;origin:string;reason:string;created_at:string};
type RequirementInfo={task:{id:string;title:string;description:string;spec_version:number;spec_review_status:string;spec_review_note:string};reviews:RequirementReview[];versions:RequirementHistory[];runs:Array<{id:string;status:string;message:string}>};
type TaskProcessEvent={id:string;process_kind:string;stage:string;detail:string;level:string;created_at:string};
type AgentTaskNote={id:string;author_stage:string;author_name:string;target_stage:string;kind:'handoff'|'observation'|'question'|'risk'|'resolution';body:string;source_kind:string;status:string;answer?:string|null;answered_at?:string|null;created_at:string};
type CancelPreview={task:{id:string;title:string;display_number:number;stage:string};blocked:string[];stats:{documents:number;qa_plans:number;qa_cases:number;qa_flows:number};confirmation:string;github_cleanup_required?:boolean;warnings?:string[];github_note:string};
type AgentRun={id:string;kind:'analysis'|'development'|'testing'|'qa_design'|'documentation';status:'queued'|'running'|'completed'|'failed';summary:string;link:string|null;created_at:string;completed_at:string|null};
const agentRunLabels={
 analysis:{name:'Аналитик',active:'Ведётся анализ'},
 development:{name:'Разработчик',active:'Ведётся разработка'},
 testing:{name:'Тестировщик',active:'Ведётся тестирование'},
 qa_design:{name:'Тестировщик',active:'Готовятся тестовые сценарии'},
 documentation:{name:'Документатор',active:'Обновляется документация'}
};
type TaskActivityResponse={events:Array<{id:string;event:string;detail:string;created_at:string}>;processEvents:TaskProcessEvent[];owner:null|{owner_id:string;kind:'development'|'testing';workflow_id:string;state:string;started_at:string};tests:TestRun[];notes:AgentTaskNote[];agentRuns?:AgentRun[]};
type KanbanGroupKey='analytics'|'development'|'testing'|'merging'|'results'|'other';
type KanbanLane=Pick<Stage,'stage'|'label'>;
type KanbanGroup={key:KanbanGroupKey;title:string;stages:KanbanLane[]};
const productOwnerLane:KanbanLane={stage:'product_owner_questions',label:'Вопросы к ПО'};
const boardLaneFor=(task:Task)=>task.awaits_product_owner?productOwnerLane.stage:task.stage;
const stageGroupDefinitions:{key:KanbanGroupKey;title:string;ids:string[]}[]=[
 {key:'analytics',title:'Аналитика',ids:['backlog','analysis']},
 {key:'development',title:'Разработка',ids:['development','testing','merge_queue']},
 {key:'results',title:'Итоги',ids:['documentation','done']}
];

type Doc={id:string,title:string,body:string,parent_id:string|null,updated_at:string,document_kind:'technical'|'functional',implementation_status:'unverified'|'planned'|'partial'|'implemented',implementation_evidence:string;system_key?:'spec'|'architecture'|'operations'|'design'|'research'|null;source_refs?:Array<{path:string;heading:string;url:string|null}>};
type Connection={id:string,name:string,provider:string};
type GitLink={repository:string,default_branch:string,target_branch?:string,connection_id:string,connection_name?:string};
type AiSettings={model:'gpt-6-luna'|'gpt-6-sol'|'gpt-6.1-sol';reasoning:'low'|'medium';enabled:boolean};
type CodexRateWindow={usedPercent:number;windowDurationMins:number|null;resetsAt:number|null};
type CodexRateBucket={id:string;name:string|null;primary:CodexRateWindow|null;secondary:CodexRateWindow|null;planType:string|null;reachedType:string|null};
type CodexRateLimits={windows:CodexRateBucket[];resetCredits:number|null;checkedAt:string};
type TokenTotals={input_tokens:string;cached_input_tokens:string;output_tokens:string;requests:number};
type TokenUsageResponse={totals:TokenTotals;latest:Array<{operation:string;model:string;input_tokens:string;cached_input_tokens:string;output_tokens:string;created_at:string}>};
type AiRun={id:string;task_id:string;model:string;status:string;branch?:string|null;pr_url?:string|null;message?:string;created_at?:string;started_at?:string|null};
type QaWaiverInfo={run_id:string|null;assessment:{eligible:boolean;blockers:string[];passed:number;total:number;summary:string;capabilities:string;commit:string;spec_version:number|null;checks:Array<{name?:string;result?:string;details?:string}>;unverified:Array<{id:string;title:string;priority:string;reason:string;evidence:string}>};approval:null|{id:string;test_run_id:string;justification:string;created_at:string}};
type TestRun={id:string;task_id:string;cycle_id:string;attempt:number;status:string;message:string;verdict?:'passed'|'failed'|'blocked'|null;report?:{summary?:string;findings?:Array<{severity:string;description:string;steps?:string;expected?:string;actual?:string}>;checks?:Array<{name:string;result:string;details:string}>;caseResults?:Array<{case_id:string;result:string;evidence:string}>;commit?:string}|null;created_at:string;completed_at?:string|null};
type BackgroundProcess={id:string;kind:'development'|'document_import'|'merge'|'testing'|'analysis';projectId:string;projectName:string;taskId?:string;title:string;detail:string;status:'queued'|'running';createdAt:string;url:string};
type BackgroundProcessResponse={count:number;processes:BackgroundProcess[];checkedAt:string};
type ProjectProcess={id:string;kind:'document_import'|'development'|'merge'|'testing'|'analysis';title:string;status:string;detail:string;createdAt:string;updatedAt?:string|null;sourceUrl?:string|null;requestText?:string|null;sourceFileCount?:number|null;savedDocuments?:number;hasDraft?:boolean;progress?:{completed:number;total:number|null};topicProgress?:{completed:number;total:number};result?:{message?:string;created_document_id?:string;generated_documents?:number;prUrl?:string;results?:unknown[];verdict?:string;findings?:Array<{severity:string;description:string;steps?:string;expected?:string;actual?:string}>;checks?:Array<{name:string;result:string;details:string}>;commit?:string}|null;taskId?:string};
type DocumentationQuestion={id:string;topic_key:string;question:string;status:'open'|'answered';answer:string|null;document_id:string;document_title:string;created_at:string};
type DocumentationProposal={id:string;job_id:string;topic_key:string;document_id:string;title:string;proposed_body:string;status:string;document_title:string};
type ProjectProcessEvent={id:string;stage:string;detail:string;level:string;created_at:string};

type ProjectRule={id:string,body:string,origin:string,created_at:string};
type RuleSuggestion={id:string,body:string,task_id:string};
type DocVersion={id:string,task_ids:string[],created_at:string};
type ManagerMessage={id:string;role:'user'|'manager';body:string;status:'queued'|'processing'|'completed'|'failed';reply_to?:string|null;created_at:string};
type ManagerRequest={id:string;kind:'qa_visual'|'requirements'|'question'|'analysis_clarifications';source_id:string;payload:any;status:'open'|'waiting';created_at:string;decision:string|null};
type ManagerSnapshot={messages:ManagerMessage[];requests:ManagerRequest[];task:{id:string;title:string;stage:string;description?:string;analysis_state?:Task['analysis_state'];clarification_questions?:string[];spec_version?:number;spec_review_status?:Task['spec_review_status']};owner:any;latestTest:any;internalNotes:AgentTaskNote[]};
type AssistantMessage={id:string;role:'user'|'assistant';body:string;created_task_id?:string|null;created_document_id?:string|null;created_at?:string;pending?:boolean;failed?:boolean};
type AssistantResponse={message:string;created_task_id?:string|null;created_document_id?:string|null;summary?:string|null;questions?:string[];import_job_id?:string};
type ImportJob={id:string;status:'running'|'completed'|'failed';message:string;result:AssistantResponse|null};
type ActivityItem={id:string;kind:'user'|'assistant'|'event'|'run'|'note';text:string;time:string;title?:string;link?:string;status?:string;pending?:boolean;failed?:boolean};
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

class AuthExpiredError extends Error {}
let refreshInFlight:Promise<string|null>|null=null;
function renewAccessToken():Promise<string|null>{
 if(refreshInFlight)return refreshInFlight;
 refreshInFlight=(async()=>{
  try{
   const response=await fetch('/api/auth/refresh',{method:'POST',credentials:'same-origin'});
   if(!response.ok)return null;
   const data=await response.json() as {token?:string};
   if(!data.token)return null;
   sessionStorage.setItem(key,data.token);
   return data.token;
  }catch{return null;}
 })().finally(()=>{refreshInFlight=null;});
 return refreshInFlight;
}
async function api<T=any>(path:string,options:RequestInit={}):Promise<T>{
 const send=(token:string|null)=>fetch('/api'+path,{...options,credentials:'same-origin',headers:{...(options.body!=null?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...options.headers}});
 let response=await send(sessionStorage.getItem(key));
 if(response.status===401 && path!=='/login' && !path.startsWith('/auth/')){
  const nextToken=await renewAccessToken();
  if(nextToken)response=await send(nextToken);
  else{
   sessionStorage.removeItem(key);
   window.dispatchEvent(new Event('ado-session-expired'));
   throw new AuthExpiredError('Сессия завершена');
  }
 }
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(data.error||'Ошибка запроса');
 return data as T;
}
type ProjectSection='overview'|'tasks'|'docs'|'qa'|'processes'|'rules'|'settings';
type AppRoute={kind:'projects'|'account'|'project'|'not-found';projectId?:string;section?:ProjectSection;taskId?:string;docId?:string};
const uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function parseAppRoute(pathname:string):AppRoute{
 const parts=pathname.split('/').filter(Boolean);
 if(parts.length===0||parts.length===1&&parts[0]==='projects')return {kind:'projects'};
 if(parts.length===2&&parts[0]==='account'&&parts[1]==='settings')return {kind:'account'};
 if(parts[0]==='projects'&&parts.length>=2&&uuidPattern.test(parts[1])){
  const projectId=parts[1];
  if(parts.length===2)return {kind:'project',projectId,section:'tasks'};
  if(parts.length===3&&['overview','tasks','docs','qa','processes','rules','settings'].includes(parts[2]))
   return {kind:'project',projectId,section:parts[2] as ProjectSection};
  if(parts.length===4&&parts[2]==='tasks'&&uuidPattern.test(parts[3]))
   return {kind:'project',projectId,section:'tasks',taskId:parts[3]};
  if(parts.length===4&&parts[2]==='docs'&&uuidPattern.test(parts[3]))
   return {kind:'project',projectId,section:'docs',docId:parts[3]};
 }
 return {kind:'not-found'};
}
function projectUrl(projectId:string,section:ProjectSection='tasks'){
 return '/projects/'+encodeURIComponent(projectId)+'/'+section;
}
function App(){
 const [token,setToken]=useState(sessionStorage.getItem(key)||'');
 useEffect(()=>{
  let active=true;
  if(!sessionStorage.getItem(key))void renewAccessToken().then(fresh=>{if(active&&fresh)setToken(fresh);});
  const expired=()=>{setToken('');setProjectsLoaded(false);setProjects([]);setSelected(null);};
  window.addEventListener('ado-session-expired',expired);
  return()=>{active=false;window.removeEventListener('ado-session-expired',expired);};
 },[]);
 const [login,setLogin]=useState(''); const [password,setPassword]=useState('');
 const [route,setRoute]=useState<AppRoute>(()=>parseAppRoute(window.location.pathname));
 const [projectsLoaded,setProjectsLoaded]=useState(false);
 const [loadedProjectId,setLoadedProjectId]=useState<string|null>(null);
 function navigate(path:string,replace=false){
  const target=new URL(path,window.location.origin);
  if(target.pathname===window.location.pathname&&target.search===window.location.search)return;
  if(replace)window.history.replaceState(null,'',target.pathname+target.search);
  else window.history.pushState(null,'',target.pathname+target.search);
  setRoute(parseAppRoute(target.pathname));
 }
 function followLink(e:React.MouseEvent<HTMLAnchorElement>,path:string){
  if(e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
  e.preventDefault();navigate(path);
 }
  useEffect(()=>{
  if(window.location.pathname==='/' || window.location.pathname==='/projects/'){
   window.history.replaceState(null,'','/projects');
  }
  const onPop=()=>setRoute(parseAppRoute(window.location.pathname));
  window.addEventListener('popstate',onPop);
  return()=>window.removeEventListener('popstate',onPop);
 },[]);
  const [projects,setProjects]=useState<Project[]>([]);const [selected,setSelected]=useState<Project|null>(null);
 const [section,setSection]=useState<ProjectSection>('tasks');
 const [workflowModal,setWorkflowModal]=useState<Stage|null>(null);
 const [workflowEditing,setWorkflowEditing]=useState<'agent'|'mode'|'instructions'|null>(null);
 const [workflowSaving,setWorkflowSaving]=useState(false);
 const [accountSettings,setAccountSettings]=useState(false);
 const [projectMenuOpen,setProjectMenuOpen]=useState(false);
 const [rateLimits,setRateLimits]=useState<CodexRateLimits|null>(null);
 const [tokenUsage,setTokenUsage]=useState<TokenUsageResponse|null>(null);
 const [rateLimitsBusy,setRateLimitsBusy]=useState(false);
 const [rateLimitsError,setRateLimitsError]=useState('');
 const [rateLimitsLoading,setRateLimitsLoading]=useState(false);
 const [backgroundProcesses,setBackgroundProcesses]=useState<BackgroundProcess[]>([]);
 const [backgroundProcessMenuOpen,setBackgroundProcessMenuOpen]=useState(false);
 const [backgroundProcessesError,setBackgroundProcessesError]=useState('');
 const processDropdownRef=useRef<HTMLDivElement|null>(null);
 useEffect(()=>{
  if(!token){setBackgroundProcesses([]);setBackgroundProcessMenuOpen(false);return;}
  let active=true;
  const refresh=async()=>{
   try{
    const result=await api<BackgroundProcessResponse>('/background-processes');
    if(active){setBackgroundProcesses(result.processes);setBackgroundProcessesError('');}
   }catch(e){
    if(active)setBackgroundProcessesError(e instanceof Error?e.message:'Не удалось обновить процессы');
   }
  };
  void refresh();
  const timer=window.setInterval(()=>{if(!document.hidden)void refresh();},8000);
  const onVisible=()=>{if(!document.hidden)void refresh();};
  document.addEventListener('visibilitychange',onVisible);
  return()=>{active=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',onVisible);};
 },[token]);
 useEffect(()=>{
  if(!backgroundProcessMenuOpen)return;
  const onOutside=(event:MouseEvent)=>{if(processDropdownRef.current&&!processDropdownRef.current.contains(event.target as Node))setBackgroundProcessMenuOpen(false);};
  document.addEventListener('mousedown',onOutside);
  return()=>{document.removeEventListener('mousedown',onOutside);};
 },[backgroundProcessMenuOpen]);

 const [tasks,setTasks]=useState<Task[]>([]);const [stages,setStages]=useState<Stage[]>([]);
 const [projectProcesses,setProjectProcesses]=useState<ProjectProcess[]>([]);
 const [selectedProcessId,setSelectedProcessId]=useState<string|null>(null);
 useEffect(()=>{
  const id=new URLSearchParams(window.location.search).get('process');
  if(id&&uuidPattern.test(id))setSelectedProcessId(id);
 },[route]);

 const [processEvents,setProcessEvents]=useState<ProjectProcessEvent[]>([]);
 const [processFilter,setProcessFilter]=useState<'all'|'active'|'failed'|'completed'>('all');
 const [processActionBusy,setProcessActionBusy]=useState(false);
 const [processInstruction,setProcessInstruction]=useState('');

 const [docs,setDocs]=useState<Doc[]>([]);
 const [docSearch,setDocSearch]=useState('');
 const [knowledgeMeta,setKnowledgeMeta]=useState<{status:'approved'|'draft'|'review'|'obsolete';summary:string;tags:string[]} | null>(null);
 const [knowledgeRelated,setKnowledgeRelated]=useState<Array<{id:string;relation:string;related_document_id:string;title:string}>>([]);
 const [knowledgeTarget,setKnowledgeTarget]=useState('');
 const [knowledgeRelation,setKnowledgeRelation]=useState('related_to');
 const [knowledgeVersions,setKnowledgeVersions]=useState<Array<{id:string;created_at:string;excerpt:string}>>([]);
 const [rules,setRules]=useState<ProjectRule[]>([]);const [ruleSuggestions,setRuleSuggestions]=useState<RuleSuggestion[]>([]);
 const [ruleDraft,setRuleDraft]=useState('');const [knowledgeBusy,setKnowledgeBusy]=useState(false);
 const [documentVersions,setDocumentVersions]=useState<DocVersion[]>([]);const [documentationNotice,setDocumentationNotice]=useState('');
const [collapsedDocs,setCollapsedDocs]=useState<string[]>([]);const [connections,setConnections]=useState<Connection[]>([]);
 const [projectConnections,setProjectConnections]=useState<Connection[]>([]);
 const [aiSettings,setAiSettings]=useState<AiSettings>({model:'gpt-6-luna',reasoning:'low',enabled:false});
 const [aiBusy,setAiBusy]=useState(false);const [aiRuns,setAiRuns]=useState<AiRun[]>([]);const [testRuns,setTestRuns]=useState<TestRun[]>([]);const [aiMessage,setAiMessage]=useState('');
 const [targetBranch,setTargetBranch]=useState('');const [mergeBusy,setMergeBusy]=useState(false);const [mergeReport,setMergeReport]=useState('');
 const [gitLink,setGitLink]=useState<GitLink|null>(null);const [gitRepository,setGitRepository]=useState('');const [gitTokenId,setGitTokenId]=useState('');const [gitBusy,setGitBusy]=useState(false);const [gitMessage,setGitMessage]=useState('');
 const [view,setView]=useState<'board'|'list'>('board');
 const [expandedGroups,setExpandedGroups]=useState<KanbanGroupKey[]>(()=>{
  const all:KanbanGroupKey[]=['analytics','development','results','other'];
  try{
   // New layout starts fully expanded, while retaining subsequent user choices.
   const saved=localStorage.getItem('ado-kanban-groups-expanded-v3');
   if(!saved)return all;
   const value:unknown=JSON.parse(saved);
   return Array.isArray(value)?value.filter((id):id is KanbanGroupKey=>all.includes(id as KanbanGroupKey)):all;
  }catch{return all;}
 });
 useEffect(()=>{localStorage.setItem('ado-kanban-groups-expanded-v3',JSON.stringify(expandedGroups));},[expandedGroups]);
 function toggleKanbanGroup(group:KanbanGroupKey){
  setExpandedGroups(old=>old.includes(group)?old.filter(x=>x!==group):[...old,group]);
 }

 const [activeTask,setActiveTask]=useState<Task|null>(null);
 const [qaWaiver,setQaWaiver]=useState<QaWaiverInfo|null>(null);
 const [qaWaiverBusy,setQaWaiverBusy]=useState(false);
 const [qaResultBusy,setQaResultBusy]=useState(false);
 const [qaWaiverReason,setQaWaiverReason]=useState('');
 const [qaWaiverAcknowledged,setQaWaiverAcknowledged]=useState(false);
 const [requirements,setRequirements]=useState<RequirementInfo|null>(null);
 const [requirementsBusy,setRequirementsBusy]=useState(false);
 const [taskAgentNotes,setTaskAgentNotes]=useState<AgentTaskNote[]>([]);
 const [noteBusy,setNoteBusy]=useState(false);
 const [noteDraft,setNoteDraft]=useState('');
 const [noteTarget,setNoteTarget]=useState('all');
 const [answerNoteId,setAnswerNoteId]=useState<string|null>(null);
 const [answerText,setAnswerText]=useState('');
 const [cancelPreview,setCancelPreview]=useState<CancelPreview|null>(null);
 const [cancelPhrase,setCancelPhrase]=useState('');
 const [cancelBusy,setCancelBusy]=useState(false);
 const [cancelError,setCancelError]=useState('');
 const [elapsedNow,setElapsedNow]=useState(Date.now());
 const [editingField,setEditingField]=useState<'title'|'description'|null>(null);
 const [savingField,setSavingField]=useState(false);const [taskFeedback,setTaskFeedback]=useState('');
 const [selectedDocId,setSelectedDocId]=useState<string|null>(null);
 const [editingDoc,setEditingDoc]=useState<Doc|null>(null);
 const [docBusy,setDocBusy]=useState(false);
 const [showProject,setShowProject]=useState(false);const [showTask,setShowTask]=useState(false);const [showConnection,setShowConnection]=useState(false);
 // Escape dismisses only the topmost UI layer. Leave in-progress operations intact.
 useEffect(()=>{
  const onEscape=(event:KeyboardEvent)=>{
   if(event.key!=='Escape'||event.defaultPrevented||event.isComposing)return;
   if(workflowModal){
    if(workflowEditing){setWorkflowEditing(null);}
    else if(!workflowSaving){setWorkflowModal(null);}
   }else if(showConnection){setShowConnection(false);}
   else if(showTask){setShowTask(false);}
   else if(showProject){setShowProject(false);}
   else if(activeTask){
    if(cancelPreview||cancelError){if(!cancelBusy){setCancelPreview(null);setCancelError('');}}
    else if(editingField){setEditingField(null);}
    else if(selected){navigate(projectUrl(selected.id,'tasks'));}
   }else if(backgroundProcessMenuOpen){setBackgroundProcessMenuOpen(false);}
   else if(projectMenuOpen){setProjectMenuOpen(false);}
   else{return;}
   event.preventDefault();
  };
  document.addEventListener('keydown',onEscape);
  return()=>document.removeEventListener('keydown',onEscape);
 },[workflowModal,workflowEditing,workflowSaving,showConnection,showTask,showProject,activeTask,editingField,selected,backgroundProcessMenuOpen,projectMenuOpen,cancelPreview,cancelError,cancelBusy]);
 useEffect(()=>{
  const modalOpen=!!(activeTask||showProject||showTask||showConnection);
  if(!modalOpen)return;
  const previous=document.body.style.overflow;
  document.body.style.overflow='hidden';
  return()=>{document.body.style.overflow=previous;};
 },[activeTask,showProject,showTask,showConnection]);
 useEffect(()=>{
  if(!aiRuns.some(r=>r.status==='running'||r.status==='queued')&&!testRuns.some(r=>r.status==='running'||r.status==='queued'))return;
  const interval=window.setInterval(()=>setElapsedNow(Date.now()),1000);
  return()=>window.clearInterval(interval);
 },[aiRuns,testRuns]);


 const [error,setError]=useState('');
 useEffect(()=>{if(!error)return;const timeout=window.setTimeout(()=>setError(''),9500);return()=>window.clearTimeout(timeout);},[error]);
 const [busy,setBusy]=useState(false);const [search,setSearch]=useState('');
 const [form,setForm]=useState({name:'',description:'',title:'',type:'task',parent_id:''});
 const [cred,setCred]=useState({name:'',provider:'openai_api',secret:''});
 const [codex,setCodex]=useState<CodexState|null>(null);const [codexBusy,setCodexBusy]=useState(false);const [codexTest,setCodexTest]=useState('');
 const [events,setEvents]=useState<{id:string;event:string;detail:string;created_at:string}[]>([]);
 const [taskProcessEvents,setTaskProcessEvents]=useState<TaskProcessEvent[]>([]);
 const [taskTestRuns,setTaskTestRuns]=useState<TestRun[]>([]);
 const [taskAgentRuns,setTaskAgentRuns]=useState<AgentRun[]>([]);
 const [taskOrchestration,setTaskOrchestration]=useState<TaskActivityResponse['owner']>(null);
 const projectThreadRef=useRef<HTMLDivElement|null>(null);const taskThreadRef=useRef<HTMLDivElement|null>(null);
 const projectInputRef=useRef<HTMLTextAreaElement|null>(null);
 const [projectChatOpen,setProjectChatOpen]=useState(false);
 const [projectChatMode,setProjectChatMode]=useState<'project'|'documentation'>('project');
 useEffect(()=>{if(projectChatOpen)projectInputRef.current?.focus();},[projectChatOpen]);
 const [projectMessages,setProjectMessages]=useState<AssistantMessage[]>([]);
 const [projectPendingId,setProjectPendingId]=useState<string|null>(null);
 const [projectInput,setProjectInput]=useState('');const [projectChatBusy,setProjectChatBusy]=useState(false);
 const [projectImportProgress,setProjectImportProgress]=useState('');
 const [docQuestions,setDocQuestions]=useState<DocumentationQuestion[]>([]);
 const [docProposals,setDocProposals]=useState<DocumentationProposal[]>([]);
 const [questionAnswers,setQuestionAnswers]=useState<Record<string,string>>({});
 const [analystFiles,setAnalystFiles]=useState<File[]>([]);
 const [analystDocumentId,setAnalystDocumentId]=useState<string|null>(null);
 const analystFileInput=useRef<HTMLInputElement>(null);
 const chatScope=useRef('');
 chatScope.current=(selected?.id||'')+':'+projectChatMode;

 const [taskMessages,setTaskMessages]=useState<AssistantMessage[]>([]);
 const [taskPendingId,setTaskPendingId]=useState<string|null>(null);
 const [taskInput,setTaskInput]=useState('');const [taskChatBusy,setTaskChatBusy]=useState(false);
 const [managerState,setManagerState]=useState<ManagerSnapshot|null>(null);
 const [managerBusy,setManagerBusy]=useState(false);
 const [managerAnswer,setManagerAnswer]=useState('');
 const [managerFeedback,setManagerFeedback]=useState('');
 const [managerSending,setManagerSending]=useState(false);
 const managerMessages=managerState?.messages;
 const decisions=managerState?.requests.filter(request=>request.status==='open')||[];
 const awaitingAnalysisAnswer=decisions.some(request=>request.kind==='analysis_clarifications');
 const readyForDevelopment=activeTask?.stage==='analysis'&&activeTask.analysis_state==='ready_for_development'
  &&(!activeTask.spec_review_status||activeTask.spec_review_status==='current')&&!decisions.length;
 const deferredQa=managerState?.requests.filter(request=>request.status==='waiting'&&request.kind==='qa_visual')||[];
 const activeAgentRuns=taskAgentRuns.filter(run=>run.status==='running'||run.status==='queued');
 const managerWorking=managerSending||managerMessages?.some(message=>message.role==='user'&&(message.status==='queued'||message.status==='processing'));
 const chatEntries=[...(managerMessages||[]),...taskAgentRuns.filter(run=>run.status==='completed'||run.status==='failed')]
  .sort((left,right)=>{
   const time=(entry:ManagerMessage|AgentRun)=>Date.parse(('completed_at' in entry?entry.completed_at:null)||entry.created_at);
   return time(left)-time(right);
  });

 function timeline(taskId:string):ActivityItem[]{
  return [
   ...taskMessages.map(m=>({id:'msg-'+m.id,kind:m.role,text:m.body,time:m.created_at||new Date().toISOString(),pending:m.pending,failed:m.failed})),
   ...taskAgentNotes.map(note=>({id:'note-'+note.id,kind:'note' as const,title:note.author_name+
    ' → '+(note.target_stage==='all'?'всем участникам':({analysis:'аналитику',development:'разработчику',testing:'тестировщику',merge_queue:'ответственному за слияние',documentation:'документатору'} as Record<string,string>)[note.target_stage]||note.target_stage)+
    ' · '+(note.kind==='question'?'Вопрос':note.kind==='risk'?'Риск':'Рабочий комментарий'),
    text:note.body+(note.answer?'\n\nОтвет: '+note.answer:note.status==='open'?'\n\nОжидает ответа':''),
    time:note.created_at})),
   ...events.map(ev=>({id:'evt-'+ev.id,kind:'event' as const,title:({
    created:'Задача создана',analyzed:'Анализ завершён',stage_changed:'Переход этапа',spec_changed:'Изменение требований',
    requirements_proposed:'Аналитик · требуется согласование',requirements_reviewed:'Аналитик · ТЗ проверено',requirements_approved:'Изменение ТЗ согласовано',
    requirements_rejected:'Изменение ТЗ отклонено',tests_passed:'Тестирование пройдено',
    tests_failed:'Замечания тестировщика',qa_tools_unavailable:'Тестировщик · проверки ограничены средой',
    qa_waiver_approved:'Непроверенные сценарии согласованы',handoff_blocked:'Передача на следующий этап остановлена',
    merged:'PR слит',documentation_updated:'Документация обновлена'
   } as Record<string,string>)[ev.event]||'Событие задачи',text:ev.detail,time:ev.created_at})),
   ...taskProcessEvents.map(ev=>({id:'process-'+ev.id,kind:'event' as const,title:(ev.process_kind==='testing'?'Тестировщик':ev.process_kind==='analysis'?'Аналитик':ev.process_kind==='development'?'Разработчик':'Процесс')+' · '+({
    review_started:'Сверка требований',needs_approval:'Нужно решение',current:'ТЗ актуально',test_design_started:'Генерация тест-кейсов',
    test_design_ready:'QA-план готов',test_design_failed:'Ошибка подготовки QA',started:'Работа запущена',
    progress:'Выполнение',passed:'Проверки пройдены',failed:'Ошибка или дефект',blocked:'Не удалось проверить',
    approved:'Переход к слиянию',awaiting_manual_qa_decision:'Требуется решение по тестам'
   } as Record<string,string>)[ev.stage]||ev.stage,text:ev.detail,time:ev.created_at,failed:ev.level==='error'})),
   ...aiRuns.filter(r=>r.task_id===taskId).map(r=>({id:'run-'+r.id,kind:'run' as const,title:r.status==='completed'?'Разработка завершена':r.status==='failed'?'Ошибка разработки':r.status==='running'?'Codex работает':'Задача в очереди',text:r.message||'Агент выполняет задачу',time:r.created_at||new Date().toISOString(),status:r.status,link:r.pr_url||undefined})),
   ...(activeTask?.id===taskId&&taskTestRuns.length?taskTestRuns:testRuns.filter(r=>r.task_id===taskId)).map(r=>({id:'test-'+r.id,kind:'run' as const,title:r.status==='completed'?(r.verdict==='passed'?'Тесты пройдены':r.verdict==='failed'?'Тестировщик обнаружил ошибки':'Тестирование требует внимания'):r.status==='failed'?'Ошибка тестирования':r.status==='queued'?'Тестировщик в очереди':'AI-тестировщик работает',
    text:[r.report?.summary||r.message||'Тестировщик выполняет проверку',
     ...(r.report?.checks||[]).map(c=>c.name+': '+c.result+(c.details?' — '+c.details:'')),
     ...(r.report?.findings||[]).map(f=>'Дефект ('+f.severity+'): '+f.description+(f.steps?' · '+f.steps:'')),
     ...(r.report?.caseResults||[]).slice(0,30).map(c=>c.case_id+': '+c.result+(c.evidence?' — '+c.evidence:''))
    ].filter(Boolean).join('\n'),time:r.completed_at||r.created_at,status:r.status,failed:r.status==='failed'}))
  ].sort((a,b)=>new Date(a.time).getTime()-new Date(b.time).getTime());
 }
 async function loadRequirements(projectId:string,taskId:string){
  const data=await api<RequirementInfo>('/projects/'+projectId+'/tasks/'+taskId+'/requirements');
  setRequirements(data);
 }
 useEffect(()=>{
  if(!selected?.id||!activeTask?.id){setRequirements(null);return;}
  let live=true;
  const projectId=selected.id,taskId=activeTask.id;
  const refresh=async()=>{
   try{
    const data=await api<RequirementInfo>('/projects/'+projectId+'/tasks/'+taskId+'/requirements');
    if(live){
     setRequirements(data);
     setActiveTask(old=>old&&old.id===data.task.id&&old.spec_version!==data.task.spec_version&&editingField===null
      ?{...old,title:data.task.title,description:data.task.description,spec_version:data.task.spec_version,spec_review_status:data.task.spec_review_status as Task['spec_review_status'],spec_review_note:data.task.spec_review_note}:old);
    }
   }catch{/* Keep previous review data while reconnecting. */}
  };
  void refresh();
  const timer=window.setInterval(()=>{if(!document.hidden)void refresh();},8000);
  return()=>{live=false;window.clearInterval(timer);};
 },[selected?.id,activeTask?.id,editingField]);
 async function decideRequirements(reviewId:string,decision:'approve'|'reject'){
  if(!selected||!activeTask||requirementsBusy)return;
  setRequirementsBusy(true);
  try{
   await api('/projects/'+selected.id+'/tasks/'+activeTask.id+'/requirements/'+reviewId+'/decision',{method:'POST',body:JSON.stringify({decision})});
   await loadRequirements(selected.id,activeTask.id);
   await refreshTaskActivity(selected.id,activeTask.id);
  }catch(e){fail(e);}finally{setRequirementsBusy(false);}
 }
 async function retryRequirements(){
  if(!selected||!activeTask||requirementsBusy)return;
  setRequirementsBusy(true);
  try{
   await api('/projects/'+selected.id+'/tasks/'+activeTask.id+'/requirements/retry',{method:'POST'});
   await loadRequirements(selected.id,activeTask.id);
  }catch(e){fail(e);}finally{setRequirementsBusy(false);}
 }
 async function refreshTaskActivity(projectId:string,taskId:string){
  try{
   const [ts,activity,ms]=await Promise.all([
    api<Task[]>('/projects/'+projectId+'/tasks'),
    api<TaskActivityResponse>('/projects/'+projectId+'/tasks/'+taskId+'/activity'),
    api<AssistantMessage[]>('/projects/'+projectId+'/tasks/'+taskId+'/assistant/messages')
   ]);
   setTasks(ts);setEvents(activity.events);setTaskProcessEvents(activity.processEvents);setTaskTestRuns(activity.tests||[]);setTaskAgentRuns(activity.agentRuns||[]);setTaskAgentNotes(activity.notes||[]);setTaskOrchestration(activity.owner);setTaskMessages(ms);
   setManagerState(await api<ManagerSnapshot>('/projects/'+projectId+'/tasks/'+taskId+'/manager'));
   setActiveTask(current=>current?.id===taskId?ts.find(t=>t.id===taskId)||current:current);
  }catch(e){fail(e);}
 }
 function canAdvance(task:Task,from:string,to:string){
  if(task.stage!==from)return false;
  if(from==='backlog'&&to==='analysis')return true;
  if(from==='analysis'&&to==='development')return readyForDevelopment&&!taskChatBusy&&!managerWorking&&!!gitLink&&aiSettings.enabled;
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
  }else if(from==='analysis')await approveDevelopment(task);
  else if(from==='development')await runAiTask();
  else if(from==='merge_queue')await mergeTask(task);
  else if(from==='documentation')await updateDocumentation();
 }
 const [drag,setDrag]=useState<string|null>(null);
 function fail(e:unknown){if(e instanceof AuthExpiredError)return;setError(e instanceof Error?e.message:'Неизвестная ошибка');}
 async function loadProjects(){try{setProjects(await api('/projects'));setProjectsLoaded(true);}catch(e){fail(e);}}
 async function loadProject(id:string){
  try{
   const [t,s,d,c,pc,gl,ai,runs,qa,pr,suggestions,versions,questions,proposals]=await Promise.all([api<Task[]>('/projects/'+id+'/tasks'),api<Stage[]>('/projects/'+id+'/workflow'),api<Doc[]>('/projects/'+id+'/docs'),api<Connection[]>('/connections'),api<Connection[]>('/projects/'+id+'/connections'),api<GitLink|null>('/projects/'+id+'/git'),api<AiSettings>('/projects/'+id+'/ai-settings'),api<AiRun[]>('/projects/'+id+'/ai-runs'),api<TestRun[]>('/projects/'+id+'/test-runs'),api<ProjectRule[]>('/projects/'+id+'/rules'),api<RuleSuggestion[]>('/projects/'+id+'/rule-suggestions'),api<DocVersion[]>('/projects/'+id+'/documentation/versions'),api<DocumentationQuestion[]>('/projects/'+id+'/documentation/questions'),api<DocumentationProposal[]>('/projects/'+id+'/documentation/proposals')]);
   setLoadedProjectId(id);setTasks(t);setStages(s);setDocs(d);setConnections(c);setProjectConnections(pc);setGitLink(gl);setGitRepository(gl?.repository||'');setTargetBranch(gl?.target_branch||gl?.default_branch||'');setGitTokenId(gl?.connection_id||'');setGitMessage('');setAiSettings(ai);setAiRuns(runs);setTestRuns(qa);setAiMessage('');setRules(pr);setRuleSuggestions(suggestions);setDocumentVersions(versions);setDocQuestions(questions);setDocProposals(proposals);
  }catch(e){fail(e);}
 }
 useEffect(()=>{if(token)void loadProjects();},[token]);
 useEffect(()=>{
  if(!token||!selected?.id)return;
  let live=true;
  const refresh=async()=>{
   try{
    const res=await api<{processes:ProjectProcess[]}>('/projects/'+selected.id+'/processes');
    if(live)setProjectProcesses(res.processes);
   }catch(e){if(live&&section==='processes')fail(e);}
  };
  void refresh();
  const timer=window.setInterval(()=>{if(!document.hidden)void refresh();},9000);
  return()=>{live=false;window.clearInterval(timer);};
 },[token,selected?.id,section]);
 useEffect(()=>{
  if(!token||!selected?.id||!selectedProcessId)return;
  let live=true;
  const refresh=async()=>{
   try{
    const items=await api<ProjectProcessEvent[]>('/projects/'+selected.id+'/processes/'+selectedProcessId+'/events');
    if(live)setProcessEvents(items);
   }catch(e){if(live&&section==='processes')fail(e);}
  };
  void refresh();
  const timer=window.setInterval(refresh,9000);
  return()=>{live=false;window.clearInterval(timer);};
 },[token,selected?.id,selectedProcessId,section]);

 useEffect(()=>{
  if(!token||!projectsLoaded)return;
  if(route.kind==='not-found'){navigate('/projects',true);setError('Адрес страницы не найден');return;}
  if(route.kind==='account'){
   setAccountSettings(true);setSelected(null);setActiveTask(null);setEditingDoc(null);setSelectedDocId(null);
   return;
  }
  if(route.kind==='projects'){
   setAccountSettings(false);setSelected(null);setActiveTask(null);setEditingDoc(null);setSelectedDocId(null);
   return;
  }
  const p=projects.find(item=>item.id===route.projectId);
  if(!p){navigate('/projects',true);setError('Проект не найден или у тебя нет к нему доступа');return;}
  setAccountSettings(false);
  setSelected(current=>current?.id===p.id?current:p);
  setSection(route.section||'tasks');
 },[token,projectsLoaded,route,projects]);
 useEffect(()=>{
  if(route.kind!=='project'||!selected||selected.id!==route.projectId||loadedProjectId!==route.projectId)return;
  if(route.taskId){
   const task=tasks.find(t=>t.id===route.taskId);
   if(task){
    if(activeTask?.id!==task.id){
     setActiveTask({...task});setEditingField(null);setTaskFeedback('');setEvents([]);setTaskProcessEvents([]);setTaskTestRuns([]);setTaskAgentRuns([]);setTaskAgentNotes([]);setManagerState(null);setManagerFeedback('');setCancelPreview(null);setCancelPhrase('');setCancelError('');setAnswerNoteId(null);setAnswerText('');setTaskOrchestration(null);
     void api<TaskActivityResponse>('/projects/'+selected.id+'/tasks/'+task.id+'/activity').then(a=>{setEvents(a.events);setTaskProcessEvents(a.processEvents);setTaskAgentNotes(a.notes||[]);setTaskOrchestration(a.owner);}).catch(fail);
    }
   }else{navigate(projectUrl(selected.id,'tasks'),true);setError('Задача не найдена');}
  }else if(activeTask){setActiveTask(null);}
  if(route.docId){
   const doc=docs.find(d=>d.id===route.docId);
   if(doc){if(selectedDocId!==doc.id){setSelectedDocId(doc.id);if(editingDoc?.id!==doc.id)setEditingDoc(null);}}
   else{navigate(projectUrl(selected.id,'docs'),true);setError('Документ не найден');}
  }else if(selectedDocId){setSelectedDocId(null);setEditingDoc(null);}
 },[route,selected?.id,loadedProjectId,tasks,docs,activeTask?.id,selectedDocId,editingDoc?.id]);

 useEffect(()=>{if(selected)void loadProject(selected.id);},[selected?.id]);
 useEffect(()=>{
  if(!token||!selected?.id||!['docs','tasks','processes'].includes(section))return;
  const id=selected.id;let alive=true;
  const refresh=async()=>{
   if(document.hidden)return;
   try{
    const [documents,questions,proposals]=await Promise.all([
     api<Doc[]>('/projects/'+id+'/docs'),
     api<DocumentationQuestion[]>('/projects/'+id+'/documentation/questions'),
     api<DocumentationProposal[]>('/projects/'+id+'/documentation/proposals')
    ]);
    if(!alive)return;
    setDocs(documents);setDocQuestions(questions);setDocProposals(proposals);
   }catch(e){if(alive&&section==='docs')fail(e);}
  };
  void refresh();
  const timer=window.setInterval(refresh,8000);
  return()=>{alive=false;window.clearInterval(timer);};
 },[token,selected?.id,section]);

 useEffect(()=>{if(projectThreadRef.current)projectThreadRef.current.scrollTop=projectThreadRef.current.scrollHeight;},[projectMessages,projectChatOpen,projectChatBusy]);
 useLayoutEffect(()=>{
  const element=taskThreadRef.current;
  if(element)element.scrollTop=element.scrollHeight;
 },[activeTask?.id,managerMessages,taskAgentRuns,managerWorking,decisions.length]);
 // One live timeline for analysis, development, QA-design, testing and approvals.
 useEffect(()=>{
  if(!selected?.id||!activeTask?.id)return;
  const id=selected.id,taskId=activeTask.id;
  let alive=true;
  const refresh=async()=>{
   if(document.hidden)return;
   try{
    const [feed,messages,manager]=await Promise.all([
     api<TaskActivityResponse>('/projects/'+id+'/tasks/'+taskId+'/activity'),
     api<AssistantMessage[]>('/projects/'+id+'/tasks/'+taskId+'/assistant/messages'),
     api<ManagerSnapshot>('/projects/'+id+'/tasks/'+taskId+'/manager')
    ]);
    if(!alive)return;
    setEvents(old=>JSON.stringify(old)===JSON.stringify(feed.events)?old:feed.events);
    setTaskProcessEvents(old=>JSON.stringify(old)===JSON.stringify(feed.processEvents)?old:feed.processEvents);
    setTaskTestRuns(old=>JSON.stringify(old)===JSON.stringify(feed.tests||[])?old:feed.tests||[]);
    setTaskAgentRuns(old=>JSON.stringify(old)===JSON.stringify(feed.agentRuns||[])?old:feed.agentRuns||[]);
    setTaskAgentNotes(old=>JSON.stringify(old)===JSON.stringify(feed.notes||[])?old:feed.notes||[]);
    setTaskOrchestration(old=>JSON.stringify(old)===JSON.stringify(feed.owner)?old:feed.owner);
    setTaskMessages(old=>JSON.stringify(old)===JSON.stringify(messages)?old:messages);
    setManagerState(old=>JSON.stringify(old)===JSON.stringify(manager)?old:manager);
    const current=manager.task;
    if(current.id===taskId&&current.analysis_state!==undefined){
     const workflow={stage:current.stage,analysis_state:current.analysis_state,
      clarification_questions:current.clarification_questions,spec_review_status:current.spec_review_status};
     setActiveTask(old=>old?.id===taskId?{...old,...workflow,
      ...(!editingField&&current.spec_version!==undefined&&old.spec_version!==current.spec_version
       ?{title:current.title,description:current.description??old.description,spec_version:current.spec_version}:{})}:old);
     setTasks(old=>old.map(task=>task.id===taskId?{...task,...workflow}:task));
    }
   }catch{/* Network reconnection preserves the last known timeline. */}
  };
  void refresh();
  const timer=window.setInterval(()=>void refresh(),4000);
  return()=>{alive=false;window.clearInterval(timer);};
 },[selected?.id,activeTask?.id,editingField]);
 useEffect(()=>{setProjectMessages([]);setProjectInput('');setProjectPendingId(null);if(selected&&!accountSettings){void api<AssistantMessage[]>('/projects/'+selected.id+'/assistant/messages?mode='+projectChatMode).then(setProjectMessages).catch(fail);}},[selected?.id,projectChatMode]);
 useEffect(()=>{
  if(!selected?.id||!projectChatOpen||projectChatMode!=='documentation'||projectChatBusy)return;
  const projectId=selected.id;
  let active=true;
  const refresh=async()=>{
   try{
    const messages=await api<AssistantMessage[]>('/projects/'+projectId+'/assistant/messages?mode=documentation');
    if(active)setProjectMessages(previous=>JSON.stringify(previous)===JSON.stringify(messages)?previous:
     [...messages,...previous.filter(message=>message.failed)]);
   }catch{/* Keep the current dialogue if the connection is interrupted. */}
  };
  const timer=window.setInterval(()=>void refresh(),4000);
  return()=>{active=false;window.clearInterval(timer);};
 },[selected?.id,projectChatOpen,projectChatMode,projectChatBusy]);
 useEffect(()=>{setProjectChatOpen(false);setProjectChatMode('project');setAnalystFiles([]);setAnalystDocumentId(null);},[selected?.id]);
 useEffect(()=>{setTaskMessages([]);setTaskInput('');if(selected&&activeTask){void api<AssistantMessage[]>('/projects/'+selected.id+'/tasks/'+activeTask.id+'/assistant/messages').then(setTaskMessages).catch(fail);}},[selected?.id,activeTask?.id]);
 async function signIn(e:React.FormEvent){e.preventDefault();setError('');try{const d=await api<{token:string}>('/login',{method:'POST',body:JSON.stringify({email:login,password})});sessionStorage.setItem(key,d.token);setToken(d.token);}catch(e){fail(e);}}
 async function createProject(e:React.FormEvent){e.preventDefault();setBusy(true);try{const p=await api<Project>('/projects',{method:'POST',body:JSON.stringify({name:form.name,description:form.description})});await loadProjects();navigate(projectUrl(p.id));setShowProject(false);setForm({...form,name:'',description:''});}catch(e){fail(e);}finally{setBusy(false);}}
 async function createTask(e:React.FormEvent){e.preventDefault();if(!selected)return;setBusy(true);try{await api('/projects/'+selected.id+'/tasks',{method:'POST',body:JSON.stringify({title:form.title,description:form.description,type:form.type,parent_id:form.parent_id||null})});await loadProject(selected.id);setShowTask(false);setForm({...form,title:'',description:'',parent_id:''});}catch(e){fail(e);}finally{setBusy(false);}}
 async function autoSaveField(field:'title'|'description',value:string){if(!selected||!activeTask)return;
  const taskId=activeTask.id;
  setEditingField(null);setSavingField(true);
  try{
   await api('/projects/'+selected.id+'/tasks/'+taskId,{method:'PATCH',body:JSON.stringify({[field]:value})});
   setTasks(old=>old.map(t=>t.id===taskId?{...t,[field]:value}:t));
  }catch(e){setTaskFeedback(e instanceof Error?e.message:'Ошибка автосохранения');fail(e);}finally{setSavingField(false);}
 }
 async function moveTask(task:Task,stage:string){
  if(!selected||stage===task.stage)return;
  if(task.stage==='analysis'&&stage==='development'){await approveDevelopment(task);return;}
  try{await api('/projects/'+selected.id+'/tasks/'+task.id,{method:'PATCH',body:JSON.stringify({stage})});await loadProject(selected.id);}
  catch(e){fail(e);}
 }
 async function saveWorkflowStage(){
  if(!selected||!workflowModal)return;
  setWorkflowSaving(true);
  try{
   const updated=await api<Stage>('/projects/'+selected.id+'/workflow/'+workflowModal.stage,{
    method:'PATCH',body:JSON.stringify({
     mode:workflowModal.mode,agent_name:workflowModal.agent_name.trim(),agent_instructions:workflowModal.agent_instructions
    })
   });
   setStages(old=>old.map(stage=>stage.stage===updated.stage?updated:stage));
   setWorkflowModal(null);
  }catch(e){fail(e);}finally{setWorkflowSaving(false);}
 }

 async function loadKnowledgeDetails(projectId:string,documentId:string){
  const [document,related,versions]=await Promise.all([
   api<{status:string;summary:string;tags:string[]}>('/projects/'+projectId+'/knowledge/documents/'+documentId+'?mode=summary'),
   api<{results:Array<{id:string;relation:string;related_document_id:string;title:string}>}>('/projects/'+projectId+'/knowledge/documents/'+documentId+'/related'),
   api<{versions:Array<{id:string;created_at:string;excerpt:string}>}>('/projects/'+projectId+'/knowledge/documents/'+documentId+'/versions').catch(()=>({versions:[]}))
  ]);
  setKnowledgeMeta({status:(document.status||'approved') as 'approved'|'draft'|'review'|'obsolete',summary:document.summary||'',tags:document.tags||[]});
  setKnowledgeRelated(related.results);setKnowledgeVersions(versions.versions);
 }
 useEffect(()=>{
  if(!selected?.id||!selectedDocId){setKnowledgeMeta(null);setKnowledgeRelated([]);return;}
  let active=true;const project=selected.id,doc=selectedDocId;
  Promise.all([
   api<{status:string;summary:string;tags:string[]}>('/projects/'+project+'/knowledge/documents/'+doc+'?mode=summary'),
   api<{results:Array<{id:string;relation:string;related_document_id:string;title:string}>}>('/projects/'+project+'/knowledge/documents/'+doc+'/related'),
   api<{versions:Array<{id:string;created_at:string;excerpt:string}>}>('/projects/'+project+'/knowledge/documents/'+doc+'/versions').catch(()=>({versions:[]}))
  ]).then(([d,links,versions])=>{if(active){setKnowledgeMeta({status:d.status as 'approved'|'draft'|'review'|'obsolete',summary:d.summary||'',tags:d.tags||[]});setKnowledgeRelated(links.results);setKnowledgeVersions(versions.versions);}}).catch(fail);
  return()=>{active=false;};
 },[selected?.id,selectedDocId]);
 async function restoreKnowledgeVersion(versionId:string){
  if(!selected||!selectedDocId||docBusy)return;
  const doc=docs.find(x=>x.id===selectedDocId);
  if(!doc||!window.confirm('Восстановить содержимое выбранной версии? Текущая версия останется в истории.'))return;
  setDocBusy(true);
  try{
   await api('/projects/'+selected.id+'/knowledge/documents/'+doc.id+'/versions/'+versionId+'/restore',{method:'POST',body:JSON.stringify({expected_version:new Date(doc.updated_at).toISOString()})});
   const actual=await api<{body:string;version:string}>('/projects/'+selected.id+'/knowledge/documents/'+doc.id+'?mode=full');
   setDocs(old=>old.map(item=>item.id===doc.id?{...item,body:actual.body,updated_at:actual.version}:item));
   await loadKnowledgeDetails(selected.id,doc.id);
  }catch(e){fail(e);}finally{setDocBusy(false);}
 }
 async function exportSpecification(){
  if(!selected)return;
  try{
   const data=await api<{filename:string;markdown:string}>('/projects/'+selected.id+'/knowledge/spec/export');
   const url=URL.createObjectURL(new Blob([data.markdown],{type:'text/markdown;charset=utf-8'}));
   const link=document.createElement('a');link.href=url;link.download=data.filename;document.body.appendChild(link);link.click();link.remove();
   URL.revokeObjectURL(url);
  }catch(e){fail(e);}
 }
 async function saveKnowledgeMetadata(){
  if(!selected||!selectedDocId||!knowledgeMeta)return;
  setDocBusy(true);
  try{
   await api('/projects/'+selected.id+'/knowledge/documents/'+selectedDocId+'/metadata',{method:'PATCH',body:JSON.stringify(knowledgeMeta)});
   const current=await api<{version:string}>('/projects/'+selected.id+'/knowledge/documents/'+selectedDocId+'?mode=summary');
   setDocs(old=>old.map(d=>d.id===selectedDocId?{...d,updated_at:current.version}:d));
   await loadKnowledgeDetails(selected.id,selectedDocId);
  }catch(e){fail(e);}finally{setDocBusy(false);}
 }
 async function linkKnowledgeDocument(){
  if(!selected||!selectedDocId||!knowledgeTarget)return;
  setDocBusy(true);
  try{
   await api('/projects/'+selected.id+'/knowledge/links',{method:'POST',body:JSON.stringify({source_document_id:selectedDocId,target_document_id:knowledgeTarget,relation:knowledgeRelation})});
   setKnowledgeTarget('');await loadKnowledgeDetails(selected.id,selectedDocId);
  }catch(e){fail(e);}finally{setDocBusy(false);}
 }
 async function unlinkKnowledgeDocument(linkId:string){
  if(!selected||!selectedDocId)return;
  setDocBusy(true);
  try{
   await api('/projects/'+selected.id+'/knowledge/links/'+linkId,{method:'DELETE'});
   await loadKnowledgeDetails(selected.id,selectedDocId);
  }catch(e){fail(e);}finally{setDocBusy(false);}
 }

 async function addDoc(parentId:string|null=null){
  if(!selected||docBusy)return;
  setDocBusy(true);
  try{
   const resolvedParent=parentId||docs.find(d=>d.system_key==='research')?.id||null;
   if(!resolvedParent)throw Error('Системные разделы ещё не созданы');
   const added=await api<{id:string}>('/projects/'+selected.id+'/docs',{method:'POST',body:JSON.stringify({title:'Новая страница',body:'',parent_id:resolvedParent})});
   const doc:Doc={id:added.id,title:'Новая страница',body:'',parent_id:resolvedParent,updated_at:new Date().toISOString(),document_kind:'technical',implementation_status:'unverified',implementation_evidence:''};
   setCollapsedDocs(items=>items.filter(x=>x!==resolvedParent));
   setDocs(old=>[...old,doc]);
   navigate(projectUrl(selected.id,'docs')+'/'+doc.id);
   setEditingDoc({...doc});
  }catch(e){fail(e);}finally{setDocBusy(false);}
 }
 async function saveDoc(){
  if(!selected||!editingDoc||docBusy)return;
  const doc={...editingDoc,title:editingDoc.title.trim()};
  if(!doc.title){setError('У документа должно быть название');return;}
  setDocBusy(true);
  try{
   await api('/projects/'+selected.id+'/docs/'+doc.id,{method:'PATCH',body:JSON.stringify({title:doc.title,body:doc.body,parent_id:doc.parent_id,document_kind:doc.document_kind,implementation_status:doc.implementation_status,implementation_evidence:doc.implementation_evidence||''})});
   setDocs(old=>old.map(d=>d.id===doc.id?{...doc,updated_at:new Date().toISOString()}:d));
   setEditingDoc(null);
  }catch(e){fail(e);}finally{setDocBusy(false);}
 }
 async function deleteDoc(doc:Doc){
  if(doc.system_key){setError('Системный раздел удалить нельзя');return;}
  if(!selected||docBusy)return;
  const children=docs.filter(d=>d.parent_id===doc.id);
  if(children.length){setError('У страницы «'+doc.title+'» есть вложенные документы. Сначала перемести или удали их.');return;}
  if(!window.confirm('Удалить документ «'+doc.title+'»? Это действие нельзя отменить.'))return;
  setDocBusy(true);
  try{
   await api('/projects/'+selected.id+'/docs/'+doc.id,{method:'DELETE'});
   setDocs(old=>old.filter(d=>d.id!==doc.id));
   navigate(projectUrl(selected.id,'docs'));setEditingDoc(null);
  }catch(e){fail(e);}finally{setDocBusy(false);}
 }
 function selectDoc(doc:Doc){
  if(editingDoc&&(editingDoc.title!==docs.find(d=>d.id===editingDoc.id)?.title||editingDoc.body!==docs.find(d=>d.id===editingDoc.id)?.body||editingDoc.parent_id!==docs.find(d=>d.id===editingDoc.id)?.parent_id)){
   if(!window.confirm('Изменения документа не сохранены. Перейти без сохранения?'))return;
  }
  if(selected)navigate(projectUrl(selected.id,'docs')+'/'+doc.id);
  setEditingDoc(null);
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
 async function refreshRateLimits(silent=false){
  if(!silent)setRateLimitsBusy(true);
  setRateLimitsLoading(true);
  try{const data=await api<CodexRateLimits>('/codex/rate-limits');setRateLimits(data);setRateLimitsError('');}
  catch(e){setRateLimitsError('Данные лимитов временно недоступны');if(!silent)fail(e);}
  finally{setRateLimitsBusy(false);setRateLimitsLoading(false);}
 }
 useEffect(()=>{
  if(!token)return;
  void refreshRateLimits(true);
  const interval=window.setInterval(()=>{if(!document.hidden)void refreshRateLimits(true);},90000);
  const onVisible=()=>{if(!document.hidden)void refreshRateLimits(true);};
  document.addEventListener('visibilitychange',onVisible);
  return()=>{window.clearInterval(interval);document.removeEventListener('visibilitychange',onVisible);};
 },[token]);
 const windowCandidates=rateLimits?.windows.flatMap(bucket=>
  [bucket.primary,bucket.secondary].filter((window):window is CodexRateWindow=>!!window)
   .map(window=>({window,bucketId:bucket.id,bucketName:bucket.name||bucket.id,planType:bucket.planType})))||[];
 const shortSource=windowCandidates.find(entry=>entry.window.windowDurationMins===300)
  ||windowCandidates.find(entry=>entry.window.windowDurationMins!==null&&entry.window.windowDurationMins>=240&&entry.window.windowDurationMins<=360);
 const weeklySource=windowCandidates.find(entry=>entry.window.windowDurationMins===10080)
  ||windowCandidates.find(entry=>entry.window.windowDurationMins!==null&&entry.window.windowDurationMins>=9000&&entry.window.windowDurationMins<=11000);
 const shortWindow=shortSource?.window||null;
 const weekWindow=weeklySource?.window||null;
 const formatPercent=(value:number)=>value>0&&value<1?value.toFixed(2):value.toFixed(1);
 const remaining=(window:CodexRateWindow|null)=>window?Math.max(0,Math.min(100,100-window.usedPercent)):null;
 const colorForRemaining=(percent:number)=>{const hue=Math.max(0,Math.min(120,percent*1.2));return 'hsl('+hue.toFixed(0)+' 66% 43%)';};
 const quotaBar=(window:CodexRateWindow|null,label:string,large:boolean)=>(
  <div className={'quota-line '+(large?'expanded':'')} key={label}>
   {large&&<div className="quota-label"><span>{label}</span><strong>{window?formatPercent(remaining(window)??0)+'% доступно':'Нет данных'}</strong></div>}
   <div className="quota-track" role="progressbar" aria-label={label+' — доступный лимит'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining(window)??undefined}>
    {window?<div className="quota-fill" style={{width:(remaining(window)??0)+'%',backgroundColor:colorForRemaining(remaining(window)??0)}}/>:<div className="quota-unknown"/>}
   </div>
   {large&&<small>{window?.resetsAt?'Сброс: '+new Date(window.resetsAt*1000).toLocaleString('ru-RU'):'Срок обновления неизвестен'}</small>}
  </div>
 );

 useEffect(()=>{if(token&&accountSettings){void refreshTokenUsage();}},[token,accountSettings]);
 async function saveAiSettings(){if(!selected)return;setAiBusy(true);try{const saved=await api<AiSettings>('/projects/'+selected.id+'/ai-settings',{method:'PUT',body:JSON.stringify(aiSettings)});setAiSettings(saved);setAiMessage('Настройки сохранены');}catch(e){fail(e);}finally{setAiBusy(false);}}
 async function startTaskTesting(){
  if(!selected||!activeTask)return;
  setAiBusy(true);
  try{
   await api('/projects/'+selected.id+'/tasks/'+activeTask.id+'/start-testing',{method:'POST'});
   setTaskFeedback('Проверка запущена через Temporal. Подробности — в Центре процессов.');
   await loadProject(selected.id);
  }catch(e){setTaskFeedback(e instanceof Error?e.message:'Не удалось проверить или повторить QA');fail(e);}finally{setAiBusy(false);}
 }
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
 // QA jobs belong to the same task timeline as developer runs.
 // Refresh them independently because Temporal creates testing runs after development completes.
 useEffect(()=>{
  if(!token||!selected?.id)return;
  let active=true;
  const refresh=async()=>{
   if(document.hidden)return;
   try{
    const latest=await api<TestRun[]>('/projects/'+selected.id+'/test-runs');
    if(active)setTestRuns(latest);
   }catch{/* Transient network errors should not erase the last known QA status. */}
  };
  void refresh();
  const timer=window.setInterval(()=>void refresh(),5000);
  const onVisible=()=>{if(!document.hidden)void refresh();};
  document.addEventListener('visibilitychange',onVisible);
  return()=>{active=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',onVisible);};
 },[token,selected?.id]);
 const newestTaskTest=activeTask?(taskTestRuns.find(r=>r.task_id===activeTask.id)||testRuns.find(r=>r.task_id===activeTask.id)):null;
 useEffect(()=>{
  if(!selected?.id||!activeTask?.id){setQaWaiver(null);return;}
  const projectId=selected.id,taskId=activeTask.id;
  let valid=true;
  void api<QaWaiverInfo>('/projects/'+projectId+'/tasks/'+taskId+'/qa-waiver').then(value=>{
   if(valid)setQaWaiver(value);
  }).catch(()=>{if(valid)setQaWaiver(null);});
  return()=>{valid=false;};
 },[selected?.id,activeTask?.id,newestTaskTest?.id,newestTaskTest?.status,newestTaskTest?.verdict]);
 const openAgentQuestions=taskAgentNotes.filter(n=>n.kind==='question'&&n.status==='open');
 async function sendAgentNote(){
  if(!selected||!activeTask||noteBusy||noteDraft.trim().length<3)return;
  setNoteBusy(true);
  try{
   const id=selected.id,taskId=activeTask.id;
   await api('/projects/'+id+'/tasks/'+taskId+'/agent-notes',{method:'POST',body:JSON.stringify({
    body:noteDraft.trim(),target_stage:noteTarget,kind:'observation'
   })});
   setNoteDraft('');
   await refreshTaskActivity(id,taskId);
  }catch(e){fail(e);}finally{setNoteBusy(false);}
 }
 async function answerAgentQuestion(){
  if(!selected||!activeTask||!answerNoteId||!answerText.trim()||noteBusy)return;
  setNoteBusy(true);
  try{
   const id=selected.id,taskId=activeTask.id;
   const response=await api<{pending_questions:number;requires_approval:boolean;requirements_review?:{started?:boolean;message?:string}|null}>('/projects/'+id+'/tasks/'+taskId+'/agent-notes/'+answerNoteId+'/answer',{method:'POST',body:JSON.stringify({answer:answerText.trim()})});
   setAnswerNoteId(null);setAnswerText('');
   await refreshTaskActivity(id,taskId);
   await loadRequirements(id,taskId);
   setTaskFeedback(response.pending_questions>0?'Ответ сохранён. Осталось ответить на '+response.pending_questions+' вопрос(а).':response.requires_approval?'Вопрос закрыт, но изменение поведения требует отдельного согласования. Рассмотри предложение аналитика.':response.requirements_review?.message||'Ответ сохранён. Сверка аналитика требуется перед продолжением.');
  }catch(e){fail(e);}finally{setNoteBusy(false);}
 }
 async function showTaskCancellation(){
  if(!selected||!activeTask||cancelBusy)return;
  setCancelBusy(true);setCancelError('');
  try{
   const preview=await api<CancelPreview>('/projects/'+selected.id+'/tasks/'+activeTask.id+'/cancel-preview');
   setCancelPreview(preview);
  }catch(e){setCancelError(e instanceof Error?e.message:'Не удалось получить условия отмены');}
  finally{setCancelBusy(false);}
 }
 async function confirmTaskCancellation(){
  if(!selected||!activeTask||!cancelPreview||cancelBusy)return;
  setCancelBusy(true);setCancelError('');
  try{
   await api('/projects/'+selected.id+'/tasks/'+activeTask.id+'/cancel',{method:'POST',body:JSON.stringify({confirm:true})});
   setCancelPreview(null);setActiveTask(null);
   const id=selected.id;
   navigate(projectUrl(id,'tasks'));
   await loadProject(id);
  }catch(e){setCancelError(e instanceof Error?e.message:'Отмена задачи не завершена');}
  finally{setCancelBusy(false);}
 }
 async function applyQaResult(){
  if(!selected||!activeTask||qaResultBusy||taskOrchestration)return;
  const taskId=activeTask.id,projectId=selected.id;
  setQaResultBusy(true);
  try{
   const result=await api<{ok:boolean;stage:string;message:string}>('/projects/'+projectId+'/tasks/'+taskId+'/apply-qa-result',{method:'POST'});
   setTaskFeedback(result.message);
   await refreshTaskActivity(projectId,taskId);
   await loadProject(projectId);
  }catch(error){
   setTaskFeedback(error instanceof Error?error.message:'Не удалось подтвердить результат тестирования');
  }finally{setQaResultBusy(false);}
 }
 async function approveQaWaiver(){
  if(!selected||!activeTask||!qaWaiver?.assessment.eligible||!qaWaiver.run_id||qaWaiverBusy)return;
  if(qaWaiverReason.trim().length<20||!qaWaiverAcknowledged){
   setTaskFeedback('Укажи причину (не менее 20 символов) и подтверди, что понимаешь, какие проверки не выполнялись.');
   return;
  }
  setQaWaiverBusy(true);
  try{
   await api('/projects/'+selected.id+'/tasks/'+activeTask.id+'/qa-waiver',{method:'POST',body:JSON.stringify({
    test_run_id:qaWaiver.run_id,justification:qaWaiverReason.trim(),acknowledge_unverified:true
   })});
   setTaskFeedback('Исключение согласовано. Пропущенные проверки останутся в истории; GitHub CI по-прежнему обязателен.');
   setQaWaiverReason('');setQaWaiverAcknowledged(false);
   const current=await api<Task[]>('/projects/'+selected.id+'/tasks');
   setTasks(current);setActiveTask(old=>old?current.find(t=>t.id===old.id)||old:null);
   setQaWaiver(await api<QaWaiverInfo>('/projects/'+selected.id+'/tasks/'+activeTask.id+'/qa-waiver'));
  }catch(error){fail(error);}finally{setQaWaiverBusy(false);}
 }
 const activeTestFor=(taskId:string)=>testRuns.find(r=>r.task_id===taskId&&['running','queued'].includes(r.status));
 const agentWorking=(taskId:string)=>backgroundProcesses.some(p=>p.taskId===taskId&&['queued','running'].includes(p.status))||
  (activeTask?.id===taskId&&!!taskOrchestration)||aiRuns.some(r=>r.task_id===taskId&&r.status==='running')||
  testRuns.some(r=>r.task_id===taskId&&r.status==='running')||
  projectProcesses.some(p=>p.kind==='analysis'&&p.taskId===taskId&&['queued','running'].includes(p.status));
 // The board also follows questions opened or resolved while the task chat is closed.
 useEffect(()=>{
  if(!token||!selected?.id||loadedProjectId!==selected.id||section!=='tasks')return;
  let alive=true;
  const timer=window.setInterval(async()=>{
   if(document.hidden)return;
   try{
    const current=await api<Task[]>('/projects/'+selected.id+'/tasks');
    if(!alive)return;
    setTasks(current);
    setActiveTask(old=>old?current.find(t=>t.id===old.id)||old:null);
   }catch{/* Keep prior state during transient network failures. */}
  },7000);
  return()=>{alive=false;window.clearInterval(timer);};
 },[token,selected?.id,loadedProjectId,section]);
 function openDocumentationChat(){
  setAnalystDocumentId(selectedDocId);
  setProjectChatMode('documentation');
  setProjectChatOpen(true);
 }
 function attachAnalystFiles(files:FileList|null){
  const next=[...analystFiles,...Array.from(files||[])];
  if(next.length>5||next.some(file=>file.size===0||file.size>100000||! /\.(?:md|txt|csv|json|ya?ml)$/i.test(file.name))||next.reduce((size,file)=>size+file.size,0)>250000){
   setError('Можно прикрепить до 5 непустых текстовых файлов (Markdown, TXT, CSV, JSON, YAML), до 100 КБ каждый и до 250 КБ суммарно.');
   return;
  }
  setAnalystFiles(next);
 }
 async function sendProjectMessage(e:React.FormEvent){
  e.preventDefault();
  const files=projectChatMode==='documentation'?analystFiles:[];
  if(!selected||(!projectInput.trim()&&!files.length)||projectChatBusy)return;
  const projectId=selected.id,mode=projectChatMode,optimisticId='pending-'+crypto.randomUUID();
  const message=projectInput.trim()||'Подготовь ТЗ по приложенным материалам.';
  const scope=projectId+':'+mode;
  setProjectMessages(old=>[...old,{id:optimisticId,role:'user',body:message+(files.length?'\n\nМатериалы: '+files.map(file=>file.name).join(', '):''),pending:true,created_at:new Date().toISOString()}]);
  setProjectInput('');setProjectPendingId(optimisticId);setProjectChatBusy(true);
  try{
   const attachments=await Promise.all(files.map(async file=>({name:file.name,body:await file.text()})));
   let completedJob=false;
   let response=await api<AssistantResponse>('/projects/'+projectId+'/assistant',{method:'POST',body:JSON.stringify({
    message,mode,attachments,documentId:mode==='documentation'?analystDocumentId:null
   })});
   if(response.import_job_id){
    const jobId=response.import_job_id;
    setProjectImportProgress('Аналитик начал работу…');
    for(;;){
     await new Promise(resolve=>setTimeout(resolve,2500));
     const job=await api<ImportJob>('/projects/'+projectId+'/document-import/'+jobId);
     setProjectImportProgress(job.message||'Аналитик готовит ответ…');
     if(job.status==='failed')throw new Error(job.message||'Не удалось импортировать документацию');
     if(job.status==='completed'){
      if(!job.result)throw new Error('Импорт завершился без результата');
      response=job.result;completedJob=true;break;
     }
    }
   }
   if(chatScope.current===scope){
    setProjectMessages(old=>[...old.map(m=>m.id===optimisticId?{...m,pending:false}:m),
     {id:'reply-'+crypto.randomUUID(),role:'assistant',body:response.message,created_task_id:response.created_task_id,created_document_id:response.created_document_id,created_at:new Date().toISOString()}]);
    if(files.length)setAnalystFiles([]);
   }
   if(chatScope.current.startsWith(projectId+':')&&(completedJob||response.created_task_id||response.created_document_id))await loadProject(projectId);
  }catch(e){
   setProjectMessages(old=>old.map(m=>m.id===optimisticId?{...m,pending:false,failed:true}:m));
   fail(e);
  }finally{setProjectChatBusy(false);setProjectPendingId(null);setProjectImportProgress('');}
 }
 async function sendTaskMessage(e:React.FormEvent){
  e.preventDefault();
  if(!selected||!activeTask||!taskInput.trim()||managerSending)return;
  const projectId=selected.id,taskId=activeTask.id,message=taskInput.trim();
  const optimisticId='pending-'+crypto.randomUUID();
  const sentAt=new Date().toISOString();
  setManagerState(old=>old?{...old,messages:[...old.messages,{id:optimisticId,role:'user',body:message,status:'queued',created_at:sentAt}]}:old);
  setTaskInput('');setManagerFeedback('');setManagerSending(true);
  try{
   const response=await api<{id:string;status:string}>('/projects/'+projectId+'/tasks/'+taskId+'/manager/messages',{
    method:'POST',body:JSON.stringify({message})
   });
   setManagerState(old=>old?{...old,messages:old.messages.map(m=>m.id===optimisticId?{...m,id:response.id}:m)}:old);
  }catch(error){
   setManagerFeedback(error instanceof Error?error.message:'Сообщение не принято');
   setManagerState(old=>old?{...old,messages:old.messages.map(m=>m.id===optimisticId?{...m,status:'failed'}:m)}:old);
  }finally{setManagerSending(false);}
 }
 async function decideAsManager(request:ManagerRequest,choice:string){
  if(!selected||!activeTask||managerBusy)return;
  if(choice==='answer'&&managerAnswer.trim().length<3){setManagerFeedback('Ответь на вопрос Менеджера проекта');return;}
  const projectId=selected.id,taskId=activeTask.id;
  setManagerBusy(true);setManagerFeedback('');
  try{
   await api('/projects/'+projectId+'/tasks/'+taskId+'/manager/requests/'+request.id+'/decision',{
    method:'POST',body:JSON.stringify({choice,answer:choice==='answer'?managerAnswer.trim():''})
   });
   setManagerAnswer('');
   await refreshTaskActivity(projectId,taskId);
   await loadRequirements(projectId,taskId);
  }catch(error){setManagerFeedback(error instanceof Error?error.message:'Менеджер проекта не смог выполнить решение');}
  finally{setManagerBusy(false);}
 }
 async function resumeAsManager(){
  if(!selected||!activeTask||managerBusy)return;
  const projectId=selected.id,taskId=activeTask.id;
  setManagerBusy(true);setManagerFeedback('');
  try{
   await api('/projects/'+projectId+'/tasks/'+taskId+'/manager/continue',{method:'POST',body:'{}'});
   await refreshTaskActivity(projectId,taskId);
   await loadProject(projectId);
  }catch(error){setManagerFeedback(error instanceof Error?error.message:'Не удалось продолжить задачу');}
  finally{setManagerBusy(false);}
 }
 async function retryManagerMessage(messageId:string){
  if(!selected||!activeTask||managerBusy)return;
  setManagerBusy(true);setManagerFeedback('');
  try{
   await api('/projects/'+selected.id+'/tasks/'+activeTask.id+'/manager/messages/'+messageId+'/retry',{method:'POST',body:'{}'});
   await refreshTaskActivity(selected.id,activeTask.id);
  }catch(error){setManagerFeedback(error instanceof Error?error.message:'Не удалось повторить запрос');}
  finally{setManagerBusy(false);}
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
 async function approveDevelopment(task:Task){
  if(!selected||taskChatBusy)return;
  const projectId=selected.id;
  setTaskChatBusy(true);setManagerFeedback('');
  try{
   const run=await api<AiRun&{recovered?:boolean}>('/projects/'+projectId+'/tasks/'+task.id+'/approve-development',{method:'POST'});
   if(!run.recovered)setAiRuns(old=>[run,...old.filter(previous=>previous.id!==run.id)]);
   setAiMessage(run.message||'Разработка принята в очередь.');
   if(activeTask?.id===task.id)await refreshTaskActivity(projectId,task.id);
   else await loadProject(projectId);
  }catch(e){
   if(activeTask?.id===task.id)setManagerFeedback(e instanceof Error?e.message:'Не удалось начать разработку');
   else fail(e);
  }finally{setTaskChatBusy(false);}
 }
 async function mergeTask(task:Task){if(!selected||!window.confirm('Слить PR задачи «'+task.title+'» в '+(gitLink?.target_branch||'целевую ветку')+'?'))return;
  setMergeBusy(true);try{
   await api('/projects/'+selected.id+'/tasks/'+task.id+'/merge',{method:'POST'});
   setTasks(old=>old.map(t=>t.id===task.id?{...t,stage:'documentation'}:t));
   setActiveTask(old=>old?.id===task.id?{...old,stage:'documentation'}:old);
   setMergeReport('PR слит. Задача ожидает актуализации документации.');
  }catch(e){fail(e);}finally{setMergeBusy(false);}
 }
 async function mergeReady(){if(!selected||!window.confirm('Последовательно слить PR с автоматическим разрешением конфликтов?'))return;
  setMergeBusy(true);
  try{
   const batch=await api<{id:string;status:string;message:string;results:Array<{taskId:string,status:string,reason?:string}>}>('/projects/'+selected.id+'/merge-ready',{method:'POST'});
   setMergeReport('Начато последовательное слияние PR.');
   let state=batch;
   while(state.status==='running'){
    await new Promise(resolve=>setTimeout(resolve,3000));
    state=await api<typeof batch>('/projects/'+selected.id+'/merge-ready/'+batch.id);
    setMergeReport(state.message+' · Слито: '+state.results.filter(r=>r.status==='merged').length+'.');
   }
   const result=state;
   setTasks(old=>old.map(t=>result.results.some(r=>r.taskId===t.id&&r.status==='merged')?{...t,stage:'documentation'}:t));
   const mergedCount=result.results.filter(r=>r.status==='merged').length;
   const skippedCount=result.results.filter(r=>r.status==='skipped').length;
   const errors=[...new Set(result.results.map(r=>r.reason).filter((value):value is string=>!!value))];
   setMergeReport('Слито: '+mergedCount+'. Требуется внимание: '+skippedCount+'.'+(errors.length?' Подробности показаны в уведомлении.':''));
   if(errors.length)fail(new Error(errors.join('\n')));
   if(mergedCount)await loadProject(selected.id);
  }catch(e){fail(e);}finally{setMergeBusy(false);}
 }
 async function openTask(t:Task){if(selected)navigate(projectUrl(selected.id,'tasks')+'/'+t.id);}
 async function refreshCodex(){try{setCodex(await api<CodexState>('/codex/status'));}catch(e){setCodex({connected:false});fail(e);}}
 async function codexAction(action:'login'|'logout'|'test'){setCodexBusy(true);setCodexTest('');try{const res=await api<any>('/codex/'+action,{method:'POST'});if(action==='test')setCodexTest(res.message||'Подключение работает');await refreshCodex();if(action==='login'&&res.login)setCodex(old=>({...old,connected:false,login:res.login}));}catch(e){fail(e);}finally{setCodexBusy(false);}}
 useEffect(()=>{if(token&&accountSettings){void refreshCodex();}},[token,accountSettings]);
 useEffect(()=>{if(!token||!accountSettings||!codex?.login||codex.login.state!=='waiting')return;const interval=setInterval(()=>void refreshCodex(),3500);return ()=>clearInterval(interval);},[token,accountSettings,codex?.login?.state]);
 function logout(){void fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'}).catch(()=>{});sessionStorage.removeItem(key);setToken('');setSelected(null);setAccountSettings(false);setProjects([]);setProjectsLoaded(false);setLoadedProjectId(null);setCodex(null);navigate('/projects',true);}
 function docTreeMatches(d:Doc):boolean {const q=docSearch.trim().toLowerCase();return !q||d.title.toLowerCase().includes(q)||docs.some(child=>child.parent_id===d.id&&docTreeMatches(child));}
 function renderDocTree(parentId:string|null,depth=0):React.ReactNode {
  return docs.filter(d=>d.parent_id===parentId&&docTreeMatches(d)).sort((a,b)=>parentId===null?(['spec','architecture','operations','design','research'].indexOf(a.system_key||'')-['spec','architecture','operations','design','research'].indexOf(b.system_key||'')):a.title.localeCompare(b.title,'ru')).map(d=>{
   const hasChildren=docs.some(c=>c.parent_id===d.id),collapsed=collapsedDocs.includes(d.id);
   return <div key={d.id}>
    <div className="doc-node" style={{paddingLeft:8+Math.min(depth,8)*18}}>
     <button className="doc-toggle" type="button" aria-label={collapsed?'Развернуть':'Свернуть'} onClick={()=>setCollapsedDocs(items=>collapsed?items.filter(x=>x!==d.id):[...items,d.id])}>{hasChildren?(collapsed?'▸':'▾'):'·'}</button>
     <a className={'doc-title '+(selectedDocId===d.id?'selected':'')} href={selected?projectUrl(selected.id,'docs')+'/'+d.id:'#'} onClick={e=>{if(e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();selectDoc(d);}}><FileText size={16}/><span>{d.title}</span></a>
     <button className="doc-add-child" type="button" title="Добавить вложенную страницу" aria-label={'Добавить страницу в '+d.title} onClick={()=>void addDoc(d.id)}><Plus size={15}/></button>
    </div>
    {!collapsed&&hasChildren&&renderDocTree(d.id,depth+1)}
   </div>;
  });
 }
 const kanbanGroups:KanbanGroup[]=stageGroupDefinitions.map(def=>({
  key:def.key,title:def.title,
  stages:[...(def.key==='analytics'?[productOwnerLane]:[]),...stages.filter(stage=>def.ids.includes(stage.stage))]
 })).filter(group=>group.stages.length>0);
 const ungroupedStages=stages.filter(stage=>!stageGroupDefinitions.some(group=>group.ids.includes(stage.stage)));
 if(ungroupedStages.length)kanbanGroups.push({key:'other',title:'Другие этапы',stages:ungroupedStages});
 function renderKanbanCard(t:Task,showStage=false){
  return <a className="task-card" href={projectUrl(selected!.id,'tasks')+'/'+t.id}
    draggable={!t.awaits_product_owner} onDragStart={t.awaits_product_owner?undefined:e=>{setDrag(t.id);e.dataTransfer.effectAllowed='move';}} onDragEnd={()=>setDrag(null)}
    onClick={e=>followLink(e,projectUrl(selected!.id,'tasks')+'/'+t.id)} key={t.id}>
    <span className="task-card-top"><span className="task-type">{t.type==='bug'?'Ошибка':t.type==='epic'?'Эпик':t.type==='improvement'?'Улучшение':'Задача'}</span><span className="task-id-label" title={"Полный ID задачи: "+t.id}>#{t.display_number}</span></span>
    <span className="task-name-line"><strong>{t.title}</strong>{agentWorking(t.id)&&<span className="agent-equalizer task-card-activity" role="status" aria-label="AI работает над задачей" title="AI выполняет задачу"><i/><i/><i/></span>}</span>
    <p>{t.description||'Без описания'}</p>
    {t.awaits_product_owner&&<small className="task-warning">
     Ждёт ответа · {stages.find(stage=>stage.stage===t.stage)?.label||t.stage}
    </small>}
  </a>;
 }
 function renderDocQuestionCard(question:DocumentationQuestion){
  return <div className="task-card docs-question-card" key={'doc-question-'+question.id}>
   <span className="task-type">Уточнение документации</span>
   <strong>{question.question}</strong>
   <a href={projectUrl(selected!.id,'docs')+'/'+question.document_id} onClick={e=>followLink(e,projectUrl(selected!.id,'docs')+'/'+question.document_id)}>ТЗ: {question.document_title}</a>
   {question.status==='answered'?<small className="muted">Ответ получен. Аналитик обновляет страницу.</small>:<>
    <textarea rows={3} value={questionAnswers[question.id]||''} onChange={e=>setQuestionAnswers(old=>({...old,[question.id]:e.target.value}))} placeholder="Решение владельца продукта"/>
    <button className="secondary" disabled={processActionBusy||!(questionAnswers[question.id]||'').trim()} onClick={()=>void answerDocumentationQuestion(question)}>Ответить аналитику</button>
   </>}
  </div>;
 }
 function renderKanbanLane(s:KanbanLane){
  const isQuestions=s.stage===productOwnerLane.stage;
  const stageTasks=filtered.filter(t=>boardLaneFor(t)===s.stage);
  return <div className="lane" key={s.stage}
   onDragOver={isQuestions?undefined:e=>e.preventDefault()}
   onDrop={isQuestions?undefined:e=>{e.preventDefault();if(drag){const task=tasks.find(t=>t.id===drag);if(task&&!task.awaits_product_owner)void moveTask(task,s.stage);}setDrag(null);}}>
   <div className="lane-heading"><span className={'stage-dot '+s.stage}></span><b>{s.label}</b><span className="count">{stageTasks.length+(isQuestions?docQuestions.length:0)}</span>
    {s.stage==='merge_queue'&&<button className="secondary" disabled={mergeBusy||!tasks.some(t=>t.stage==='merge_queue')} onClick={e=>{e.stopPropagation();void mergeReady();}} title="Последовательно слить проверенные PR">Слить готовые</button>}
    {s.stage==='documentation'&&<button className="secondary" disabled={knowledgeBusy||!tasks.some(t=>t.stage==='documentation')} onClick={e=>{e.stopPropagation();void updateDocumentation();}} title="Обновить документацию по всем слитым задачам">Обновить документацию</button>}
   </div>
   <div className="cards">
     {stageTasks.map(t=>renderKanbanCard(t))}
     {isQuestions&&docQuestions.map(renderDocQuestionCard)}
      {stageTasks.length===0&&(!isQuestions||docQuestions.length===0)&&<div className="lane-empty">{isQuestions?'Нет открытых вопросов':'Перетащите задачу сюда'}</div>}
    </div>
  </div>;
 }
 function renderCollapsedGroup(group:KanbanGroup){
  const groupTasks=filtered.filter(t=>group.stages.some(stage=>stage.stage===boardLaneFor(t)));
  // One list, not nested stage columns. Keep stage identity on each card.
  const ordered=groupTasks.slice().sort((a,b)=>{
   const ai=group.stages.findIndex(stage=>stage.stage===boardLaneFor(a));
   const bi=group.stages.findIndex(stage=>stage.stage===boardLaneFor(b));
   return ai-bi || new Date(a.created_at).getTime()-new Date(b.created_at).getTime();
  });
  return <div className="kanban-group-combined">
   {ordered.length||(group.key==='analytics'&&docQuestions.length)?<div className="cards">{ordered.map(task=>renderKanbanCard(task,true))}{group.key==='analytics'&&docQuestions.map(renderDocQuestionCard)}</div>:
     <div className="lane-empty">В группе пока нет задач</div>}
   {group.stages.some(stage=>stage.stage==='merge_queue')&&tasks.some(t=>t.stage==='merge_queue')&&
    <button className="secondary group-action" disabled={mergeBusy} onClick={()=>void mergeReady()}>Слить готовые</button>}
   {group.stages.some(stage=>stage.stage==='documentation')&&tasks.some(t=>t.stage==='documentation')&&
    <button className="secondary group-action" disabled={knowledgeBusy} onClick={()=>void updateDocumentation()}>Обновить документацию</button>}
  </div>;
 }
 async function answerDocumentationQuestion(question:DocumentationQuestion){
  if(!selected||processActionBusy)return;
  const answer=questionAnswers[question.id]?.trim();
  if(!answer){setError('Введи ответ владельца продукта');return;}
  setProcessActionBusy(true);
  try{
   await api('/projects/'+selected.id+'/documentation/questions/'+question.id+'/answer',{method:'POST',body:JSON.stringify({answer})});
   setQuestionAnswers(old=>({...old,[question.id]:''}));
   await loadProject(selected.id);
  }catch(e){fail(e);}finally{setProcessActionBusy(false);}
 }
 async function decideDocumentationProposal(proposal:DocumentationProposal,decision:'approve'|'reject'){
  if(!selected||processActionBusy)return;
  setProcessActionBusy(true);
  try{
   await api('/projects/'+selected.id+'/documentation/proposals/'+proposal.id+'/decision',{method:'POST',body:JSON.stringify({decision})});
   await loadProject(selected.id);
  }catch(e){fail(e);}finally{setProcessActionBusy(false);}
 }
 async function restartImport(process:ProjectProcess){
  if(!selected||processActionBusy)return;
  setProcessActionBusy(true);
  try{
   await api('/projects/'+selected.id+'/document-import/'+process.id+'/resume',{method:'POST'});
   const res=await api<{processes:ProjectProcess[]}>('/projects/'+selected.id+'/processes');
   setProjectProcesses(res.processes);setSelectedProcessId(res.processes[0]?.id||null);
  }catch(e){fail(e);}finally{setProcessActionBusy(false);}
 }
 async function sendProcessInstruction(process:ProjectProcess){
  if(!selected||!processInstruction.trim()||processActionBusy)return;
  setProcessActionBusy(true);
  try{
   await api('/projects/'+selected.id+'/processes/'+process.id+'/instructions',
    {method:'POST',body:JSON.stringify({message:processInstruction.trim()})});
   setProcessInstruction('');
   const events=await api<ProjectProcessEvent[]>('/projects/'+selected.id+'/processes/'+process.id+'/events');
   setProcessEvents(events);
  }catch(e){fail(e);}finally{setProcessActionBusy(false);}
 }
 async function retryProcessSave(process:ProjectProcess){
  if(!selected||processActionBusy)return;
  setProcessActionBusy(true);
  try{
   await api('/projects/'+selected.id+'/document-import/'+process.id+'/retry-save',{method:'POST'});
   const res=await api<{processes:ProjectProcess[]}>('/projects/'+selected.id+'/processes');
   setProjectProcesses(res.processes);
   await loadProject(selected.id);
  }catch(e){fail(e);}finally{setProcessActionBusy(false);}
 }
 const processStatus=(status:string)=>status==='completed'?'Завершён':status==='failed'?'Ошибка':status==='queued'?'В очереди':status==='running'?'Выполняется':status;
 const docKindLabel=(kind:Doc['document_kind'])=>kind==='technical'?'Техническая документация':'Функциональность';
 const implementationLabel=(status:Doc['implementation_status'])=>({unverified:'Не подтверждено',planned:'Запланировано',partial:'Реализовано частично',implemented:'Реализовано'}[status]);
 const filtered=tasks.filter(t=>t.title.toLowerCase().includes(search.toLowerCase())||String(t.display_number).includes(search.replace(/^#/,'')));
 if(!token)return <div className="login-shell"><form className="login-card" onSubmit={signIn}><span className="logo-icon">◈</span><h1>AI Development<br/>Orchestrator</h1><p>Войдите, чтобы управлять проектами</p><label>Электронная почта<input type="text" inputMode="email" autoComplete="username" required value={login} onChange={e=>setLogin(e.target.value)} placeholder="admin@example.com"/></label><label>Пароль<input type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)}/></label><button className="primary">Войти</button></form>{error&&<div className="error-toast" role="alert"><span>{error}</span><button type="button" title="Закрыть уведомление" aria-label="Закрыть уведомление" onClick={()=>setError('')}><X size={17}/></button></div>}</div>;
 return <div className="shell">
 <aside className="sidebar"><div className="brand"><span className="logo-icon">◈</span><span>Orchestrator<small>WORKSPACE</small></span></div>
  <div className="sidebar-projects">
   <button type="button" className="project-selector" aria-expanded={projectMenuOpen} aria-label="Выбрать проект" onClick={()=>setProjectMenuOpen(open=>!open)}>
    <span className="project-selector-title">{selected?.name||'Выбрать проект'}</span><ChevronDown size={17} className={projectMenuOpen?'rotate':''}/>
   </button>
   {projectMenuOpen&&<div className="project-menu">
    <a href="/projects" onClick={e=>{setProjectMenuOpen(false);followLink(e,'/projects');}}><LayoutGrid size={15}/> Все проекты</a>
    {projects.map(p=><a key={p.id} href={projectUrl(p.id)} className={selected?.id===p.id?'selected':''} onClick={e=>{setProjectMenuOpen(false);followLink(e,projectUrl(p.id));}}><span className="project-menu-name">{p.name}</span>{selected?.id===p.id&&<CheckCircle2 size={15}/>}</a>)}
    <button type="button" onClick={()=>{setProjectMenuOpen(false);setForm(current=>({...current,name:'',description:''}));setShowProject(true);}}><Plus size={15}/> Новый проект</button>
   </div>}
  </div>
  <div className="sidebar-nav">
  {selected?<><div className="sidebar-label">ПРОЕКТ</div>
   {([['overview','Обзор',LayoutGrid],['tasks','Задачи',Columns3],['docs','Документация',BookOpen],['qa','Тестирование',CheckCircle2],['processes','Процессы',Clock3],['rules','Правила',FileText],['settings','Настройки проекта',Settings2]] as const).map(([k,label,Icon])=><a key={k} href={projectUrl(selected.id,k)} className={'nav '+(section===k?'active':'')} onClick={e=>followLink(e,projectUrl(selected.id,k))}><Icon size={18}/>{label}</a>)}
  </>:<a href="/projects" className="nav active" onClick={e=>followLink(e,'/projects')}><LayoutGrid size={18}/> Мои проекты</a>}
  </div>
  <div className="sidebar-bottom">
   <span className="avatar">AD</span><span className="account-name">Администратор</span>
   <a href="/account/settings" className={'account-settings-button '+(accountSettings?'active':'')} onClick={e=>followLink(e,'/account/settings')} title="Настройки аккаунта" aria-label="Настройки аккаунта"><Settings2 size={18}/></a>
   <button className="logout-button" onClick={logout} title="Выйти" aria-label="Выйти"><ArrowRightCircle size={17}/></button>
  </div>
 </aside>
 <main className="main"><header className="topbar"><a className="crumb" href="/projects" onClick={e=>followLink(e,'/projects')}>Мои проекты</a>{accountSettings?<><span className="slash">/</span><strong>Настройки аккаунта</strong></>:selected&&<><span className="slash">/</span><a className="crumb project-crumb" href={projectUrl(selected.id,'overview')} onClick={e=>followLink(e,projectUrl(selected.id,'overview'))}>{selected.name}</a><span className="slash">/</span><strong>{section==='overview'?'Обзор':section==='tasks'?'Задачи':section==='docs'?'Документация':section==='qa'?'Тестирование':section==='processes'?'Процессы':section==='rules'?'Правила':'Настройки'}</strong></>}<div className="top-right">
   <div className="quota-widget" tabIndex={0} aria-label="Лимиты Codex: 5 часов и неделя" title="Лимиты Codex">
    <div className="quota-compact">{quotaBar(shortWindow,'5 часов',false)}{quotaBar(weekWindow,'Неделя',false)}</div>
    <div className="quota-popover" role="tooltip">
     <strong>Лимиты Codex</strong>
     {quotaBar(shortWindow,'5-часовой лимит',true)}
     {quotaBar(weekWindow,'Недельный лимит',true)}
     <small className="quota-source">Источник: Codex CLI · account/rateLimits/read</small>
     {shortSource&&<small className="quota-source">5 ч: {shortSource.bucketName} · использовано {formatPercent(shortWindow?.usedPercent??0)}%</small>}
     {weeklySource&&<small className="quota-source">Неделя: {weeklySource.bucketName} · использовано {formatPercent(weekWindow?.usedPercent??0)}%</small>}
     {rateLimits&&rateLimits.windows.length>1&&<small className="quota-source">Другие лимиты: {rateLimits.windows.map(bucket=>bucket.name||bucket.id).join(', ')}</small>}
     <small className="quota-updated">{rateLimits?.checkedAt?'Обновлено: '+new Date(rateLimits.checkedAt).toLocaleTimeString('ru-RU'):'Данные не загружены'}{rateLimitsLoading?' · обновление…':''}{rateLimitsError?' · '+rateLimitsError:''}</small>
    </div>
   </div>
   <div className="background-process-control" ref={processDropdownRef}>
    <button className={'background-process-count '+(backgroundProcessMenuOpen?'is-open':'')} type="button"
     aria-label={'Фоновые процессы: '+backgroundProcesses.length} aria-expanded={backgroundProcessMenuOpen}
     aria-haspopup="true" title="Фоновые процессы"
     onClick={()=>setBackgroundProcessMenuOpen(open=>!open)}>{backgroundProcesses.length}</button>
    {backgroundProcessMenuOpen&&<div className="background-process-popover">
     <div className="background-process-heading"><strong>Фоновые процессы</strong><span>{backgroundProcesses.length}</span></div>
     {backgroundProcesses.length===0?<p className="background-process-empty">Нет активных процессов</p>:
      <div className="background-process-list">{backgroundProcesses.map(process=>
       <a key={process.id} href={process.url} className="background-process-item"
        onClick={e=>{setBackgroundProcessMenuOpen(false);followLink(e,process.url);}}>
        <span className="background-process-item-title"><span className="background-process-pulse"/><strong>{process.title}</strong></span>
        <span className="background-process-project">{process.projectName} · {process.status==='queued'?'В очереди':'Выполняется'}</span>
        <span className="background-process-detail">{process.detail}</span>
       </a>)}</div>}
     {backgroundProcessesError&&<small className="background-process-warning">{backgroundProcessesError}</small>}
    </div>}
   </div>
  </div>
</header>
 
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
 <div className="project-grid">{projects.map(p=><a key={p.id} href={projectUrl(p.id)} className="project-card" onClick={e=>followLink(e,projectUrl(p.id))}><div className="project-symbol">{p.name.slice(0,1).toUpperCase()}</div><h3>{p.name}</h3><p>{p.description||'Описание проекта пока не добавлено'}</p><span>Открыть проект <ArrowRight size={16}/></span></a>)}{projects.length===0&&<div className="empty">Пока нет проектов. Создайте первый, чтобы начать работу.</div>}</div></div>
 :<div className={section==='tasks'?'page tasks-page':'page compact-project-page'}>
 {section==='overview'&&<div className="overview"><div className="panel"><h3>О проекте</h3><p>{selected.description||'Описание пока отсутствует.'}</p></div><div className="stats">{stages.map(s=><div className="stat" key={s.stage}><b>{tasks.filter(t=>t.stage===s.stage).length}</b><span>{s.label}</span></div>)}</div></div>}
 {section==='tasks'&&<><div className="toolbar"><input className="search" aria-label="Поиск по задачам" placeholder="Поиск по задачам…" value={search} onChange={e=>setSearch(e.target.value)}/><div className="segmented"><button className={view==='board'?'chosen':''} onClick={()=>setView('board')}><Columns3 size={16}/> Канбан</button><button className={view==='list'?'chosen':''} onClick={()=>setView('list')}><List size={16}/> Список</button></div><div className="task-create-actions"><button className="primary create-task" onClick={()=>{setForm({...form,title:'',description:'',type:'task',parent_id:''});setShowTask(true);}}><Plus size={17}/> Создать задачу</button><button className="primary create-task-text" type="button" title="Создать задачу текстом через AI" aria-label="Создать задачу текстом" onClick={()=>{setProjectInput(old=>old.trim()?old:'Создай задачу: ');setProjectChatOpen(true);}}><FileText size={17}/></button></div></div>
 {mergeReport&&<div className="panel merge-report">{mergeReport}</div>}{documentationNotice&&<div className="panel merge-report">{documentationNotice}</div>}{view==='board'?<div className="board board-groups">
 {kanbanGroups.map(group=>{
  const expanded=expandedGroups.includes(group.key);
  const count=filtered.filter(t=>group.stages.some(stage=>stage.stage===boardLaneFor(t))).length+(group.key==='analytics'?docQuestions.length:0);
  return <section key={group.key} className={'kanban-group '+(expanded?'is-expanded':'is-collapsed')} style={{['--kanban-stage-count' as string]:group.stages.length} as React.CSSProperties}>
   <button className="kanban-group-heading" type="button" aria-expanded={expanded} onClick={()=>toggleKanbanGroup(group.key)}
    title={expanded?'Свернуть этапы':'Развернуть этапы'}><span className="group-mark"/>
    <strong>{group.title}</strong><span className="group-stage-count">{group.stages.filter(stage=>stage.stage!==productOwnerLane.stage).length} эт.</span><span className="group-task-count">{count}</span>
    <ChevronDown size={16} className={'group-chevron '+(expanded?'expanded':'')}/>
   </button>
   {expanded?<div className="kanban-group-stages">{group.stages.map(stage=>renderKanbanLane(stage))}</div>:renderCollapsedGroup(group)}
  </section>;
 })}
 </div>:<div className="panel table-wrap"><table><thead><tr><th>Задача</th><th>Тип</th><th>Этап</th><th>Создана</th></tr></thead><tbody>{filtered.map(t=><tr key={t.id} onClick={()=>void openTask(t)}><td><a className="task-list-link" href={projectUrl(selected.id,'tasks')+'/'+t.id} onClick={e=>{e.stopPropagation();followLink(e,projectUrl(selected.id,'tasks')+'/'+t.id);}}><span className="task-name-line"><b>{t.title}</b>{agentWorking(t.id)&&<span className="agent-equalizer" role="status" aria-label="AI работает над задачей" title="AI выполняет задачу"><i/><i/><i/></span>}</span><small>#{t.display_number}</small></a></td><td>{t.type}</td><td>{stages.find(s=>s.stage===t.stage)?.label}</td><td>{new Date(t.created_at).toLocaleDateString('ru-RU')}</td></tr>)}</tbody></table></div>}</>}
 {section==='processes'&&<div className="process-center">
  <div className="process-center-heading"><div><h2>Центр процессов</h2><p className="muted">История работы AI и фоновых операций текущего проекта</p></div></div>
  <div className="process-center-filters">{([['all','Все'],['active','Активные'],['failed','Ошибки'],['completed','Завершённые']] as const).map(([value,label])=>
   <button key={value} className={processFilter===value?'selected':''} type="button" onClick={()=>setProcessFilter(value)}>{label}</button>)}</div>
  <div className="process-center-grid">
   <div className="panel process-list">
    {projectProcesses.filter(p=>processFilter==='all'||(processFilter==='active'?['queued','running'].includes(p.status):p.status===processFilter)).map(process=>
     <button type="button" key={process.id} className={'process-list-item '+(selectedProcessId===process.id?'selected':'')} onClick={()=>setSelectedProcessId(process.id)}>
      <span className="process-list-title">{['running','queued'].includes(process.status)&&process.kind==='testing'?
       <span className="agent-equalizer" aria-label="Тестировщик выполняет проверку" role="status"><i/><i/><i/></span>:
       <span className={'process-dot '+process.status}/>}<strong>{process.title}</strong></span>
      <small>{processStatus(process.status)} · {new Date(process.createdAt).toLocaleString('ru-RU')}</small>
      <span>{process.detail}</span>
     </button>)}
    {!projectProcesses.length&&<p className="muted process-empty">Процессов пока нет</p>}
   </div>
   <div className="panel process-detail">{(()=>{
    const process=projectProcesses.find(p=>p.id===selectedProcessId)||projectProcesses.find(p=>processFilter==='all'||(processFilter==='active'?['queued','running'].includes(p.status):p.status===processFilter));
    if(!process)return <div className="process-detail-empty"><Clock3 size={28}/><p>Выбери процесс слева, чтобы увидеть его результат и историю.</p></div>;
    return <>
     <div className="process-detail-header"><h3>{process.title}</h3><span className={'process-status '+process.status}>{processStatus(process.status)}</span></div>
     <p className="muted">{process.detail}</p>
     {process.kind==='document_import'&&<div className="process-metrics"><span>Файлов: {process.sourceFileCount??'—'}</span><span>Фрагментов: {process.progress?.completed??0} / {process.progress?.total??'—'}</span><span>Тем готово: {process.topicProgress?.completed??0} / {process.topicProgress?.total||'—'}</span><span>Сохранено страниц: {process.savedDocuments??0}</span></div>}
     {process.taskId&&<p className="process-source"><a href={projectUrl(selected.id,'tasks')+'/'+process.taskId} onClick={e=>followLink(e,projectUrl(selected.id,'tasks')+'/'+process.taskId)}>Открыть задачу и чат агента</a></p>}
     {process.sourceUrl&&<p className="process-source"><a href={process.sourceUrl} target="_blank" rel="noreferrer">Исходный репозиторий</a></p>}
     {process.result&&<div className="process-result"><strong>Результат</strong><p>{process.result.message||'Операция завершена'}</p>
      {process.result.created_document_id&&<button className="secondary" onClick={()=>navigate(projectUrl(selected.id,'docs')+'/'+process.result!.created_document_id)}>Открыть документацию</button>}
      {process.result.verdict&&<p><strong>Вердикт: {process.result.verdict==='passed'?'Проверки пройдены':process.result.verdict==='failed'?'Обнаружены ошибки':'Не удалось проверить'}</strong></p>}
      {process.result.commit&&<small>Проверенный коммит: {process.result.commit}</small>}
      {process.result.findings?.map((finding,i)=><p key={i}><strong>{finding.severity}:</strong> {finding.description}{finding.steps?' · '+finding.steps:''}</p>)}
      {process.result.checks?.map((check,i)=><p key={'check-'+i}>{check.name}: {check.result} · {check.details}</p>)}
      {process.result.prUrl&&<a href={process.result.prUrl} target="_blank" rel="noreferrer">Открыть PR</a>}
     </div>}
     {process.kind==='document_import'&&process.status==='failed'&&<div className="process-actions">
      <button className="secondary" disabled={processActionBusy} onClick={()=>void restartImport(process)}>Возобновить тот же импорт</button>
      <small>Готовые страницы сохранены; возобновление использует тот же процесс и пропускает завершённые темы.</small>
     </div>}
     {process.kind==='document_import'&&process.status==='running'&&<div className="process-instruction-box">
      <strong>Уточнить задание для AI</strong>
      <p>Сообщение будет учтено на следующем этапе анализа или формирования документов.</p>
      <textarea rows={3} value={processInstruction} onChange={e=>setProcessInstruction(e.target.value)} placeholder="Добавить требование или уточнить решение…"/>
      <button className="secondary" disabled={processActionBusy||!processInstruction.trim()} onClick={()=>void sendProcessInstruction(process)}>Отправить уточнение</button>
     </div>}
     <h4>Журнал событий</h4>
     {processEvents.length&&selectedProcessId===process.id?<div className="process-timeline">{processEvents.map(ev=><div className={'process-timeline-item '+ev.level} key={ev.id}><small>{new Date(ev.created_at).toLocaleString('ru-RU')} · {ev.stage}</small><div>{ev.detail}</div></div>)}</div>:
      <p className="muted">Для этого процесса подробный журнал пока отсутствует или загружается.</p>}
    </>;
   })()}</div>
  </div>
 </div>}
 {section==='docs'&&<div className="docs">
  <aside className="panel docs-list">
   <div className="docs-list-heading"><b>Страницы проекта</b><div className="docs-actions">
     <button type="button" title="Реорганизовать импортированные тематические страницы с аналитиком" aria-label="Реорганизовать структуру документации" onClick={()=>{setAnalystDocumentId(null);setProjectChatMode('documentation');setProjectInput('Улучши структуру документации: распредели импортированные тематические страницы по системным разделам и осмысленным группам. Не меняй тексты и ссылки.');setProjectChatOpen(true);}}><LayoutGrid size={17}/></button>
     <button type="button" disabled={docBusy} title="Добавить страницу в исходные материалы" onClick={()=>void addDoc()}><Plus size={18}/></button></div></div>
   <input className="docs-search-field" aria-label="Поиск по дереву документации" placeholder="Найти документ..." value={docSearch} onChange={e=>setDocSearch(e.target.value)}/><div className="doc-tree">{renderDocTree(null)}{!docs.length&&<p className="muted docs-tree-empty">Создай первую страницу документации.</p>}</div>
   {selected&&<KnowledgeInstructions projectId={selected.id} request={api}/>}\n   <div className="docs-list-footer">
    <button className="secondary" type="button" onClick={()=>void exportSpecification()}><BookOpen size={15}/> Скачать ТЗ (Markdown)</button>
    <button className="primary docs-discuss-button" type="button" onClick={openDocumentationChat}><MessageCircle size={16}/> Обсудить с аналитиком</button>
   </div>
  </aside>
  <section className="panel docs-reading">
   {selectedDocId&&docs.some(d=>d.id===selectedDocId)?(()=>{
    const doc=docs.find(d=>d.id===selectedDocId)!;
    return <>
     {knowledgeMeta&&<details className="panel knowledge-document-panel">
      <summary>Контекст и связи документа · {({approved:'Утверждён',draft:'Черновик',review:'На согласовании',obsolete:'Устарел'} as Record<string,string>)[knowledgeMeta.status]}</summary>
      <div className="doc-metadata-editor">
       <label>Статус знаний<select value={knowledgeMeta.status} onChange={e=>setKnowledgeMeta({...knowledgeMeta,status:e.target.value as typeof knowledgeMeta.status})}>
        <option value="approved">Утверждён</option><option value="draft">Черновик</option><option value="review">На согласовании</option><option value="obsolete">Устарел</option>
       </select></label>
       <label>Краткое описание<input value={knowledgeMeta.summary} maxLength={1500} onChange={e=>setKnowledgeMeta({...knowledgeMeta,summary:e.target.value})} placeholder="Что агент найдёт в документе"/></label>
       <label>Теги через запятую<input defaultValue={knowledgeMeta.tags.join(', ')} onBlur={e=>setKnowledgeMeta({...knowledgeMeta,tags:e.target.value.split(',').map(x=>x.trim()).filter(Boolean).slice(0,30)})}/></label>
       <button className="secondary" disabled={docBusy} onClick={()=>void saveKnowledgeMetadata()}>Сохранить метаданные</button>
      </div>
      <h4>Связанные документы</h4>
      {knowledgeRelated.map(link=><div className="knowledge-link" key={link.id}>
       <span>{link.relation}: </span><a href={selected?projectUrl(selected.id,'docs')+'/'+link.related_document_id:'#'} onClick={e=>followLink(e,projectUrl(selected!.id,'docs')+'/'+link.related_document_id)}>{link.title}</a>
       <button type="button" disabled={docBusy} title="Удалить связь" onClick={()=>void unlinkKnowledgeDocument(link.id)}><X size={14}/></button>
      </div>)}
      <div className="doc-metadata-editor">
       <select aria-label="Тип связи" value={knowledgeRelation} onChange={e=>setKnowledgeRelation(e.target.value)}>
        {['related_to','depends_on','implements','describes','supersedes','tested_by'].map(v=><option key={v} value={v}>{v}</option>)}
       </select>
       <select aria-label="Связанный документ" value={knowledgeTarget} onChange={e=>setKnowledgeTarget(e.target.value)}>
        <option value="">Выбрать документ</option>
        {docs.filter(x=>x.id!==doc.id).map(x=><option value={x.id} key={x.id}>{x.title}</option>)}
       </select>
       <button className="secondary" disabled={!knowledgeTarget||docBusy} onClick={()=>void linkKnowledgeDocument()}>Добавить связь</button>
      </div>
      <details><summary>История версий ({knowledgeVersions.length})</summary>
       {knowledgeVersions.map(v=><p key={v.id}><small>{new Date(v.created_at).toLocaleString('ru-RU')} · {v.excerpt}</small> <button className="secondary" type="button" disabled={docBusy} onClick={()=>void restoreKnowledgeVersion(v.id)}>Восстановить</button></p>)}
      </details>
     </details>}
     <header className="docs-reading-header">
      <div>{editingDoc?.id===doc.id&&!doc.system_key?
       <input className="docs-title-input" aria-label="Название документа" value={editingDoc.title} onChange={e=>setEditingDoc({...editingDoc,title:e.target.value})}/>:
       <h2>{doc.title}</h2>}
       <div className="doc-status-labels"><span>{docKindLabel(doc.document_kind)}</span><span>{implementationLabel(doc.implementation_status)}</span></div>
       {doc.implementation_evidence&&<small>Подтверждение: {doc.implementation_evidence}</small>}
       <small>Обновлено: {new Date(doc.updated_at).toLocaleString('ru-RU')}</small>
      </div>
      <div className="docs-actions">
       {editingDoc?.id===doc.id?<>
        <button className="secondary" type="button" disabled={docBusy} onClick={()=>setEditingDoc(null)}>Отмена</button>
        <button className="primary" type="button" disabled={docBusy||!editingDoc.title.trim()} onClick={()=>void saveDoc()}>Сохранить</button>
       </>:<>
        <button className="secondary docs-icon-button" type="button" title="Редактировать документ" aria-label="Редактировать документ" onClick={()=>setEditingDoc({...doc})}><Pencil size={17}/></button>
        {!doc.system_key&&<button className="secondary docs-icon-button docs-delete" type="button" disabled={docBusy} title="Удалить документ" aria-label="Удалить документ" onClick={()=>void deleteDoc(doc)}><Trash2 size={17}/></button>}
       </>}
      </div>
     </header>
     {docProposals.filter(proposal=>proposal.document_id===doc.id).map(proposal=><div className="docs-proposal" key={proposal.id}>
       <strong>Аналитик предложил изменение, сохранена ручная версия</strong>
       <p>Тема: {proposal.title}. Перед применением проверь обновлённый Markdown.</p>
       <details><summary>Посмотреть предложение</summary><DocumentMarkdown source={proposal.proposed_body}/></details>
       <div className="docs-actions">
        <button className="primary" disabled={processActionBusy} onClick={()=>void decideDocumentationProposal(proposal,'approve')}>Применить предложение</button>
        <button className="secondary" disabled={processActionBusy} onClick={()=>void decideDocumentationProposal(proposal,'reject')}>Отклонить</button>
       </div>
      </div>)}
      {editingDoc?.id===doc.id? <div className="docs-editing">
      {!doc.system_key&&<label>Расположение<select value={editingDoc.parent_id||''} onChange={e=>setEditingDoc({...editingDoc,parent_id:e.target.value||null})}>
              {docs.filter(d=>d.id!==doc.id).map(d=><option key={d.id} value={d.id}>{d.title}</option>)}
      </select></label>}
      <div className="doc-metadata-editor">
       <label>Тип документа<select value={editingDoc.document_kind} onChange={e=>setEditingDoc({...editingDoc,document_kind:e.target.value as Doc['document_kind']})}>
        <option value="technical">Техническая документация</option><option value="functional">Описание функциональности</option>
       </select></label>
       <label>Статус реализации<select value={editingDoc.implementation_status} onChange={e=>setEditingDoc({...editingDoc,implementation_status:e.target.value as Doc['implementation_status']})}>
        <option value="unverified">Не подтверждено</option><option value="planned">Запланировано</option><option value="partial">Реализовано частично</option><option value="implemented">Реализовано</option>
       </select></label>
       <label>Основание для статуса<input value={editingDoc.implementation_evidence||''} onChange={e=>setEditingDoc({...editingDoc,implementation_evidence:e.target.value})} placeholder="PR, задача, релиз или ручное подтверждение"/></label>
      </div>
      <label>Содержание (Markdown)
       <textarea className="docs-editor-area" rows={22} value={editingDoc.body} onChange={e=>setEditingDoc({...editingDoc,body:e.target.value})} placeholder="Введите текст документа…"/>
      </label>
     </div>:
     <div key={doc.id} className="docs-content">{doc.body.trim()?<DocumentMarkdown source={doc.body}/>:<p className="muted">Документ пуст. Нажми карандаш, чтобы добавить содержимое.</p>}</div>}
    </>;
   })():<div className="docs-empty"><BookOpen size={30}/><h3>Документация проекта</h3><p>Выбери страницу слева, чтобы прочитать её содержимое.</p></div>}
  </section>
 </div>}
 {section==='qa'&&<QaPanel projectId={selected.id} api={api} onError={fail}/>}
 {section==='settings'&&<section className="panel workflow-settings-panel">
  <div className="row-line">
   <div><h3>Workflow · Схема процесса</h3><p className="muted">Нажми на этап, чтобы настроить исполнителя, режим работы и инструкции.</p></div>
   <span className="workflow-key"><span className="workflow-key-line"/> Переходы</span>
  </div>
  <div className="workflow-diagram-scroll">
   <div className="workflow-diagram" role="group" aria-label="Последовательность этапов проекта">
    {stages.map((stage,i)=><React.Fragment key={stage.stage}>
      {i>0&&<div className="workflow-diagram-connector" tabIndex={0}
       aria-label={'Переход: '+stages[i-1].label+' → '+stage.label}
       data-tooltip={stages[i-1].label+' → '+stage.label}>
       <svg viewBox="0 0 28 14" width="28" height="14" aria-hidden="true">
        <path d="M 1 7 H 25 M 20 2 L 25 7 L 20 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
       </svg>
      </div>}
      <button type="button" className={'workflow-stage-card workflow-stage-'+stage.stage} onClick={()=>{setWorkflowModal({...stage});setWorkflowEditing(null);}}
       title={'Настройки этапа «'+stage.label+'»'}>
       <span className="workflow-stage-label">{stage.label}</span>
       <span className="workflow-stage-agent">{stage.agent_name||'Исполнитель не указан'}</span>
       <span className="workflow-stage-mode">{stage.mode==='automatic'?'Автоматически':stage.mode==='approval'?'С подтверждением':'Вручную'}</span>
       <Settings2 size={14} className="workflow-stage-icon"/>
      </button>
     </React.Fragment>)}
   </div>
   {stages.some(stage=>stage.stage==='testing')&&stages.some(stage=>stage.stage==='development')&&
    <div className="workflow-feedback" style={{width:stages.length*148+(stages.length-1)*28}}>
     {(()=>{
      const development=stages.findIndex(stage=>stage.stage==='development');
      const testing=stages.findIndex(stage=>stage.stage==='testing');
      const x1=development*176+74,x2=testing*176+74;
      const width=x2-x1+20;
      return <div className="workflow-feedback-link" tabIndex={0} role="img"
       aria-label="Возврат из тестирования в разработку при ошибках с замечаниями и повторной проверкой"
       style={{left:x1-10,width}}>
       <svg className="workflow-feedback-path" viewBox={`0 0 ${width} 30`} preserveAspectRatio="none" aria-hidden="true">
        <path d={`M ${width-10} 1 V 10 Q ${width-10} 23 ${width-23} 23 H 23 Q 10 23 10 10 V 1`}
         fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M 5 8 L 10 1 L 15 8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
       </svg>
       <div className="workflow-feedback-tooltip" role="tooltip">
        <RotateCcw size={13}/> Тестирование → Разработка: найденные ошибки, замечания и повторная проверка
       </div>
      </div>;
     })()}
    </div>}
  </div>
  <p className="muted workflow-note">Схема отображает основные этапы и предусмотренный возврат на доработку. Редактирование имени агента и инструкций не изменяет самостоятельно правила переходов Temporal.</p>
 </section>}
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
 
 
 </div>}
 </main>
 {selected&&!accountSettings&&!activeTask&&!showTask&&!showProject&&!showConnection&&<>
  {projectChatOpen&&<section className="project-chat" aria-label="Чат проекта">
   <header className="project-chat-heading"><div><strong>{projectChatMode==='documentation'?'Аналитик проекта':'Менеджер проекта'}</strong><small>{aiSettings.model}</small></div><button onClick={()=>setProjectChatOpen(false)} title="Свернуть чат"><X size={17}/></button></header>
   <div ref={projectThreadRef} className="assistant-thread" role="log" aria-live="polite">
    {projectMessages.length===0&&<p className="assistant-hint">{projectChatMode==='documentation'?'Опиши проект, прикрепи текстовые файлы или пришли ссылку на папку либо Markdown-файл в GitHub. Я составлю ТЗ и задам вопросы, если понадобится твоё решение.':'Напиши, например: «Создай задачу на добавление поиска по документации».'}</p>}
    {projectMessages.map(m=><div className={'assistant-bubble '+(m.role==='user'?'mine':'bot')} key={m.id}>
      <span className="assistant-author">{projectChatMode==='documentation'?(m.role==='user'?'Вы → Аналитику':'Аналитик → Вам'):(m.role==='user'?(addressedAgent(m.body)?'Вы → '+addressedAgent(m.body):'Вы → Менеджеру проекта'):(addressedAgent(m.body)?addressedAgent(m.body)+' → Вам':'Менеджер проекта → Вам'))}</span>
      <div>{m.body}</div>
      {m.id===projectPendingId&&projectChatBusy&&<small className="chat-message-status">Codex обрабатывает сообщение…</small>}
      {m.failed&&<small className="chat-message-status chat-message-failed">Не удалось отправить. <button type="button" className="textbtn" disabled={projectChatBusy} onClick={()=>{setProjectInput(m.body.replace(/\n\nМатериалы: [^\n]+$/,'').trim());projectInputRef.current?.focus();}}>Повторить сообщение</button></small>}
      {m.created_task_id&&<button className="textbtn" onClick={()=>{const t=tasks.find(t=>t.id===m.created_task_id);if(t)void openTask(t);}}>Открыть созданную задачу</button>}
      {m.created_document_id&&<button className="textbtn" onClick={()=>{if(selected&&m.created_document_id)navigate(projectUrl(selected.id,'docs')+'/'+m.created_document_id);setProjectChatOpen(false);}}>Открыть документ</button>}
    </div>)}
    {projectChatBusy&&<p className="assistant-hint">{projectImportProgress||'Codex готовит ответ…'}</p>}
   </div>
   {projectChatMode==='documentation'&&(analystDocumentId||analystFiles.length>0)&&<div className="analyst-materials">
    {analystDocumentId&&<span>Раздел: {docs.find(doc=>doc.id===analystDocumentId)?.title||'Выбранная страница'}
     <button type="button" aria-label="Снять выбор раздела" onClick={()=>setAnalystDocumentId(null)} disabled={projectChatBusy}><X size={13}/></button></span>}
    {analystFiles.map((file,index)=><span key={file.name+'-'+index}>{file.name}
     <button type="button" aria-label={'Убрать '+file.name} disabled={projectChatBusy} onClick={()=>setAnalystFiles(current=>current.filter((_,i)=>i!==index))}><X size={13}/></button></span>)}
   </div>}
   <form className="assistant-composer" onSubmit={sendProjectMessage}>
    {projectChatMode==='documentation'&&<>
     <input hidden type="file" ref={analystFileInput} multiple accept=".md,.txt,.csv,.json,.yaml,.yml" onChange={e=>{attachAnalystFiles(e.currentTarget.files);e.currentTarget.value='';}}/>
     <button className="secondary" type="button" aria-label="Прикрепить материалы" title="Прикрепить материалы" disabled={projectChatBusy} onClick={()=>analystFileInput.current?.click()}><Paperclip size={16}/></button>
    </>}
    {mentionMatches(projectInput,stages).length>0&&<div className="agent-mention-menu" role="listbox" aria-label="Выбрать агента">
      {mentionMatches(projectInput,stages).map(option=><button type="button" role="option" aria-selected={false} key={option.alias} onClick={()=>{setProjectInput(addMention(projectInput,option.alias));projectInputRef.current?.focus();}}>
       <strong>@{option.alias}</strong><small>{stages.find(s=>s.stage===option.stage)?.agent_name||option.alias}</small></button>)}
     </div>}
     <textarea ref={projectInputRef} rows={2} value={projectInput} onChange={e=>setProjectInput(e.target.value)} placeholder={projectChatMode==='documentation'?'Опиши функциональность или укажи источник документации…':'Сообщение, задача или документ… (Shift+Enter — новая строка)'} aria-label={projectChatMode==='documentation'?'Сообщение аналитику':'Сообщение Менеджеру проекта'} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}/>
    <button className="primary assistant-send-icon" title="Отправить сообщение" aria-label="Отправить сообщение" disabled={projectChatBusy||(!projectInput.trim()&&(projectChatMode!=='documentation'||!analystFiles.length))||!aiSettings.enabled} type="submit"><Send size={17}/></button>
   </form>
   {!aiSettings.enabled&&<p className="assistant-disabled">Включи AI в настройках проекта.</p>}
  </section>}
  <button className="chat-fab" onClick={()=>{if(projectChatMode==='documentation'){setProjectChatMode('project');setProjectChatOpen(true);}else setProjectChatOpen(open=>!open);}} title={projectChatOpen&&projectChatMode==='project'?'Закрыть чат':'Открыть чат Менеджера проекта'} aria-label={projectChatOpen?'Закрыть чат':'Открыть чат Менеджера проекта'}>
   {projectChatOpen&&projectChatMode==='project'?<X size={22}/>:<MessageCircle size={22}/>}
  </button>
 </>}
 {workflowModal&&selected&&<div className="overlay workflow-stage-overlay" onMouseDown={()=>{if(!workflowSaving)setWorkflowModal(null);}}>
  <div className="dialog workflow-stage-dialog" role="dialog" aria-modal="true" aria-label={'Настройки этапа '+workflowModal.label} onMouseDown={e=>e.stopPropagation()}>
   <div className="modal-heading"><h2>{workflowModal.label}</h2><button className="task-close" type="button" onClick={()=>setWorkflowModal(null)} aria-label="Закрыть"><X size={19}/></button></div>
   <p className="muted workflow-modal-subtitle">Этап <code>{workflowModal.stage}</code> · Порядок в процессе: {workflowModal.position+1}</p>
   <div className="workflow-detail-field">
    <div className="workflow-field-heading"><strong>Исполнитель / имя агента</strong>
     <button type="button" className="workflow-field-pencil" onClick={()=>setWorkflowEditing(workflowEditing==='agent'?null:'agent')}
      aria-label="Редактировать имя агента" title="Редактировать имя агента"><Pencil size={15}/></button>
    </div>
    {workflowEditing==='agent'?<input autoFocus value={workflowModal.agent_name} maxLength={100}
      onChange={e=>setWorkflowModal({...workflowModal,agent_name:e.target.value})} placeholder="Например: AI-тестировщик"/>:
      <div className="workflow-field-value">{workflowModal.agent_name||'Не назначен'}</div>}
   </div>
   <div className="workflow-detail-field">
    <div className="workflow-field-heading"><strong>Режим выполнения</strong>
     <button type="button" className="workflow-field-pencil" onClick={()=>setWorkflowEditing(workflowEditing==='mode'?null:'mode')}
      aria-label="Редактировать режим выполнения" title="Редактировать режим"><Pencil size={15}/></button>
    </div>
    {workflowEditing==='mode'?<select autoFocus value={workflowModal.mode} onChange={e=>setWorkflowModal({...workflowModal,mode:e.target.value as Stage['mode']})}>
     <option value="manual">Ручной</option><option value="approval">С подтверждением</option><option value="automatic">Автоматический</option>
    </select>:<div className="workflow-field-value">{workflowModal.mode==='automatic'?'Автоматический':workflowModal.mode==='approval'?'С подтверждением':'Ручной'}</div>}
   </div>
   <div className="workflow-detail-field">
    <div className="workflow-field-heading"><strong>Инструкции агента</strong>
     <button type="button" className="workflow-field-pencil" onClick={()=>setWorkflowEditing(workflowEditing==='instructions'?null:'instructions')}
      aria-label="Редактировать инструкции агента" title="Редактировать инструкции"><Pencil size={15}/></button>
    </div>
    {workflowEditing==='instructions'?<textarea autoFocus rows={9} maxLength={12000} value={workflowModal.agent_instructions}
     onChange={e=>setWorkflowModal({...workflowModal,agent_instructions:e.target.value})}
     placeholder="Цели, критерии качества, обязательные проверки и правила этапа…"/>:
     <div className="workflow-field-value workflow-instructions-readonly">{workflowModal.agent_instructions||'Инструкции пока не указаны'}</div>}
   </div>
   <small className="muted workflow-agent-notice">Инструкции используются соответствующим AI-агентом. Системные ограничения имеют приоритет.</small>
   {workflowModal.stage==='testing'&&<p className="workflow-transition-description"><RotateCcw size={14}/> Если обнаружены ошибки, задача вернётся в разработку с замечаниями. Затем тесты выполнятся повторно.</p>}
   {workflowModal.stage==='development'&&<p className="workflow-transition-description">После успешной разработки задача передаётся на тестирование.</p>}
   <footer><button className="secondary" type="button" onClick={()=>setWorkflowModal(null)}>Закрыть</button>
    <button className="primary" type="button" disabled={workflowSaving||!workflowModal.agent_name.trim()} onClick={()=>void saveWorkflowStage()}>{workflowSaving?'Сохранение…':'Сохранить'}</button></footer>
  </div>
 </div>}
 {showProject&&<div className="overlay" onMouseDown={()=>setShowProject(false)}><form className="dialog" onMouseDown={e=>e.stopPropagation()} onSubmit={createProject}><div className="modal-heading"><h2>Новый проект</h2><button type="button" onClick={()=>setShowProject(false)}><X/></button></div><label>Название<input required value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label><label>Описание<textarea value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></label><footer><button type="button" className="secondary" onClick={()=>setShowProject(false)}>Отмена</button><button className="primary" disabled={busy}>Создать</button></footer></form></div>}
 {showTask&&<div className="overlay" onMouseDown={()=>setShowTask(false)}><form className="dialog" onMouseDown={e=>e.stopPropagation()} onSubmit={createTask}><div className="modal-heading"><h2>Новая задача</h2><button type="button" onClick={()=>setShowTask(false)}><X/></button></div><label>Название<input required value={form.title} onChange={e=>setForm({...form,title:e.target.value})}/></label><label>Тип<select value={form.type} onChange={e=>setForm({...form,type:e.target.value})}><option value="task">Задача</option><option value="bug">Ошибка</option><option value="improvement">Улучшение</option><option value="epic">Эпик</option></select></label><label>Родительская задача<select value={form.parent_id} onChange={e=>setForm({...form,parent_id:e.target.value})}><option value="">Нет</option>{tasks.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></label><label>Описание<textarea rows={5} value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></label><footer><button type="button" className="secondary" onClick={()=>setShowTask(false)}>Отмена</button><button className="primary" disabled={busy}>Создать задачу</button></footer></form></div>}
 {activeTask&&<div className="overlay task-modal-overlay" onMouseDown={()=>{if(!editingField&&selected)navigate(projectUrl(selected.id,'tasks'));}}>
  <div className="dialog task-dialog task-dialog-wide" role="dialog" aria-modal="true" aria-label={'Задача #'+activeTask.display_number+': '+activeTask.title} onMouseDown={e=>e.stopPropagation()}>
   <div className="task-modal-top">
    <span className="eyebrow">ЗАДАЧА #{activeTask.display_number}</span>
    <div className="task-modal-actions">
     <span className="task-stage-label">{stages.find(x=>x.stage===activeTask.stage)?.label||activeTask.stage}</span>
     {!['documentation','done'].includes(activeTask.stage)&&
      <button className="secondary" type="button" disabled={cancelBusy} onClick={()=>void showTaskCancellation()}>Отменить задачу</button>}
     <button className="task-close" type="button" onClick={()=>{if(selected)navigate(projectUrl(selected.id,'tasks'));}} title="Закрыть задачу" aria-label="Закрыть задачу"><X size={20}/></button>
    </div>
   </div>
   {cancelPreview&&<div className="task-command-expansion task-cancel-confirm task-cancel-header">
    <strong>Отменить задачу #{cancelPreview.task.display_number} и очистить её артефакты?</strong>
    <p>GitHub PR будет закрыт (история PR сохранится), UUID-ветка удалена. Удаляются {cancelPreview.stats.qa_plans} планов, до {cancelPreview.stats.qa_cases} кейсов, до {cancelPreview.stats.qa_flows} сценариев и {cancelPreview.stats.documents} собственных документов. Общие данные останутся.</p>
    {cancelPreview.warnings?.map((warning,i)=><p key={i}>{warning}</p>)}
    {cancelPreview.blocked.length>0&&<p className="task-action-error">{cancelPreview.blocked.join('; ')}</p>}
    {cancelError&&<p className="task-action-error">{cancelError}</p>}
    <div className="task-action-buttons">
     <button type="button" className="secondary" onClick={()=>{setCancelPreview(null);setCancelError('');}}>Не отменять</button>
     <button type="button" className="task-action-danger" disabled={cancelBusy||cancelPreview.blocked.length>0} onClick={()=>void confirmTaskCancellation()}>{cancelBusy?'Очистка…':'Да, отменить и очистить'}</button>
    </div>
   </div>}
   {cancelError&&!cancelPreview&&<p className="task-cancel-header task-action-error" role="alert">{cancelError}</p>}
   <div className="task-dialog-columns">
    <section className="task-details">
     <div className="task-editable task-title-editable">
      {editingField==='title'?
       <input autoFocus value={activeTask.title} onChange={e=>setActiveTask({...activeTask,title:e.target.value})}
        onBlur={e=>void autoSaveField('title',e.currentTarget.value)}
        onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();e.currentTarget.blur();}if(e.key==='Escape'){e.stopPropagation();setEditingField(null);}}}/>:
       <><h2>{activeTask.title}</h2><button className="pencil" title="Изменить название" onClick={()=>setEditingField('title')}><Pencil size={15}/></button></>}
     </div>
     {savingField&&<small className="muted">Сохранение…</small>}
     <div className="task-editable task-description-editable">
      <div className="task-field-label">Описание / техническое задание</div>
      {editingField==='description'?
       <textarea autoFocus rows={17} value={activeTask.description} onChange={e=>setActiveTask({...activeTask,description:e.target.value})}
        onBlur={e=>void autoSaveField('description',e.currentTarget.value)}/>:
       <><div className="task-readonly">{activeTask.description||'Описание пока пустое'}</div>
        <button className="pencil" title="Изменить описание" onClick={()=>setEditingField('description')}><Pencil size={15}/></button></>}
     </div>
     <div className="task-metadata">
      {selected&&<a href={projectUrl(selected.id,'qa')} onClick={e=>followLink(e,projectUrl(selected.id,'qa'))}>Тест-кейсы и сценарии проекта</a>}

      <span>Модель: <strong>{aiSettings.model}</strong></span>
     </div>
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
     {!!activeTask.related_task_ids?.length&&<p className="muted">Связанные задачи: {activeTask.related_task_ids.map(id=>tasks.find(t=>t.id===id)?('#'+tasks.find(t=>t.id===id)!.display_number+' · '+tasks.find(t=>t.id===id)!.title):id.slice(0,8)).join(', ')}</p>}
     {activeTask.pr_base_branch&&<div className="task-git-ref"><span>База PR</span><code>{activeTask.pr_base_branch}</code></div>}
     {activeTask.git_branch&&<div className="task-git-ref"><span>Ветка</span><code>{activeTask.git_branch}</code></div>}
     {activeTask.pr_url&&<div className="task-git-ref"><span>Pull Request</span><a href={activeTask.pr_url} target="_blank" rel="noreferrer">Открыть PR в GitHub</a></div>}
     {activeTask.stage==='documentation'&&<p className="muted">PR уже слит. Задача ожидает обновления проектной документации.</p>}
    </section>
    <aside className="task-conversation manager-conversation">
     <header><MessageCircle size={17}/><strong>Менеджер проекта</strong>
      <small>{decisions.length?'Ожидает вашего решения':activeAgentRuns.length||managerWorking?'Команда работает':'Контролирует процесс'}</small>
     </header>
     <div ref={taskThreadRef} className="assistant-thread manager-thread" role="log" aria-live="polite">
      {!managerState?.messages.length&&<p className="assistant-hint">Менеджер проекта координирует аналитика, разработчика и тестировщика. Все вопросы и решения для вас поступают только от него.</p>}
      <details className="manager-internal-log">
       <summary>Внутренняя переписка команды и технический журнал ({timeline(activeTask.id).length})</summary>
       <p>Здесь отображаются рабочие сообщения и технические события команды.</p>
       {['testing','development'].includes(activeTask.stage)&&!managerState?.owner&&!managerWorking&&!activeAgentRuns.length&&!decisions.length&&!deferredQa.length&&
        <button className="secondary" type="button" disabled={managerBusy} onClick={()=>void resumeAsManager()}>Продолжить / восстановить работу</button>}
       {deferredQa.map(request=><button key={request.id} type="button" className="secondary" disabled={managerBusy}
        onClick={()=>void decideAsManager(request,'approve_without_visual')}>Разрешить слияние без визуальных проверок</button>)}
       {timeline(activeTask.id).slice(-90).map(item=><div className="manager-internal-entry" key={item.id}>
        <strong>{item.title|| (item.kind==='user'?'Историческое сообщение пользователя':item.kind==='assistant'?'Предыдущий AI-помощник':'Этап работы')}</strong>
        <small>{new Date(item.time).toLocaleString('ru-RU')}</small>
        <div>{item.text}</div>
       </div>)}
      </details>
      {chatEntries.map(m=>'kind' in m?<div className="manager-message from-manager" key={m.kind+'-'+m.id}>
       <div className="manager-message-heading">
        <strong>{agentRunLabels[m.kind].name} · {m.status==='failed'?'Ошибка':'Итог'}</strong>
        <small>{new Date(m.completed_at||m.created_at).toLocaleString('ru-RU')}</small>
       </div>
       <div className="manager-message-body">{m.summary||(m.status==='failed'?'Работа завершилась с ошибкой.':'Работа завершена.')}</div>
       {m.link&&<a href={m.link} target="_blank" rel="noreferrer">Открыть PR</a>}
      </div>:<div className={'manager-message '+(m.role==='user'?'from-user':'from-manager')} key={m.id}>
       <div className="manager-message-heading">
        <strong>{m.role==='user'?'Вы → Менеджеру проекта':'Менеджер проекта → Вам'}</strong>
        <small>{new Date(m.created_at).toLocaleString('ru-RU')}</small>
       </div>
       <div className="manager-message-body">{m.body}</div>
       {m.role==='user'&&m.status==='failed'&&<div className="manager-message-error">
        Не удалось обработать запрос. Сообщение сохранено.
        <button type="button" className="secondary" disabled={managerBusy} onClick={()=>void retryManagerMessage(m.id)}>Повторить</button>
       </div>}
      </div>)}

     </div>
     {(activeAgentRuns.length>0||managerWorking)&&<ul className="manager-live-activity" aria-label="Текущая работа команды" aria-live="polite">
      {activeAgentRuns.map(run=><li key={run.kind+'-'+run.id}><LoaderCircle size={14} aria-hidden="true"/>
       {run.status==='queued'?'В очереди · '+agentRunLabels[run.kind].name:agentRunLabels[run.kind].active}</li>)}
      {managerWorking&&<li><LoaderCircle size={14} aria-hidden="true"/>Менеджер обрабатывает сообщение</li>}
     </ul>}
     {(decisions.some(request=>request.kind!=='analysis_clarifications')||readyForDevelopment)&&<div className="task-command-strip manager-actions" aria-label="Решения Менеджера проекта">
      <div className="manager-action-row">
       {readyForDevelopment&&<>
        <button className="primary" type="button" disabled={taskChatBusy||managerWorking||!gitLink||!aiSettings.enabled}
         onClick={()=>void approveDevelopment(activeTask)}>{taskChatBusy?'Запуск…':'В разработку'}</button>
        {!gitLink&&<small>Подключи GitHub-репозиторий в настройках проекта.</small>}
        {gitLink&&!aiSettings.enabled&&<small>Включи AI в настройках проекта.</small>}
       </>}
       {decisions.map(request=><React.Fragment key={request.id}>
        {request.kind==='qa_visual'&&<>
         <button className="primary" type="button" disabled={managerBusy} onClick={()=>void decideAsManager(request,'approve_without_visual')}>Разрешить без визуальных проверок</button>
         <button className="secondary" type="button" disabled={managerBusy} onClick={()=>void decideAsManager(request,'wait_for_tools')}>Ждать инструменты</button>
        </>}
        {request.kind==='requirements'&&<>
         <button className="primary" type="button" disabled={managerBusy} onClick={()=>void decideAsManager(request,'approve_requirements')}>Согласовать изменение ТЗ</button>
         <button className="secondary" type="button" disabled={managerBusy} onClick={()=>void decideAsManager(request,'reject_requirements')}>Отклонить изменение</button>
        </>}
        {request.kind==='question'&&<details className="manager-answer-popover">
         <summary>Ответить менеджеру</summary>
         <div className="manager-answer-body">
          <strong>Менеджер проекта спрашивает</strong>
          <p>{String(request.payload?.question||'')}</p>
          <textarea value={managerAnswer} rows={3} onChange={e=>setManagerAnswer(e.target.value)} placeholder="Ваш ответ менеджеру проекта"/>
          <button className="primary" type="button" disabled={managerBusy||managerAnswer.trim().length<3} onClick={()=>void decideAsManager(request,'answer')}>Отправить ответ</button>
         </div>
        </details>}
       </React.Fragment>)}
      </div>
     </div>}
     {managerFeedback&&<p className="manager-action-error" role="alert">{managerFeedback}</p>}
     <form className="assistant-composer" onSubmit={sendTaskMessage}>
      {mentionMatches(taskInput,stages).length>0&&<div className="agent-mention-menu" role="listbox" aria-label="Выбрать агента">
        {mentionMatches(taskInput,stages).map(option=><button type="button" role="option" aria-selected={false} key={option.alias} onClick={()=>setTaskInput(addMention(taskInput,option.alias))}>
         <strong>@{option.alias}</strong><small>{stages.find(s=>s.stage===option.stage)?.agent_name||option.alias}</small></button>)}
       </div>}
       <textarea rows={2} value={taskInput} onChange={e=>setTaskInput(e.target.value)}
       onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}
       placeholder={awaitingAnalysisAnswer?'Ответьте на вопросы аналитика…':'Напишите Менеджеру проекта… (Shift+Enter — новая строка)'} aria-label="Сообщение Менеджеру проекта" />
      <button className="primary" type="submit" disabled={managerSending||!taskInput.trim()||!aiSettings.enabled}><Send size={15}/> Отправить</button>
     </form>
    </aside>
   </div>
   <div className="task-workflow" aria-label="Этапы выполнения">
    {stages.map((stage,i)=><React.Fragment key={stage.stage}>
     {i>0&&<button className="workflow-arrow" disabled={!canAdvance(activeTask,stages[i-1].stage,stage.stage)}
       title={canAdvance(activeTask,stages[i-1].stage,stage.stage)?'Перейти: '+stage.label:'Для этого перехода нужны выполненные условия предыдущего этапа'}
       onClick={()=>void advanceTask(activeTask,stages[i-1].stage,stage.stage)}><ArrowRight size={18}/></button>}
     <div className={'workflow-step '+(stage.stage===activeTask.stage?'current'+((activeTask.stage==='testing'?!!taskOrchestration||!!activeTestFor(activeTask.id):agentWorking(activeTask.id))?' working':' idle'):stages.findIndex(x=>x.stage===stage.stage)<stages.findIndex(x=>x.stage===activeTask.stage)?'passed':'pending')}>
      {stage.stage===activeTask.stage?(activeTask.stage==='done'?<CheckCircle2 size={16}/>:((activeTask.stage==='testing'?!!taskOrchestration||!!activeTestFor(activeTask.id):agentWorking(activeTask.id))?<LoaderCircle size={16}/>:<Clock3 size={16}/>)):stages.findIndex(x=>x.stage===stage.stage)<stages.findIndex(x=>x.stage===activeTask.stage)?<CheckCircle2 size={16}/>:<Clock3 size={16}/>}
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
