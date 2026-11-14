import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {BOARD_STATES,ACCEPTANCE_MODES,canPlanBoardMove,boardStateForStage} from './task-board.js';
import {queueTaskExecutionKickoff} from './task-execution-kickoff.js';

type Deps={
 pool:Pool;
 uid:(request:any)=>string;
 access:(request:any,reply:any,projectId:string)=>Promise<boolean>;
 requireAdmin:(request:any,reply:any)=>Promise<boolean>;
};
const payload=z.object({
 action:z.enum(['move','start','set_acceptance','accept','request_changes','postpone','resume','archive','restore']),
 status:z.enum(BOARD_STATES).optional(),
 mode:z.enum(ACCEPTANCE_MODES).optional(),
 reason:z.string().trim().max(2000).optional(),
 until:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()
}).strict();

/** Project lifecycle actions are not workflow-stage transitions.
 * No action in this module can change tasks.stage, fabricate QA results or
 * bypass the existing development/merge/deployment controls.
 */
export function registerTaskBoardRoutes(app:FastifyInstance,{pool,uid,access,requireAdmin}:Deps){
 app.patch('/api/projects/:id/tasks/:taskId/board',async(request:any,reply)=>{
  const {id,taskId}=z.object({id:z.string().uuid(),taskId:z.string().uuid()}).parse(request.params);
  if(!await access(request,reply,id))return;
  const input=payload.parse(request.body);
  // Acceptance, deferment and archiving have product implications. They
  // require the same privileged user as workflow approvals.
  if((input.action!=='move'||input.status==='in_progress')&&!await requireAdmin(request,reply))return;
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const result=await client.query(
    'SELECT id,type,stage,board_status,acceptance_mode,postponed_at,archived_at,acceptance_feedback FROM tasks WHERE project_id=$1 AND id=$2 FOR UPDATE',
    [id,taskId]);
   if(!result.rowCount){
    await client.query('ROLLBACK');
    return reply.code(404).send({error:'Задача не найдена'});
   }
   const t=result.rows[0];
   const reject=(message:string)=>Object.assign(new Error(message),{statusCode:409});
   if(t.type==='question')throw reject('Вопросы к владельцу обрабатываются через ответ аналитику');
   if(t.archived_at&&input.action!=='restore')throw reject('Сначала восстанови задачу из архива');
   let message='',details='',response:{[key:string]:unknown}={};
   switch(input.action){
    case 'move': {
     if(!input.status||!canPlanBoardMove(t.stage,t.board_status,input.status))
      throw reject('Доска не может менять этапы исполнения, обходить QA или завершать задачу. Используй действия workflow.');
     if(t.postponed_at)throw reject('Сначала верни задачу из отложенных');
     if(input.status!==t.board_status){
      await client.query('UPDATE tasks SET board_status=$3,updated_at=now() WHERE project_id=$1 AND id=$2',[id,taskId,input.status]);
     }
     if(input.status==='in_progress'&&t.stage==='backlog'){
      response.kickoff=await queueTaskExecutionKickoff(client,{projectId:id,taskId,actorId:uid(request)});
     }
     message='Состояние доски: '+input.status;
     break;
    }
    case 'start': {
     if(t.board_status!=='in_progress'||t.stage!=='backlog')
      throw reject('Повторный запуск PM доступен только для задачи без запущенного технического workflow');
     response.kickoff=await queueTaskExecutionKickoff(client,{projectId:id,taskId,actorId:uid(request)});
     message='Проверено поручение PM по задаче';
     break;
    }
    case 'set_acceptance': {
     if(!input.mode)throw reject('Укажи режим приёмки');
     await client.query('UPDATE tasks SET acceptance_mode=$3,updated_at=now() WHERE project_id=$1 AND id=$2',[id,taskId,input.mode]);
     message='Режим приёмки: '+input.mode;
     break;
    }
    case 'accept': {
     // The technical stage must already have passed all existing workflow
     // guards. A drag/drop or PM-only action cannot synthesize completion.
     if(t.stage!=='done'||t.board_status!=='acceptance')
      throw reject('Приёмка доступна только после завершения технического workflow');
     await client.query('UPDATE tasks SET board_status=\'done\',accepted_at=now(),accepted_by=$3,acceptance_feedback=NULL,updated_at=now() WHERE project_id=$1 AND id=$2',[id,taskId,uid(request)]);
     message='Результат принят владельцем';
     break;
    }
    case 'request_changes': {
     if(t.stage!=='done'||t.board_status!=='acceptance')
      throw reject('Замечания приёмки принимаются только для готового к приёмке результата');
     if(!input.reason||input.reason.length<10)throw reject('Опиши конкретные замечания (не менее 10 символов)');
     await client.query('UPDATE tasks SET acceptance_feedback=$3,updated_at=now() WHERE project_id=$1 AND id=$2',[id,taskId,input.reason]);
     message='Приёмка отклонена: '+input.reason;
     details='Слитый код не откатывается автоматически. Для исправлений создай связанную задачу и проверь её независимо.';
     break;
    }
    case 'postpone': {
     if(t.board_status==='done'||t.board_status==='acceptance'||t.stage==='done')
      throw reject('Завершённую работу нельзя откладывать');
     // A postponement is not a cancellation of live Temporal jobs. Do not
     // claim to pause an agent while it is still running.
     const busy=await client.query(`SELECT
       EXISTS(SELECT 1 FROM task_orchestration_owners WHERE project_id=$1 AND task_id=$2 AND state='active')
       OR EXISTS(SELECT 1 FROM agent_work_assignments WHERE project_id=$1 AND task_id=$2 AND status IN ('queued','running','submitted'))
       OR EXISTS(SELECT 1 FROM assistant_messages WHERE project_id=$1 AND task_id=$2 AND channel='pm-internal' AND pm_request_id=$2 AND status IN ('queued','processing'))
       OR EXISTS(SELECT 1 FROM agent_analysis_runs WHERE project_id=$1 AND task_id=$2 AND status IN ('queued','running'))
       OR EXISTS(SELECT 1 FROM ai_task_runs WHERE project_id=$1 AND task_id=$2 AND status IN ('queued','running'))
       OR EXISTS(SELECT 1 FROM ai_test_runs WHERE project_id=$1 AND task_id=$2 AND status IN ('queued','running')) AS active`,[id,taskId]);
     if(busy.rows[0]?.active)throw reject('Выполняется процесс. Сначала останови его штатным способом через Центр процессов.');
     await client.query(`UPDATE tasks SET board_status='backlog',postponed_at=now(),postponed_until=$3::date,updated_at=now()
       WHERE project_id=$1 AND id=$2`,[id,taskId,input.until||null]);
     message='Задача отложена';
     break;
    }
    case 'resume': {
     if(!t.postponed_at)throw reject('Задача не отложена');
     const status=t.stage==='backlog'?'todo':boardStateForStage(t.stage,t.acceptance_mode);
     await client.query('UPDATE tasks SET board_status=$3,postponed_at=NULL,postponed_until=NULL,updated_at=now() WHERE project_id=$1 AND id=$2',[id,taskId,status]);
     message='Задача возвращена в работу';
     break;
    }
    case 'archive': {
     if(t.board_status!=='done')throw reject('Архивировать можно только завершённые задачи');
     await client.query('UPDATE tasks SET archived_at=now(),updated_at=now() WHERE project_id=$1 AND id=$2',[id,taskId]);
     message='Задача отправлена в архив';
     break;
    }
    case 'restore': {
     if(!t.archived_at)throw reject('Задача не находится в архиве');
     await client.query('UPDATE tasks SET archived_at=NULL,updated_at=now() WHERE project_id=$1 AND id=$2',[id,taskId]);
     message='Задача возвращена из архива';
     break;
    }
   }
   await client.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(),taskId,uid(request),'board_'+input.action,(message+(details?' · '+details:'')).slice(0,2400)]);
   await client.query('COMMIT');
   return {ok:true,message,...response};
  }catch(error){
   await client.query('ROLLBACK');
   throw error;
  }finally{client.release();}
 });
}
