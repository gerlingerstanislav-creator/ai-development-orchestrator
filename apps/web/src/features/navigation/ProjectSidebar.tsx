import React from 'react';
import {ChevronDown,LayoutGrid,CheckCircle2,Plus,LoaderCircle,Square,Play,Columns3,
 BookOpen,ClipboardList,Clock3,Users,Workflow,Settings2,ArrowRightCircle} from 'lucide-react';
import {projectUrl,type ProjectSection} from './routes.js';

export type SidebarProject={
 id:string;name:string;is_owner?:boolean;agents_running?:boolean;
};
type Props={
 selected:SidebarProject|null;
 projects:SidebarProject[];
 section:ProjectSection;
 projectMenuOpen:boolean;
 onToggleProjectMenu:()=>void;
 onCloseProjectMenu:()=>void;
 agentToggleBusy:boolean;
 onToggleProjectAgents:()=>void;
 onFollowLink:(event:React.MouseEvent<HTMLAnchorElement>,path:string)=>void;
 onCreateProject:()=>void;
 accountSettings:boolean;
 onLogout:()=>void;
};
/** Navigation is a pure view. Project selection and permissions remain owned
 * by the top-level app; links use its established router callbacks.
 */
export function ProjectSidebar({
 selected,projects,section,projectMenuOpen,onToggleProjectMenu,onCloseProjectMenu,
 agentToggleBusy,onToggleProjectAgents,onFollowLink,onCreateProject,accountSettings,onLogout
}:Props){
 return (
 <aside className="sidebar"><div className="brand"><span className="logo-icon">◈</span><span>Orchestrator<small>WORKSPACE</small></span></div>
  <div className="sidebar-projects">
   <div className="project-selector-row">
    <button type="button" className="project-selector" aria-expanded={projectMenuOpen} aria-label="Выбрать проект" onClick={()=>onToggleProjectMenu()}>
     <span className="project-selector-title">{selected?.name||'Выбрать проект'}</span><ChevronDown size={17} className={projectMenuOpen?'rotate':''}/>
    </button>
    {selected&&<button type="button" className={'project-agent-toggle '+(projects.find(p=>p.id===selected.id)?.agents_running?'running':'stopped')}
      aria-label={projects.find(p=>p.id===selected.id)?.agents_running?'Остановить запуск агентов проекта':'Запустить агентов проекта'}
      title={projects.find(p=>p.id===selected.id)?.agents_running?'Остановить запуск новых задач проекта (уже исполняемые завершаются)':'Запустить агентов проекта и продолжить очередь'}
      disabled={agentToggleBusy||!selected.is_owner} onClick={()=>void onToggleProjectAgents()}>
      {agentToggleBusy?<LoaderCircle size={15} className="spin"/>:projects.find(p=>p.id===selected.id)?.agents_running?<Square size={15} fill="currentColor"/>:<Play size={15} fill="currentColor"/>}
    </button>}
   </div>
   {projectMenuOpen&&<div className="project-menu">
    <a href="/projects" onClick={e=>{onCloseProjectMenu();onFollowLink(e,'/projects');}}><LayoutGrid size={15}/> Все проекты</a>
    {projects.map(p=><a key={p.id} href={projectUrl(p.id)} className={selected?.id===p.id?'selected':''} onClick={e=>{onCloseProjectMenu();onFollowLink(e,projectUrl(p.id));}}><span className="project-menu-name">{p.name}</span>{selected?.id===p.id&&<CheckCircle2 size={15}/>}</a>)}
    <button type="button" onClick={()=>{onCloseProjectMenu();onCreateProject();}}><Plus size={15}/> Новый проект</button>
   </div>}
  </div>
  <div className="sidebar-nav">
  {selected?<><div className="sidebar-label">ПРОЕКТ</div>
   {([['overview','Обзор',LayoutGrid],['tasks','Задачи',Columns3],['docs','Документация',BookOpen],['plan','План разработки',ClipboardList],['qa','Тестирование',CheckCircle2],['processes','Процессы',Clock3],['team','Команда',Users],['workflow','Workflow',Workflow],['settings','Настройки проекта',Settings2]] as const).map(([k,label,Icon])=><a key={k} href={projectUrl(selected.id,k)} className={'nav '+(section===k?'active':'')} onClick={e=>onFollowLink(e,projectUrl(selected.id,k))}><Icon size={18}/>{label}</a>)}
  </>:<a href="/projects" className="nav active" onClick={e=>onFollowLink(e,'/projects')}><LayoutGrid size={18}/> Мои проекты</a>}
  </div>
  <div className="sidebar-bottom">
   <span className="avatar">AD</span><span className="account-name">Администратор</span>
   <a href="/account/settings" className={'account-settings-button '+(accountSettings?'active':'')} onClick={e=>onFollowLink(e,'/account/settings')} title="Настройки профиля" aria-label="Настройки профиля"><Settings2 size={18}/></a>
   <button className="logout-button" onClick={onLogout} title="Выйти" aria-label="Выйти"><ArrowRightCircle size={17}/></button>
  </div>
 </aside>
 );
}
