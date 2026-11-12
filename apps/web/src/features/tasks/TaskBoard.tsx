import React,{useState} from 'react';
import {AlertTriangle,ChevronDown} from 'lucide-react';
import {projectUrl} from '../navigation/routes.js';
import {boardLaneFor,dependencyReady,groupKanbanStages,kanbanOrder,
 type BoardTask,type KanbanGroupKey,type KanbanLane,type KanbanGroup} from './board-model.js';

type Props<T extends BoardTask>={
 projectId:string;
 tasks:T[];
 filtered:T[];
 stages:KanbanLane[];
 expandedGroups:KanbanGroupKey[];
 onToggleGroup:(group:KanbanGroupKey)=>void;
 renderTaskPlanningLabels:(task:T)=>React.ReactNode;
 agentWorking:(id:string)=>boolean;
 onFollowLink:(event:React.MouseEvent<HTMLAnchorElement>,path:string)=>void;
 onMoveTask:(task:T,stage:string)=>void;
 questionAnswers:Record<string,string>;
 onQuestionDraft:(taskId:string,answer:string)=>void;
 onAnswerQuestion:(task:T)=>void;
 processActionBusy:boolean;
 mergeBusy:boolean;
 onMerge:()=>void;
 knowledgeBusy:boolean;
 onUpdateDocumentation:()=>void;
};

