/**
 * One stable Git branch belongs to one task. A developer returning from QA
 * must continue that branch, never fabricate a new branch per attempt.
 *
 * Shallow clones do not necessarily share the base's history after the task
 * branch is fetched with --depth 1. Rehydrate ancestry only when needed.
 * Without a proven common ancestor we must not treat the diff as a task PR.
 */
export function taskBranchName(taskId){
 if(typeof taskId!=='string'||!/^[a-f0-9]{8}-[a-f0-9-]{27,36}$/i.test(taskId))
  throw Error('Некорректный идентификатор задачи для рабочей ветки');
 return taskId;
}
export async function ensureTaskBranchHistory(git,{baseBranch,taskBranch}){
 const baseRef='refs/remotes/origin/'+baseBranch;
 const topicRef='refs/remotes/origin/'+taskBranch;
 const commonAncestor=async()=>{
  try{return (await git('merge-base',baseRef,'HEAD')).stdout.trim();}
  catch{return '';}
 };
 const existing=await commonAncestor();
 if(existing)return {mergeBase:existing,rehydrated:false};
 const shallow=(await git('rev-parse','--is-shallow-repository')).stdout.trim()==='true';
 const refspecs=[
  '+refs/heads/'+baseBranch+':'+baseRef,
  '+refs/heads/'+taskBranch+':'+topicRef
 ];
 // Fetch complete history of both references, not the whole repo's branches.
 // --unshallow is legal only if the local repository is shallow.
 await git('fetch',...(shallow?['--unshallow']:[]),'origin',...refspecs);
 const mergeBase=await commonAncestor();
 if(!mergeBase)throw Error('TASK_BRANCH_NO_COMMON_ANCESTOR: рабочая ветка задачи не имеет общего предка с '+baseBranch+
  '. Нельзя создавать PR автоматически; требуется проверка истории ветки.');
 return {mergeBase,rehydrated:true};
}
