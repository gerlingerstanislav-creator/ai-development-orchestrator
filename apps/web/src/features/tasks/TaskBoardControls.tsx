import React,{useState} from 'react';
import {boardLaneFor,type BoardTask} from './board-model.js';

type Props={
 task:BoardTask;
 busy:boolean;
 onAction:(action:string,data?:Record<string,unknown>)=>Promise<void>;
};

/** User-facing acceptance and planning controls; never modifies workflow stage. */
export function TaskBoardControls({task,busy,onAction}:Props){
 const [feedback,setFeedback]=useState('');
 const [until,setUntil]=useState('');
 const status=boardLaneFor(task);
 return <section className="task-board-controls" aria-label="Управление состоянием задачи">
  <div className="task-board-control-top">
   <label>Приёмка результата
    <select aria-label="Режим приёмки" value={task.acceptance_mode||'undecided'} disabled={busy||!!task.archived_at}
     onChange={e=>void onAction('set_acceptance',{mode:e.target.value})}>
     <option value="undecided">Решить при завершении</option>
     <option value="manual">Принимает владелец</option>
     <option value="automatic">Автоматически после проверок</option>
    </select>
   </label>
   <div className="task-board-control-actions">
    {task.archived_at?
     <button type="button" className="secondary" disabled={busy} onClick={()=>void onAction('restore')}>Восстановить из архива</button>:
     task.postponed_at?
      <button type="button" className="secondary" disabled={busy} onClick={()=>void onAction('resume')}>Вернуть отложенную</button>:
      <>
       {task.stage==='backlog'&&['backlog','todo'].includes(status)&&<>
        {status==='backlog'&&<button type="button" className="secondary" disabled={busy}
         onClick={()=>void onAction('move',{status:'todo'})}>К работе</button>}
        <button type="button" className="primary" disabled={busy}
         onClick={()=>void onAction('move',{status:'in_progress'})}>Запустить с PM</button>
       </>}
       {!['done','acceptance'].includes(status)&&<button type="button" className="secondary" disabled={busy}
        onClick={()=>void onAction('postpone',{until:until||null})}>Отложить</button>}
       {status==='done'&&<button type="button" className="secondary" disabled={busy}
        onClick={()=>void onAction('archive')}>В архив</button>}
      </>
    }
   </div>
  </div>
  {!task.postponed_at&&!task.archived_at&&!['done','acceptance'].includes(status)&&
   <label className="task-postpone-until">Отложить до (необязательно)
    <input type="date" aria-label="Дата возврата отложенной задачи" value={until} onChange={e=>setUntil(e.target.value)}/>
   </label>}
  {task.postponed_at&&<small className="muted">Отложено{task.postponed_until?' до '+task.postponed_until:''}. Активные процессы нельзя откладывать без остановки.</small>}
  {status==='acceptance'&&!task.archived_at&&<>
   <div className="task-board-acceptance">
    <strong>Технические работы завершены. Требуется приёмка результата.</strong>
    <button className="primary" type="button" disabled={busy||task.stage!=='done'}
     onClick={()=>void onAction('accept')}>Принять результат</button>
   </div>
   <details className="task-board-rework">
    <summary>Есть замечания к результату</summary>
    <textarea rows={3} placeholder="Что необходимо исправить?" value={feedback}
     onChange={e=>setFeedback(e.target.value)} maxLength={2000}/>
    <button type="button" className="secondary" disabled={busy||feedback.trim().length<10}
     onClick={async()=>{await onAction('request_changes',{reason:feedback.trim()});setFeedback('');}}>Сохранить замечания</button>
    <small className="muted">После слияния PR доработка оформляется связанной задачей, без отката исходного workflow.</small>
   </details>
   {task.acceptance_feedback&&<p className="task-warning">{task.acceptance_feedback}</p>}
  </>}
 </section>;
}
