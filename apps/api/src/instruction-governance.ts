import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';

export const teamRoles=['manager','analyst','analysis','development','testing','documentation','devops','architect'] as const;
export const applicabilitySchema=z.object({
 technology:z.string().trim().max(90).optional(),
 repository:z.string().trim().max(180).optional(),
 task_type:z.string().trim().max(90).optional()
}).strict();
export type Applicability=z.infer<typeof applicabilitySchema>;
export const instructionProposal=z.object({
 target_roles:z.array(z.enum(teamRoles)).min(1).max(teamRoles.length).refine(v=>new Set(v).size===v.length,'Роли должны быть уникальны'),
 text:z.string().trim().min(5).max(1600),
 applicability:applicabilitySchema.default({}),
 source_message_id:z.string().uuid().optional(),
 reason:z.string().trim().max(600).default(''),
 supersedes_id:z.string().uuid().optional()
}).strict();
type Db=Pick<Pool,'query'>;
type Rule={id:string;role:string;body:string;status:string;applicability:Applicability;source_message_id?:string|null};
export const normalizedInstruction=(body:string)=>body.normalize('NFKC').replace(/ё/gi,'е').toLocaleLowerCase('ru').replace(/\s+/g,' ').trim();
function tokens(s:string){
 return new Set((normalizedInstruction(s).match(/[\p{L}\p{N}]{4,}/gu)||[]));
}
function similarity(a:string,b:string){
 const aa=tokens(a),bb=tokens(b);if(!aa.size||!bb.size)return 0;
 let count=0;for(const x of aa)if(bb.has(x))count++;
 return count/Math.max(aa.size,bb.size);
}
function scopeOverlaps(a:Applicability={},b:Applicability={}){
 return (['technology','repository','task_type'] as const).every(k=>!a?.[k]||!b?.[k]||normalizedInstruction(a[k]!)===normalizedInstruction(b[k]!));
}
const denial=(s:string)=>/\b(?:не|нельзя|запрещено|никогда|avoid|never|do not)\b/i.test(s);
export function inspectInstruction(text:string,applicability:Applicability,rules:Rule[]){
 return rules.filter(r=>scopeOverlaps(applicability,r.applicability||{})).map(r=>{
  const exact=normalizedInstruction(text)===normalizedInstruction(r.body);
  const score=similarity(text,r.body);
  return {id:r.id,role:r.role,status:r.status,body:r.body,applicability:r.applicability||{},
   relation:exact?'duplicate':score>=0.35&&denial(text)!==denial(r.body)?'possible_conflict':score>=0.65?'possible_overlap':'other',
   similarity:Math.round(score*100)/100};
 }).filter(r=>r.relation!=='other');
}
export async function reconcileInstructions(db:Db,projectId:string,roles:string[],text:string,applicability:Applicability={}){
 const r=await db.query(`SELECT id,role,body,status,applicability,source_message_id FROM agent_memory
  WHERE project_id=$1 AND role=ANY($2::text[]) AND kind='instruction_suggestion'
  AND status IN ('approved','proposed') ORDER BY created_at DESC LIMIT 300`,[projectId,roles]);
 return inspectInstruction(text,applicability,r.rows);
}
/** A PM can distribute user instructions, but only a verbatim authenticated owner's
 * instruction with no detected overlap is automatically approved. Rewrites and
 * substitutions must be reviewed in Team; no model can bypass that policy. */
export async function proposeInstruction(db:Db,projectId:string,params:z.infer<typeof instructionProposal>){
 const existing=await reconcileInstructions(db,projectId,params.target_roles,params.text,params.applicability);
 let direct=false,ownerId:string|null=null;
 if(params.source_message_id){
  const source=(await db.query(`SELECT m.actor_id,m.body,p.owner_id
   FROM assistant_messages m JOIN projects p ON p.id=m.project_id
   WHERE m.project_id=$1 AND m.id=$2 AND m.role='user' AND m.channel='project'`,
   [projectId,params.source_message_id])).rows[0];
  if(!source)throw Object.assign(Error('Источник должен быть реальным сообщением пользователя проекта'),{statusCode:409});
  ownerId=source.actor_id;
  direct=!!source.actor_id&&source.actor_id===source.owner_id&&String(source.body).trim()===params.text;
 }
 if(params.supersedes_id){
  const r=await db.query(`SELECT id FROM agent_memory WHERE project_id=$1 AND id=$2
   AND role=ANY($3::text[]) AND kind='instruction_suggestion' AND status='approved'`,
   [projectId,params.supersedes_id,params.target_roles]);
  if(!r.rowCount)throw Object.assign(Error('Заменяемая инструкция не найдена среди утверждённых инструкций адресатов'),{statusCode:404});
 }
 const groupId=randomUUID(),results=[];
 for(const role of params.target_roles){
  const found=existing.find(v=>v.role===role&&v.relation==='duplicate');
  if(found){results.push({id:found.id,role,status:found.status,duplicate:true});continue;}
  const overlap=existing.some(v=>v.role===role&&v.relation!=='duplicate');
  const approved=direct&&!overlap&&!params.supersedes_id;
  const id=randomUUID(),status=approved?'approved':'proposed';
  const row=await db.query(`INSERT INTO agent_memory
   (id,project_id,role,kind,body,evidence,status,origin,author_id,reviewed_at,applicability,source_message_id,instruction_group_id,supersedes_id)
   VALUES($1,$2,$3,'instruction_suggestion',$4,$5,$6,$7,$8,CASE WHEN $6='approved' THEN now() ELSE NULL END,$9::jsonb,$10,$11,$12)
   RETURNING id`,[id,projectId,role,params.text,params.reason,status,approved?'user':'agent',ownerId,JSON.stringify(params.applicability),params.source_message_id||null,groupId,params.supersedes_id||null]);
  results.push({id:row.rows[0].id,role,status,duplicate:false});
 }
 return {results,overlaps:existing,needs_review:results.some(r=>r.status==='proposed'),group_id:groupId};
}
export function applicabilityText(scope:Applicability={}){
 const entries=Object.entries(scope).filter(([,v])=>!!v);
 return entries.map(([k,v])=>({technology:'технология',repository:'репозиторий',task_type:'тип задачи'}[k]||k)+': '+v).join('; ');
}