/** Pure board presentation and local drag state. All mutations use injected commands. */
export function TaskBoard<T extends BoardTask>({
 projectId,tasks,filtered,stages,expandedGroups,onToggleGroup,
 renderTaskPlanningLabels,agentWorking,onFollowLink,onMoveTask,
 questionAnswers,onQuestionDraft,onAnswerQuestion,processActionBusy,
 mergeBusy,onMerge,knowledgeBusy,onUpdateDocumentation
}:Props<T>){
 const [drag,setDrag]=useState<string|null>(null);
 const kanbanGroups=groupKanbanStages(stages);
 function renderKanbanCard(t:T,showStage=false){
  if(t.type==='question')return renderDocQuestionCard(t);
  return <a className="task-card" href={projectUrl(projectId,'tasks')+'/'+t.id}
    draggable={!t.awaits_product_owner} onDragStart={t.awaits_product_owner?undefined:e=>{setDrag(t.id);e.dataTransfer.effectAllowed='move';}} onDragEnd={()=>setDrag(null)}
    onClick={e=>onFollowLink(e,projectUrl(projectId,'tasks')+'/'+t.id)} key={t.id}>
    <span className="task-card-top"><span className="task-type">{t.type==='question'?'Вопрос к ПО':t.type==='bug'?'Ошибка':t.type==='epic'?'Эпик':t.type==='improvement'?'Улучшение':'Задача'}</span><span className="task-id-label" title={"Полный ID задачи: "+t.id}>#{t.display_number}</span></span>
    <span className="task-name-line"><strong>{t.title}</strong>{t.awaits_product_owner&&<span className="task-owner-question-icon" title={t.owner_question_source_task_id&&t.owner_question_source_task_id!==t.id?'Нужен ответ владельца в связанной задаче эпика':'Нужен ответ или решение владельца для продолжения'} aria-label="Необходим ответ владельца"><AlertTriangle size={16}/></span>}{agentWorking(t.id)&&<span className="agent-equalizer task-card-activity" role="status" aria-label="AI работает над задачей" title="AI выполняет задачу"><i/><i/><i/></span>}</span>
    {renderTaskPlanningLabels(t)}
    <small className="task-card-priority">{!dependencyReady(t,tasks)?'Ожидает зависимость · ':''}Приоритет {t.priority??3}</small>
    <p>{t.description||'Без описания'}</p>
    {t.awaits_product_owner&&<small className="task-warning">
     {t.owner_question_source_task_id&&t.owner_question_source_task_id!==t.id?'Вопросы в связанной задаче':'Нужен ответ владельца'}
    </small>}
  </a>;
 }
 function renderDocQuestionCard(question:T){
  return <div className="task-card docs-question-card" key={'doc-question-'+question.id}>
   <span className="task-type">Уточнение документации</span>
   <strong>{question.description}</strong>
   {question.document_id&&<a href={projectUrl(projectId,'docs')+'/'+question.document_id} onClick={e=>onFollowLink(e,projectUrl(projectId,'docs')+'/'+question.document_id)}>ТЗ: {question.document_title||'Документ'}</a>}
   <a href={projectUrl(projectId,'tasks')+'/'+question.id} onClick={e=>onFollowLink(e,projectUrl(projectId,'tasks')+'/'+question.id)}>Открыть карточку #{question.display_number}</a>
   {question.question_status==='answered'?<small className="muted">Ответ получен. Аналитик обновляет страницу.</small>:<>
    <textarea rows={3} value={questionAnswers[question.id]||''} onChange={e=>onQuestionDraft(question.id,e.target.value)} placeholder="Решение владельца продукта"/>
    <button className="secondary" disabled={processActionBusy||!(questionAnswers[question.id]||'').trim()} onClick={()=>void onAnswerQuestion(question)}>Ответить аналитику</button>
   </>}
  </div>;
 }
 function renderKanbanLane(s:KanbanLane){
  const stageTasks=filtered.filter(t=>boardLaneFor(t)===s.stage).sort((a,b)=>kanbanOrder(a,b,tasks));
  return <div className="lane" key={s.stage}
   onDragOver={e=>e.preventDefault()}
   onDrop={e=>{e.preventDefault();if(drag){const task=tasks.find(t=>t.id===drag);if(task&&!task.awaits_product_owner)void onMoveTask(task,s.stage);}setDrag(null);}}>
   <div className="lane-heading"><span className={'stage-dot '+s.stage}></span><b>{s.label}</b><span className="count">{stageTasks.length}</span>
    {s.stage==='merge_queue'&&<button className="secondary" disabled={mergeBusy||!tasks.some(t=>t.stage==='merge_queue')} onClick={e=>{e.stopPropagation();void onMerge();}} title="Последовательно слить проверенные PR">Слить готовые</button>}
    {s.stage==='documentation'&&<button className="secondary" disabled={knowledgeBusy||!tasks.some(t=>t.stage==='documentation')} onClick={e=>{e.stopPropagation();void onUpdateDocumentation();}} title="Обновить документацию по всем слитым задачам">Обновить документацию</button>}
   </div>
   <div className="cards">
     {stageTasks.map(t=>renderKanbanCard(t))}
      {stageTasks.length===0&&<div className="lane-empty">Перетащите задачу сюда</div>}
    </div>
  </div>;
 }
 function renderCollapsedGroup(group:KanbanGroup){
  const groupTasks=filtered.filter(t=>group.stages.some(stage=>stage.stage===boardLaneFor(t)));
  // One list, not nested stage columns. Keep stage identity on each card.
  const ordered=groupTasks.slice().sort((a,b)=>{
   const ai=group.stages.findIndex(stage=>stage.stage===boardLaneFor(a));
   const bi=group.stages.findIndex(stage=>stage.stage===boardLaneFor(b));
   return ai-bi || kanbanOrder(a,b,tasks);
  });
  return <div className="kanban-group-combined">
   {ordered.length?<div className="cards">{ordered.map(task=>renderKanbanCard(task,true))}</div>:
     <div className="lane-empty">В группе пока нет задач</div>}
   {group.stages.some(stage=>stage.stage==='merge_queue')&&tasks.some(t=>t.stage==='merge_queue')&&
    <button className="secondary group-action" disabled={mergeBusy} onClick={()=>void onMerge()}>Слить готовые</button>}
   {group.stages.some(stage=>stage.stage==='documentation')&&tasks.some(t=>t.stage==='documentation')&&
    <button className="secondary group-action" disabled={knowledgeBusy} onClick={()=>void onUpdateDocumentation()}>Обновить документацию</button>}
  </div>;
 }

 return <div className="board board-groups">
 {kanbanGroups.map(group=>{
  const expanded=expandedGroups.includes(group.key);
  const count=filtered.filter(t=>group.stages.some(stage=>stage.stage===boardLaneFor(t))).length;
  return <section key={group.key} className={'kanban-group '+(expanded?'is-expanded':'is-collapsed')} style={{['--kanban-stage-count' as string]:group.stages.length} as React.CSSProperties}>
   <button className="kanban-group-heading" type="button" aria-expanded={expanded} onClick={()=>onToggleGroup(group.key)}
    title={expanded?'Свернуть этапы':'Развернуть этапы'}><span className="group-mark"/>
    <strong>{group.title}</strong><span className="group-stage-count">{group.stages.length} эт.</span><span className="group-task-count">{count}</span>
    <ChevronDown size={16} className={'group-chevron '+(expanded?'expanded':'')}/>
   </button>
   {expanded?<div className="kanban-group-stages">{group.stages.map(stage=>renderKanbanLane(stage))}</div>:renderCollapsedGroup(group)}
  </section>;
 })}
 </div>;
}
