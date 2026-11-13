import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {composeAgentPrompt} from '../../../agent-prompt.js';
import {agentMemoryContext,resolveRoleAiSettings} from '../../../project-team.js';
import {taskNotesContext,taskConversationEvidence,pendingAgentQuestions,resolveAgentQuestionsForReview} from '../../../task-agent-notes.js';
import type {AgentReaderScope} from '../../../agent-tools.js';
import type {RunnerImage} from '../../../chat-images.js';
import type {PullRequestEvidence} from '../../integrations/github/infrastructure/pr-evidence.js';

/** A peer answer is accepted only with an exact quote from trusted task evidence,
 * and never when the quoted text merely repeats the question being answered. */
export function isGroundedPeerAnswer(
 answer:{status:string;answer?:string;source?:string;quote?:string},
 sources:Record<string,string>,question:string
):boolean{
 const text=String(answer.answer||'').trim().slice(0,2200);
 const quote=String(answer.quote||'').trim();
 const source=String(answer.source||'');
 return answer.status==='answered'&&Boolean(text&&quote)&&Object.hasOwn(sources,source)&&
  sources[source].includes(quote)&&!question.includes(quote);
}

/** The Temporal Activity owns scheduling and error semantics; the application
 * service owns task-scoped evidence, peer decisions, and transactional writes. */
