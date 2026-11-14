import React from 'react';
import {ArrowLeft,ArrowRight,Plus,Trash2,RotateCcw} from 'lucide-react';
import {projectUrl} from '../navigation/routes.js';

export type ProjectListItem={
 id:string;name:string;description:string;is_owner?:boolean;
};
export type TrashedProjectItem={
 id:string;name:string;description:string;deleted_at:string;
};
type Props={
 projects:ProjectListItem[];
 trashedProjects:TrashedProjectItem[];
 showTrash:boolean;
 projectDeleteBusy:boolean;
 onToggleTrash:()=>void;
 onCreateProject:()=>void;
 onRestoreProject:(project:TrashedProjectItem)=>void;
 onPermanentlyDeleteProject:(project:TrashedProjectItem)=>void;
 onMoveProjectToTrash:(project:ProjectListItem)=>void;
 onFollowLink:(event:React.MouseEvent<HTMLAnchorElement>,path:string)=>void;
};
/** Workspace project discovery and trash view.
 * Mutations, confirmation dialogs, routing and loading remain in App.
 */
export function ProjectListPage({
 projects,trashedProjects,showTrash,projectDeleteBusy,
 onToggleTrash,onCreateProject,onRestoreProject,onPermanentlyDeleteProject,
 onMoveProjectToTrash,onFollowLink
}:Props){
 return (
<div className="page"><div className="page-heading"><div><span className="eyebrow">WORKSPACE</span><h1>{showTrash?'Корзина проектов':'Мои проекты'}</h1><p>{showTrash?'Проекты можно восстановить или удалить безвозвратно. Репозитории GitHub не затрагиваются.':'Создавайте проекты и управляйте разработкой в одном месте.'}</p></div><div className="project-page-actions"><button className="secondary" type="button" onClick={onToggleTrash}>{showTrash?<><ArrowLeft size={16}/> Мои проекты</>:<><Trash2 size={16}/> Корзина ({trashedProjects.length})</>}</button>{!showTrash&&<button className="primary" onClick={onCreateProject}><Plus size={17}/> Новый проект</button>}</div></div>
 {showTrash?<div className="project-grid">{trashedProjects.map(p=><div key={p.id} className="project-card project-card-trashed"><div className="project-symbol">{p.name.slice(0,1).toUpperCase()}</div><h3>{p.name}</h3><p>{p.description||'Описание проекта пока не добавлено'}</p><small className="muted">В корзине с {new Date(p.deleted_at).toLocaleString('ru-RU')}</small><div className="project-card-actions"><button type="button" className="secondary" disabled={projectDeleteBusy} onClick={()=>void onRestoreProject(p)}><RotateCcw size={15}/> Восстановить</button><button type="button" className="secondary project-danger-button" disabled={projectDeleteBusy} onClick={()=>void onPermanentlyDeleteProject(p)}><Trash2 size={15}/> Удалить навсегда</button></div></div>)}{trashedProjects.length===0&&<div className="empty">Корзина пуста.</div>}</div>
 :<div className="project-grid">{projects.map(p=><div key={p.id} className="project-card project-card-active"><a href={projectUrl(p.id)} className="project-card-link" onClick={e=>onFollowLink(e,projectUrl(p.id))}><div className="project-symbol">{p.name.slice(0,1).toUpperCase()}</div><h3>{p.name}</h3><p>{p.description||'Описание проекта пока не добавлено'}</p><span>Открыть проект <ArrowRight size={16}/></span></a>{p.is_owner&&<button type="button" className="secondary project-trash-button" title="Переместить проект в корзину" aria-label={'В корзину: '+p.name} disabled={projectDeleteBusy} onClick={()=>void onMoveProjectToTrash(p)}><Trash2 size={15}/></button>}</div>)}{projects.length===0&&<div className="empty">Пока нет проектов. Создайте первый, чтобы начать работу.</div>}</div>}</div>
 );
}
