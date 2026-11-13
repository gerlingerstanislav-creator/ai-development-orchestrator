import {randomUUID} from 'node:crypto';

/** A durable Codex thread belongs to a logical responsibility, never a
 * one-shot MCP credential, HTTP connection or Temporal retry attempt.
 */
export function conversationThreadScope(data,fallbackRole='assistant'){
 const role=String(data.agent_role||data.context?.role||fallbackRole);
 const rawProject=data.project_id||data.context?.projectId;
 const projectId=typeof rawProject==='string'&&rawProject.trim()?rawProject:randomUUID();
 const rawOwner=data.actor_id||data.context?.actorId;
 const owner=typeof rawOwner==='string'&&/^[a-f0-9-]{36}$/i.test(rawOwner)?rawOwner:null;
 const taskId=data.task_id||data.context?.taskId||undefined;
 const processId=role==='manager'&&!taskId&&owner
  ?'owner-chat:'+owner
  :String(data.process_id||data.context?.processId||
   (owner?'project-chat:'+owner:randomUUID()));
 return {projectId,role,taskId,processId};
}
