import React,{useState} from 'react';
import {AlertTriangle} from 'lucide-react';
import {projectUrl} from '../navigation/routes.js';
import {boardLaneFor,dependencyReady,kanbanOrder,kanbanLanes,
 type BoardStatus,type BoardTask,type KanbanLane} from './board-model.js';

type Props<T extends BoardTask>={
 projectId:string;
 tasks:T[];
 filtered:T[];
 stages:KanbanLane[];
 renderTaskPlanningLabels:(task:T)=>React.ReactNode;
 agentWorking:(id:string)=>boolean;
 onFollowLink:(event:React.MouseEvent<HTMLAnchorElement>,path:string)=>void;
 onMoveTask:(task:T,status:BoardStatus)=>void;
 questionAnswers:Record<string,string>;
 onQuestionDraft:(taskId:string,answer:string)=>void;
 onAnswerQuestion:(task:T)=>void;
 processActionBusy:boolean;
 mergeBusy:boolean;
 onMerge:()=>void;
 knowledgeBusy:boolean;
 onUpdateDocumentation:()=>void;
};

/** Universal product-state board. Technical stages remain inside each card. */
export function TaskBoard<T extends BoardTask>({
 projectId,tasks,filtered,stages,renderTaskPlanningLabels,agentWorking,
 onFollowLink,onMoveTask,questionAnswers,onQuestionDraft,onAnswerQuestion,
 processActionBusy,mergeBusy,onMerge,knowledgeBusy,onUpdateDocumentation
}:Props<T>){
 const [drag,setDrag]=useState<string|null>(null);
 const stageLabel=(stage:string)=>stages.find(s=>s.stage===stage)?.label||stage;
 function renderDocQuestionCard(question:T){
  return <div className="task-card docs-question-card" key={'doc-question-'+question.id}>
   <span className="task-type">Уточнение документации</span>
   <strong>{question.description}</strong>
   {question.document_id&&<a href={projectUrl(projectId,'docs')+'/'+question.document_id}
    onClick={e=>onFollowLink(e,projectUrl(projectId,'docs')+'/'+question.document_id)}>ТЗ: {question.document_title||'Документ'}</a>}
   <a href={projectUrl(projectId,'tasks')+'/'+question.id} onClick={e=>onFollowLink(e,projectUrl(projectId,'tasks')+'/'+question.id)}>Открыть карточку #{question.display_number}</a>
   {question.question_status==='answered'?<small className="muted">Ответ получен. Аналитик обновляет страницу.</small>:<>
    <textarea rows={3} value={questionAnswers[question.id]||''}
     onChange={e=>onQuestionDraft(question.id,e.target.value)} placeholder="Решение владельца продукта"/>
    <button className="secondary" disabled={processActionBusy||!(questionAnswers[question.id]||'').trim()}
     onClick={()=>void onAnswerQuestion(question)}>Ответить аналитику</button>
   </>}
  </div>;
 }
 function renderCard(t:T){
  if(t.type==='question')return renderDocQuestionCard(t);
  const path=projectUrl(projectId,'tasks')+'/'+t.id;
  const canDrag=!t.awaits_product_owner&&!t.postponed_at&&!t.archived_at;
  return <a className="task-card" href={path} key={t.id} draggable={canDrag}
   onDragStart={canDrag?e=>{setDrag(t.id);e.dataTransfer.effectAllowed='move';}:undefined}
   onDragEnd={()=>setDrag(null)}
   onClick={e=>onFollowLink(e,path)}>
   <span className="task-card-top">
    <span className="task-type">{t.type==='bug'?'Ошибка':t.type==='epic'?'Эпик':t.type==='improvement'?'Улучшение':'Задача'}</span>
    <span className="task-id-label" title={'Полный ID задачи: '+t.id}>#{t.display_number}</span>
   </span>
   <span className="task-name-line"><strong>{t.title}</strong>
    {t.awaits_product_owner&&<span className="task-owner-question-icon" title="Нужен ответ владельца для продолжения" aria-label="Необходим ответ владельца"><AlertTriangle size={16}/></span>}
    {agentWorking(t.id)&&<span className="agent-equalizer task-card-activity" role="status" aria-label="AI работает над задачей" title="AI выполняет задачу"><i/><i/><i/></span>}
   </span>
   <small className="task-card-stage"><span className={'stage-dot '+t.stage}/>{stageLabel(t.stage)}</small>
   {t.acceptance_feedback&&<small className="task-warning">Замечания приёмки: {t.acceptance_feedback}</small>}
   {t.postponed_at&&<small className="muted">Отложено{t.postponed_until?' до '+t.postponed_until:''}</small>}
   {!dependencyReady(t,tasks)&&<small className="task-warning">Ожидает зависимость</small>}
   {renderTaskPlanningLabels(t)}
   <small className="task-card-priority">Приоритет {t.priority??3}</small>
   <p>{t.description||'Без описания'}</p>
  </a>;
 }
 return <div className="board-universal">
  {(tasks.some(t=>t.stage==='merge_queue')||tasks.some(t=>t.stage==='documentation'))&&
   <div className="board-process-actions">
    {tasks.some(t=>t.stage==='merge_queue')&&<button type="button" className="secondary" disabled={mergeBusy}
     onClick={()=>void onMerge()}>Слить проверенные PR</button>}
    {tasks.some(t=>t.stage==='documentation')&&<button type="button" className="secondary" disabled={knowledgeBusy}
     onClick={()=>void onUpdateDocumentation()}>Обновить документацию</button>}
   </div>}
  <div className="board board-lifecycle">
   {kanbanLanes.map(lane=>{
    const stageTasks=filtered.filter(t=>boardLaneFor(t)===lane.stage).sort((a,b)=>kanbanOrder(a,b,tasks));
    const dropAllowed=lane.stage==='backlog'||lane.stage==='todo'||lane.stage==='in_progress';
    return <section key={lane.stage} className={'lane board-lane board-lane-'+lane.stage}
     onDragOver={dropAllowed?event=>event.preventDefault():undefined}
     onDrop={dropAllowed?event=>{
      event.preventDefault();
      if(drag){const task=tasks.find(t=>t.id===drag);if(task&&!task.awaits_product_owner)void onMoveTask(task,lane.stage as BoardStatus);}
      setDrag(null);
     }:undefined}>
     <div className="lane-heading"><span className={'stage-dot '+lane.stage}/><b>{lane.label}</b><span className="count">{stageTasks.length}</span></div>
     <div className="cards">{stageTasks.map(renderCard)}
      {stageTasks.length===0&&<div className="lane-empty">{lane.stage==='acceptance'?'После завершения технических проверок':lane.stage==='done'?'После подтверждения результата':'Пока нет задач'}</div>}
     </div>
    </section>;
   })}
  </div>
 </div>;
}
