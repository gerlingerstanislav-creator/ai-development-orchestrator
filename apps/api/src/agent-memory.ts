import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {applicabilityText,type Applicability} from './instruction-governance.js';

type Db=Pick<Pool,'query'>;
type MemoryLimits={instructions?:number;observations?:number};
type MemoryRow={body:string;kind:string;applicability:Applicability|null};

const normalize=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('ru').replace(/\s+/g,' ').trim();
const matchesScope=(scope:Applicability,contextHint:string)=>{
 const terms=Object.values(scope||{}).filter((value):value is string=>typeof value==='string'&&!!value.trim());
 if(!terms.length)return true;
 const hint=normalize(contextHint);
 if(!hint)return false;
 return terms.every(term=>{
  const escaped=normalize(term).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp('(^|[^\\p{L}\\p{N}_])'+escaped+'(?=$|[^\\p{L}\\p{N}_])','u').test(hint);
 });
};
function withinBudget(entries:string[],budget:number){
 const result:string[]=[];
 let length=0;
 for(const entry of entries){
  const line='- '+entry;
  if(length+line.length+(result.length?1:0)>budget)continue;
  result.push(line);
  length+=line.length+(result.length>1?1:0);
 }
 return result.join('\n');
}

/** Approved rules belong in the role profile; observations are contextual data.
 * Scoped knowledge must match this project/task, never just be ranked lower. */
export async function agentMemorySections(
 pool:Db,projectId:string,role:string,contextHint='',
 limits:MemoryLimits={}
):Promise<{instructions:string;observations:string}>{
 const rows=(await pool.query(`SELECT body,evidence,kind,applicability,status FROM agent_memory
 WHERE project_id=$1 AND role=$2 AND ((kind='observation' AND status IN ('recorded','approved')) OR (kind='instruction_suggestion' AND status='approved'))
 ORDER BY created_at DESC,id DESC LIMIT 80`,[projectId,role])).rows as MemoryRow[];
 const instructions:string[]=[];
 const observations:string[]=[];
 const seen=new Set<string>();
 for(const row of rows){
  const scope=(row.applicability||{}) as Applicability;
  if(!matchesScope(scope,contextHint))continue;
  const body=String(row.body||'').trim().slice(0,800);
  if(!body||seen.has(normalize(body)))continue;
  seen.add(normalize(body));
  const text=body+(Object.values(scope).some(Boolean)?' [Применять только если '+applicabilityText(scope)+']':'');
  if(row.kind==='instruction_suggestion')instructions.push(text);
  else if(row.kind==='observation')observations.push('Опыт, не обязательное правило: '+text);
 }
 return {
  instructions:withinBudget(instructions,limits.instructions??3300),
  observations:withinBudget(observations,limits.observations??1300)
 };
}

/** Compatible combined memory for existing specialists; still bounded and scoped. */
export async function agentMemoryContext(pool:Db,projectId:string,role:string,contextHint=''){
 const sections=await agentMemorySections(pool,projectId,role,contextHint);
 return [sections.instructions,sections.observations].filter(Boolean).join('\n').slice(0,4800);
}

/** One suggested reusable lesson per completed execution, never auto-approved. */
export async function recordAgentLearning(pool:Pool,args:{projectId:string;role:string;runId:string;body:unknown;evidence:string}){
 if(typeof args.body!=='string')return;
 const clean=args.body.trim().replace(/(?:gh[pousr]_|github_pat_|sk-[A-Za-z0-9_-]{10,})[A-Za-z0-9_-]{8,}/g,'[REDACTED]');
 if(clean.length<20||clean.length>1600||/^(none|нет|отсутствует|не выявлено)[.!]?$/i.test(clean))return;
 await pool.query(`INSERT INTO agent_memory(id,project_id,role,kind,body,evidence,status,origin,source_run_id)
  VALUES($1,$2,$3,'instruction_suggestion',$4,$5,'proposed','agent',$6)
  ON CONFLICT DO NOTHING`,[randomUUID(),args.projectId,args.role,clean,args.evidence.slice(0,600),args.runId]);
}
