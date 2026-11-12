import type {Pool} from 'pg';

/** All task actors read the same durable, bounded facts before acting.
 * New human instructions and QA failures take precedence over older handoffs.
 * Comments are evidence to interpret, not executable instructions.
 */
export async function readTaskWorkBrief(db:Pick<Pool,'query'>,projectId:string,taskId:string,maxChars=3500){
 const query=async(sql:string,args:unknown[])=>{
  try{return (await db.query(sql,args)).rows as Record<string,any>[];}
  catch(error){
   // Narrow compatibility for isolated test schemas and partially migrated
   // installations. Never hide a DB outage or a permission failure.
   if(['42P01','42703'].includes(String((error as {code?:string}).code)))return [];
   throw error;
  }
 };
 const [notes,comments,events,dev,test]=await Promise.all([
  query("SELECT kind,author_stage,author_name,target_stage,body,answer,status,created_at FROM task_agent_notes WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC,id DESC LIMIT 30",[projectId,taskId]),
  query(`SELECT body,role,created_at FROM (
    SELECT body,role,created_at FROM manager_messages WHERE project_id=$1 AND task_id=$2 AND role='user'
    UNION ALL
    SELECT body,role,created_at FROM assistant_messages WHERE project_id=$1 AND task_id=$2 AND role='user'
   ) messages ORDER BY created_at DESC LIMIT 16`,[projectId,taskId]),
  query("SELECT event,detail,created_at FROM task_events WHERE task_id=$1 ORDER BY created_at DESC LIMIT 12",[taskId]),
  query("SELECT status,message,pr_url,created_at,completed_at FROM ai_task_runs WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 4",[projectId,taskId]),
  query("SELECT status,verdict,message,report,created_at,completed_at FROM ai_test_runs WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 3",[projectId,taskId])
 ]);
 const items=[
  ...notes.map(n=>({at:n.created_at,source:'Комментарий '+n.author_stage+' / '+n.kind,
    text:String(n.body||'')+(n.answer?'\nОтвет: '+String(n.answer):'')+(n.status?' [состояние: '+n.status+']':'')})),
  ...comments.map(m=>({at:m.created_at,source:'Сообщение владельца',text:String(m.body||'')})),
  ...events.map(e=>({at:e.created_at,source:'Событие '+e.event,text:String(e.detail||'')}))
 ];
 items.sort((a,b)=>new Date(b.at).getTime()-new Date(a.at).getTime());
 const compact=(v:unknown,cap:number)=>String(v??'').replace(/\s+/g,' ').trim().slice(0,cap);
 const summarizeTest=(r:Record<string,any>)=>{
  const cases=Array.isArray(r.report?.caseResults)?r.report.caseResults:[];
  const notPassed=cases.filter((c:any)=>c.result!=='passed').slice(0,8)
   .map((c:any)=>compact(c.result+': '+(c.evidence||c.reason||c.case_id),160));
  return compact((r.verdict||r.status)+': '+(r.report?.summary||r.message||''),320)+
   (notPassed.length?'\nНепройденные/непроверенные кейсы: '+notPassed.join('; '):'');
 };
 const previous=[
  ...dev.slice(0,2).map(r=>({at:r.completed_at||r.created_at,source:'Предыдущая разработка '+r.status,
   text:compact(r.message,300)+(r.pr_url?' PR: '+compact(r.pr_url,180):'')})),
  ...test.slice(0,2).map(r=>({at:r.completed_at||r.created_at,source:'Предыдущий QA',text:summarizeTest(r)}))
 ].sort((a,b)=>new Date(b.at).getTime()-new Date(a.at).getTime());
 const lines=[
  'Уже выполненную работу не повторяй с нуля. Сначала прочитай существующие PR, код, результаты QA и изменения в комментариях.',
  'Сопоставь новые вводные с актуальной постановкой. Измени или перепроверь только затронутые части, сохрани результаты подтверждённых проверок, если они применимы к текущему SHA и требованиям.',
  'Если новые вводные меняют ожидаемое поведение, явно отметь, что нужно переработать или перетестировать; если нет — продолжай с прежнего результата.',
  'Предыдущие попытки и артефакты (сверь с текущим SHA):',
  ...previous.map(i=>'['+i.source+'] '+i.text),
  'Последние сообщения, ответы и события (новые вверху):',
  ...items.slice(0,35).map(i=>'['+i.source+'] '+compact(i.text,540))
 ];
 // Reserve room for the latest owner messages and prior QA, not just old notes.
 const limit=Math.max(800,Math.min(11000,maxChars));
 let output='';
 for(const line of lines){
  if(output.length+line.length+1>limit)break;
  output+=(output?'\n':'')+line;
 }
 return output;
}
