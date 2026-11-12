export type ProjectSection='overview'|'tasks'|'plan'|'docs'|'qa'|'processes'|'team'|'workflow'|'settings';
export type AppRoute={kind:'projects'|'account'|'project'|'not-found';projectId?:string;section?:ProjectSection;taskId?:string;docId?:string;planning?:boolean;iterationId?:string};
export const uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function parseAppRoute(pathname:string):AppRoute{
 const parts=pathname.split('/').filter(Boolean);
 if(parts.length===0||parts.length===1&&parts[0]==='projects')return {kind:'projects'};
 if(parts.length===2&&parts[0]==='account'&&parts[1]==='settings')return {kind:'account'};
 if(parts[0]==='projects'&&parts.length>=2&&uuidPattern.test(parts[1])){
  const projectId=parts[1];
  if(parts.length===2)return {kind:'project',projectId,section:'tasks'};
  if(parts.length===3&&['overview','tasks','plan','docs','qa','processes','team','workflow','settings'].includes(parts[2]))
   return {kind:'project',projectId,section:parts[2] as ProjectSection};
  if(parts.length===4&&parts[2]==='tasks'&&uuidPattern.test(parts[3]))
   return {kind:'project',projectId,section:'tasks',taskId:parts[3]};
  if(parts[2]==='plan'&&parts.length===4&&uuidPattern.test(parts[3]))
   return {kind:'project',projectId,section:'plan',planning:true,iterationId:parts[3]};
  if(parts[2]==='docs'&&parts[3]==='plan'&&(parts.length===4||parts.length===5&&uuidPattern.test(parts[4])))
   return {kind:'project',projectId,section:'plan',planning:true,iterationId:parts[4]};
  if(parts.length===4&&parts[2]==='docs'&&uuidPattern.test(parts[3]))
   return {kind:'project',projectId,section:'docs',docId:parts[3]};
 }
 return {kind:'not-found'};
}
export function projectUrl(projectId:string,section:ProjectSection='tasks'){
 return '/projects/'+encodeURIComponent(projectId)+'/'+section;
}
