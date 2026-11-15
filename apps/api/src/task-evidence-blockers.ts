import type {Pool} from 'pg';

type Db=Pick<Pool,'query'>;

/**
 * A compiler error is a property of the immutable source revision. Replaying
 * the same browser job on the same SHA cannot produce real screenshots.
 * Only trusted, completed QA checks count: never infer this from PM prose.
 */
export function confirmedSourceBuildFailure(report:unknown):boolean{
 if(!report||typeof report!=='object')return false;
 const checks=Array.isArray((report as {checks?:unknown}).checks)?(report as {checks:unknown[]}).checks:[];
 return checks.some(item=>{
  if(!item||typeof item!=='object')return false;
  const check=item as {result?:unknown;name?:unknown;details?:unknown};
  if(check.result!=='failed')return false;
  const label=String(check.name||'');
  const details=String(check.details||'');
  return /(?:сборк|build|компиляц|compile)/i.test(label)&&
   /(?:\bvue\b|\[vite:vue\]|v-else-if|v-else|vue compiler|vue compile)/i.test(details);
 });
}

export async function confirmedEvidenceSourceBlocker(db:Db,args:{
 projectId:string;taskId:string;sourceSha:string
}):Promise<string|null>{
 const r=await db.query(`SELECT report FROM ai_test_runs
  WHERE project_id=$1 AND task_id=$2 AND verdict='failed'
   AND report->>'commit'=$3
  ORDER BY created_at DESC LIMIT 6`,
 [args.projectId,args.taskId,args.sourceSha.toLowerCase()]);
 if(!r.rows.some(x=>confirmedSourceBuildFailure(x.report)))return null;
 return 'На закреплённом SHA '+args.sourceSha.slice(0,12)+
  ' уже подтверждена ошибка компиляции Vue. Повтор на неизменённом SHA '+
  'снова даст пустой экран, а не скриншоты. Требуется выбрать исправленный commit '+
  'и обновить источник задачи, сохранив историю прежней проверки.';
}
