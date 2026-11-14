/** Capabilities are granted to a concrete task assignment, never to an entire role.
 * Only side effects with existing project-level safety checks are delegable here.
 * Code changes, QA approval, merge, deployment, secrets and owner decisions remain
 * behind their dedicated verifiable workflows.
 */
export const taskGrantableTools=[
 'documents.create','documents.update','documents.delete','documents.changeset',
 'memory.record'
] as const;

const grantable=new Set<string>(taskGrantableTools);
export function normalizeTaskToolGrants(value:readonly string[]|undefined):string[]{
 if(!value)return [];
 if(!Array.isArray(value)||value.length>taskGrantableTools.length)
  throw Object.assign(Error('Слишком много запрошенных инструментов'),{statusCode:400});
 if(value.some(name=>typeof name!=='string'||!grantable.has(name)))
  throw Object.assign(Error('Инструмент нельзя передать через поручение'),{statusCode:403});
 return [...new Set(value)].sort();
}

/** A delegated specialist can pass on only grants already held by its parent
 * assignment. Target role's own baseline tools never need a grant.
 */
export function restrictChildToolGrants(requested:readonly string[],parent:readonly string[]){
 const allowed=new Set(parent);
 if(requested.some(name=>!allowed.has(name)))
  throw Object.assign(Error('Нельзя передавать права, которых нет у исходного поручения'),{statusCode:403});
 return requested;
}
