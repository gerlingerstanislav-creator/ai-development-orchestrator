/**
 * The Codex account and runner host are shared resources. Project capacity is
 * independent: choose the runnable job from the project with the fewest active
 * jobs so one busy project cannot monopolize newly available runner slots.
 *
 * This is deliberately a pure selector: execution and durable journals remain
 * owned by the runner.
 */
export const jobRole=job=>job.kind==='test'?'testing':job.kind==='review'?'architect':job.kind==='ci'?'devops':'development';
export const projectKey=job=>job.projectId||job.repository;

export function nextRunnableJobIndex(queue,{activeBranches,activeByRole,activeByProject,defaultRoleCapacity=1}){
 let chosen=-1;
 let fewestActive=Infinity;
 for(let i=0;i<queue.length;i++){
  const job=queue[i].job;
  const role=jobRole(job);
  const key=projectKey(job);
  const roleKey=key+':'+role;
  const capacity=Number.isInteger(job.roleCapacity)?Math.min(10,Math.max(1,job.roleCapacity)):defaultRoleCapacity;
  if(activeBranches.has(job.repository+':'+job.taskId)||(activeByRole.get(roleKey)||0)>=capacity)continue;
  const active=activeByProject.get(key)||0;
  if(active<fewestActive){
   fewestActive=active;
   chosen=i;
  }
 }
 return chosen;
}
