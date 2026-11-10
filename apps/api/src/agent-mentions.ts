import type {Pool} from 'pg';

export type MentionedAgent={alias:'Analyst'|'QA';stage:'analysis'|'testing';name:string;instructions:string;message:string};
const ALIASES={analyst:'analysis',qa:'testing'} as const;

/** Parse only an explicit leading address; other @mentions remain ordinary text. */
export function parseAgentMention(message:string):{alias:'Analyst'|'QA';stage:'analysis'|'testing';message:string}|null{
 const match=/^\s*@(Analyst|QA)(?=\s|[:,.!?]|$)[\s,:.!?]*/i.exec(message);
 if(!match)return null;
 const alias=match[1].toLowerCase()==='qa'?'QA':'Analyst';
 return {alias,stage:ALIASES[alias.toLowerCase() as keyof typeof ALIASES],message:message.slice(match[0].length).trim()};
}
export async function resolveAgentMention(pool:Pool,projectId:string,message:string):Promise<MentionedAgent|null>{
 const mention=parseAgentMention(message);
 if(!mention)return null;
 const result=await pool.query('SELECT agent_name,agent_instructions FROM workflow_stages WHERE project_id=$1 AND stage=$2',[projectId,mention.stage]);
 if(!result.rowCount)throw Object.assign(new Error('Агент '+mention.alias+' не настроен в Workflow проекта'),{statusCode:422});
 if(!mention.message)throw Object.assign(new Error('После @'+mention.alias+' напиши сообщение агенту'),{statusCode:400});
 const stage=result.rows[0];
 return {...mention,name:String(stage.agent_name||mention.alias),instructions:String(stage.agent_instructions||'')};
}
export const AGENT_MENTION_HINT='Обращение через @Analyst или @QA направляет вопрос непосредственно выбранному специалисту. Это консультация, не запуск этапа Workflow и не изменение утверждённого ТЗ.';
