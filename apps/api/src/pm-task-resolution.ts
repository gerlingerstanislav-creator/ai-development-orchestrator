import type {Pool} from 'pg';

type Db=Pick<Pool,'query'>;
type TaskReference={task_id?:string;task_number?:number};
const invalid=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode});

/** Display numbers belong to a PROJECT, not to the global database.
 * PM can use the human-visible #36 without guessing or copying a stale UUID.
 * An explicitly supplied UUID and number must name the SAME task.
 * This is only identifier resolution: owner authorization and cancellation
 * guards remain in the original, audited HTTP command.
 */
export async function resolvePmTaskReference(db:Db,projectId:string,ref:TaskReference):
 Promise<{id:string;display_number:number;title:string;stage:string}>{
 if(!ref.task_id&&ref.task_number===undefined)
  throw invalid('Укажи task_id или номер карточки task_number',400);
 if(ref.task_number!==undefined&&(!Number.isSafeInteger(ref.task_number)||ref.task_number<1))
  throw invalid('Номер задачи должен быть положительным целым числом',400);

 const byId=!!ref.task_id;
 const query=byId
  ?'SELECT id,display_number,title,stage FROM tasks WHERE project_id=$1 AND id=$2'
  :'SELECT id,display_number,title,stage FROM tasks WHERE project_id=$1 AND display_number=$2';
 const rows=(await db.query(query,[projectId,byId?ref.task_id:ref.task_number])).rows;
 if(!rows.length)throw invalid(ref.task_number!==undefined
  ?'Задача #'+ref.task_number+' не найдена в текущем проекте. Проверь номер через tasks.list(display_number).'
  :'Задача с указанным UUID не найдена в текущем проекте. Проверь актуальный task_id через tasks.list.',404);
 if(rows.length!==1)throw invalid('Номер карточки неоднозначен в этом проекте',409);
 const row=rows[0];
 if(ref.task_number!==undefined&&Number(row.display_number)!==ref.task_number)
  throw invalid('task_id и task_number относятся к разным задачам. Операция отменена.',409);
 return {id:String(row.id),display_number:Number(row.display_number),title:String(row.title),stage:String(row.stage)};
}
