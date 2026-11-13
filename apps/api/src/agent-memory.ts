import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {applicabilityText,type Applicability} from './instruction-governance.js';

/** Approved directives only; observations remain labelled as experience, not commands.
 * A scope is always explicit so a Laravel rule cannot become a Node.js mandate. */
export async function agentMemoryContext(pool:Pick<Pool,'query'>,projectId:string,role:string,contextHint=''){
 const rows=(await pool.query(`SELECT body,evidence,kind,applicability,status FROM agent_memory
 WHERE project_id=$1 AND role=$2 AND ((kind='observation' AND status IN ('recorded','approved')) OR (kind='instruction_suggestion' AND status='approved'))
 ORDER BY created_at DESC,id DESC LIMIT 80`,[projectId,role])).rows;
 const words=contextHint.toLowerCase();
 const ranked=rows.map((r:any)=>{
  const scope=(r.applicability||{}) as Applicability;
  const fields=Object.values(scope).filter(Boolean).map(value=>String(value).toLowerCase());
  const matched=fields.length>0&&fields.every(value=>words.includes(value));
  const text=String(r.body).slice(0,800);
  return {score:r.kind==='instruction_suggestion'?(matched?4:fields.length?1:3):0,
   line:(r.kind==='observation'?'Опыт, не обязательное правило: ':'')+text+
    (fields.length?' [Применять только если '+applicabilityText(scope)+']':'')};
 }).sort((a:any,b:any)=>b.score-a.score);
 const lines=ranked.map((r:any)=>'- '+r.line);
 let answer='';
 for(const line of lines){if(answer.length+line.length+1>4800)break;answer+=(answer?'\n':'')+line;}
 return answer;
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