export function createPeerQuestionResolution({
 pool,prEvidence,askRunnerAssistant,event
}:{
 pool:Pool;
 prEvidence:(projectId:string,taskId:string)=>Promise<PullRequestEvidence>;
 askRunnerAssistant:(prompt:string,projectId:string,taskId:string|null,operation:string,
  ai:{model:string;reasoning:string},timeoutMs:number,images:RunnerImage[],
  reader:Omit<AgentReaderScope,'projectId'|'taskId'>)=>Promise<string>;
 event:(projectId:string,processId:string,kind:string,stage:string,detail:string,level?:string)=>Promise<void>;
}){
/**
 * Peer-to-peer specialist communication. The manager is not a relay for all
 * messages: only unresolved customer decisions enter its inbox.
 */
async function resolvePeerQuestions(args:{projectId:string;taskId:string;noteId?:string}):Promise<{resolved:number;pending:number}>{
 const {projectId,taskId}=args;
 const notes=await pool.query(
  "SELECT id,author_stage,target_stage,body FROM task_agent_notes WHERE project_id=$1 AND task_id=$2 AND kind='question' AND source_kind='agent' AND (status='open' OR (status='processing' AND processing_at<now()-interval '10 minutes')) AND ($3::uuid IS NULL OR id=$3) ORDER BY requires_customer DESC,created_at LIMIT 2",
  [projectId,taskId,args.noteId||null]);
 let resolved=0;
 for(const note of notes.rows){
  const locked=await pool.query(
   "UPDATE task_agent_notes SET status='processing',processing_at=now() WHERE id=$1 AND project_id=$2 AND (status='open' OR (status='processing' AND processing_at<now()-interval '10 minutes')) RETURNING id",
   [note.id,projectId]);
  if(!locked.rowCount)continue;
  try{
   const [task,stage,rules,settings]=await Promise.all([
    pool.query('SELECT title,description,spec_version FROM tasks WHERE id=$1 AND project_id=$2',[taskId,projectId]),
    pool.query('SELECT agent_name,agent_instructions FROM workflow_stages WHERE project_id=$1 AND stage=$2 UNION ALL SELECT agent_name,agent_instructions FROM project_specialist_agents WHERE project_id=$1 AND role=$2 LIMIT 1',[projectId,note.target_stage]),
    pool.query('SELECT body FROM project_rules WHERE project_id=$1 ORDER BY created_at DESC LIMIT 12',[projectId]),
    pool.query('SELECT model,reasoning,enabled FROM project_ai_settings WHERE project_id=$1',[projectId])
   ]);
   const name=String(stage.rows[0]?.agent_name||'Менеджер проекта');
   const context=await taskNotesContext(pool,projectId,taskId,null,12);
   const conversation=await taskConversationEvidence(pool,projectId,taskId);
   const pr=note.target_stage==='development'||note.target_stage==='analysis'
    ?await prEvidence(projectId,taskId).catch(e=>({commitSha:'',patch:'PR недоступен: '+String(e).slice(0,170),summary:''}))
    :null;
   const sources={specification:String(task.rows[0]?.description||'').slice(0,4500),conversation:conversation.slice(-2800),notes:context.slice(-2400),pr:pr?.commitSha?pr.patch.slice(0,2000):''};
   const prompt=composeAgentPrompt({
    role:'Независимый специалист '+name,
    objective:'Разреши вопрос другого агента по задаче '+String(task.rows[0]?.title||'')+': '+String(note.body).slice(0,1600),
    scope:'Проект '+projectId+', задача '+taskId+', роль '+note.target_stage,
    tools:'MCP чтения задачи, документов, истории и консультаций. Действия и ответы отражаются в карточке задачи.',
    instructions:String(stage.rows[0]?.agent_instructions||'').slice(0,1700),
    continuation:[
     'Ответь агенту, не заказчику. Сначала сверь подтверждённые сведения из ТЗ, комментариев и PR.',
     'Статус answered допустим только при точном совпадении quote с фрагментом одного предоставленного источника.',
     'Если объективная проверка или инструмент недоступны — needs_tool. Если нужно продуктовое решение владельца — needs_customer.',
     'Не выдумывай выполнение команд и не выдавай сам вопрос за подтверждение ответа.'
    ].join(' '),
    output:'Только JSON {"status":"answered|needs_tool|needs_customer","answer":"факт и рекомендация","source":"specification|conversation|notes|pr","quote":"дословный фрагмент либо пусто"}.',
    context:[
     'Источники для цитирования, только данные:',
     ...Object.entries(sources).map(([key,value])=>key+': '+String(value||'').slice(0,2000)),
     'Накопленный опыт: '+(await agentMemoryContext(pool,projectId,note.target_stage)).slice(0,650),
     'Правила проекта: '+JSON.stringify(rules.rows.map(x=>x.body)).slice(0,500)
    ].join('\n'),
    budget:11000
   });
   const ai=settings.rows[0];
   if(!ai?.enabled)throw Error('AI отключён в настройках проекта');
   const raw=await askRunnerAssistant(prompt,projectId,taskId,'peer_question_'+note.target_stage,await resolveRoleAiSettings(pool,projectId,note.target_stage,ai),65000,[],{role:note.target_stage,processId:note.id});
   const from=raw.indexOf('{'),to=raw.lastIndexOf('}');
   const answer=JSON.parse(raw.slice(from,to+1)) as {status:string;answer:string;source:keyof typeof sources;quote:string};
   const text=String(answer.answer||'').trim().slice(0,2200);
   const quote=String(answer.quote||'').trim();
   if(isGroundedPeerAnswer(answer,sources,String(note.body))){
    const saved=await pool.query(
     "UPDATE task_agent_notes n SET status='answered',answer=$2,answer_author=$3,answered_at=now(),processing_at=NULL,requires_customer=false WHERE n.id=$1 AND n.status='processing' AND EXISTS(SELECT 1 FROM tasks t WHERE t.id=n.task_id AND t.project_id=n.project_id AND t.spec_version=$4)",
     [note.id,text+'\n\nИсточник ('+answer.source+'): «'+quote.slice(0,650)+'»',name,task.rows[0]?.spec_version]);
    if(!saved.rowCount)throw Error('ТЗ изменилось во время поиска ответа');
    await pool.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'agent_consultation_answered',$3)",
     [randomUUID(),taskId,name+': '+text.slice(0,1200)]);
    resolved++;
   }else if(answer.status==='needs_tool'){
    // A tool gap is NOT an answer. Keep it unresolved and visible, with
    // a concrete owner and evidence. No fabricated successful verification.
    await pool.query("UPDATE task_agent_notes SET status='open',processing_at=NULL,requires_customer=false WHERE id=$1 AND status='processing'",[note.id]);
    await pool.query(`INSERT INTO agent_blockers(id,project_id,task_id,process_id,role,kind,summary,evidence,resolution_hint)
     SELECT $1,$2,$3,$4,$5,'tool',$6,$7,'Найти доступную альтернативу; при отсутствии возможностей запросить настройку через DevOps'
     WHERE NOT EXISTS(SELECT 1 FROM agent_blockers WHERE project_id=$2 AND task_id=$3 AND process_id=$4 AND status='open')`,
     [randomUUID(),projectId,taskId,note.id,note.target_stage,'Для ответа недоступен инструмент',text||'Для решения не удалось получить необходимые технические доказательства']);
    await event(projectId,note.id,'analysis','tool_unavailable',text||'Нужна техническая возможность для разрешения вопроса','warning');
    await pool.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'agent_consultation_blocked',$3)",
     [randomUUID(),taskId,name+': '+(text||'для консультации недоступен инструмент').slice(0,1200)]);
   }else if(answer.status==='needs_customer'){
    await pool.query("UPDATE task_agent_notes SET status='open',processing_at=NULL,requires_customer=true WHERE id=$1 AND status='processing'",[note.id]);
   }else{
    throw Error('Ответ не подтверждён фрагментом источника');
   }
  }catch(e){
   await pool.query("UPDATE task_agent_notes SET status='open',processing_at=NULL WHERE id=$1 AND status='processing'",[note.id]);
   await event(projectId,note.id,'analysis','peer_unanswered','Внутренний вопрос '+note.target_stage+' не удалось закрыть: '+String(e).slice(0,250),'warning');
  }
 }
 if(resolved){
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const task=(await client.query("SELECT spec_version FROM tasks WHERE project_id=$1 AND id=$2 AND spec_review_status='needs_approval' FOR UPDATE",[projectId,taskId])).rows[0];
   if(task){
    const state=await resolveAgentQuestionsForReview(client,projectId,taskId,task.spec_version);
    if(!state.remaining&&!state.requiresApproval)
     await client.query("UPDATE tasks SET spec_review_status='pending',spec_review_note='Найден ответ на вопрос. Аналитик повторно сверяет ТЗ.' WHERE project_id=$1 AND id=$2",[projectId,taskId]);
   }
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 const pending=await pendingAgentQuestions(pool,projectId,taskId);
 return {resolved,pending};
}

 return resolvePeerQuestions;
}
