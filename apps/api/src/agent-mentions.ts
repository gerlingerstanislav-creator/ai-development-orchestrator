import type {Pool} from 'pg';

export type MentionedAgent={alias:'Analyst'|'QA'|'DevOps';stage:'analysis'|'testing'|'devops';name:string;instructions:string;message:string};
const ALIASES={analyst:'analysis',qa:'testing',devops:'devops'} as const;

/** Only an explicit leading @address selects a specialist. */
export function parseAgentMention(message:string):{alias:'Analyst'|'QA'|'DevOps';stage:'analysis'|'testing'|'devops';message:string}|null{
 const match=/^\s*@(Analyst|QA|DevOps)(?=\s|[:,.!?]|$)[\s,:.!?]*/i.exec(message);
 if(!match)return null;
 const key=match[1].toLowerCase() as keyof typeof ALIASES;
 const alias=key==='qa'?'QA':key==='devops'?'DevOps':'Analyst';
 return {alias,stage:ALIASES[key],message:message.slice(match[0].length).trim()};
}
export async function resolveAgentMention(pool:Pick<Pool,'query'>,projectId:string,message:string):Promise<MentionedAgent|null>{
 const mention=parseAgentMention(message);
 if(!mention)return null;
 if(!mention.message)throw Object.assign(new Error('После @'+mention.alias+' напиши сообщение агенту'),{statusCode:400});
 const result=mention.stage==='devops'
  ?await pool.query("SELECT COALESCE(NULLIF(w.agent_name,''),p.agent_name) AS agent_name, CONCAT_WS(E'\\n',p.agent_instructions,w.agent_instructions) AS agent_instructions FROM project_specialist_agents p LEFT JOIN workflow_stages w ON w.project_id=p.project_id AND w.stage='deployment' WHERE p.project_id=$1 AND p.role=$2",[projectId,'devops'])
  :await pool.query('SELECT agent_name,agent_instructions FROM workflow_stages WHERE project_id=$1 AND stage=$2',[projectId,mention.stage]);
 if(!result.rowCount)throw Object.assign(new Error('Агент '+mention.alias+' не настроен в проекте'),{statusCode:422});
 const stage=result.rows[0];
 return {...mention,name:String(stage.agent_name||mention.alias),instructions:String(stage.agent_instructions||'')};
}
export const AGENT_MENTION_HINT='Обращение через @Analyst, @QA или @DevOps направляет вопрос непосредственно выбранному специалисту. Консультация не запускает Workflow, не изменяет CI/CD и не выполняет деплой.';
