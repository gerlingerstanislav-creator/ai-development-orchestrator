import {mkdir,access} from 'node:fs/promises';
import {join} from 'node:path';
import {gitEnvironment} from './execution-policy.mjs';
import {taskBranchName,ensureTaskBranchHistory} from './task-branch-history.mjs';
import {buildDeveloperPrompt} from './developer-prompt.mjs';
import {parseExistingImplementation,parseNoChangesNeeded} from './development-outcome.mjs';

/** The sole owner of a task's development workspace and branch lifecycle.
 * HTTP, durable scheduling, Codex process and GitHub PR transport remain
 * external ports; the same task ID remains the stable branch/thread identity.
 */
export function createDevelopmentJobRunner({
 runnerStateDir,command,assertJobActive,saveJob,ensureTaskPullRequest,
 isolatedTaskPolicy,threadStore,persistentCli,auditCodexPrompt,
 codexJsonResult,addUsage,cliEnv,resumePublishedCommit,
 isCancelled=()=>false,http=fetch,mkdirWorkdir=mkdir,checkAccess=access
}){
async function runJob(job,state,context){
 const deadline=Date.now()+job.maxRuntimeSeconds*1000;
 const timeLeft=()=>Math.max(0,deadline-Date.now());
 let cumulativeUsage={input_tokens:0,cached_input_tokens:0,output_tokens:0};
 // The workspace is task-owned, not run-owned: QA rework must see the same
 // files and the same Codex thread. Secrets are never stored in Git config.
 const workdir=join(runnerStateDir,'workspaces',job.taskId);
 await mkdirWorkdir(workdir,{recursive:true,mode:0o700});
 const dir=join(workdir,'repo');
 const gitEnv=gitEnvironment(job.token);
 const git=(...args)=>command('git',args,{cwd:dir,env:gitEnv,timeout:45000,jobId:job.id});
 // Stable branch identity: one Git branch per task; different agents cannot
 // work in that branch concurrently (startNextJobs locks repository+taskId).
 const branch=taskBranchName(job.taskId);
 try{
  state.message='Клонирование репозитория';
  let existingWorkspace=false;
  try{await checkAccess(join(dir,'.git'));existingWorkspace=true;}catch{}
  if(!existingWorkspace)await command('git',['clone','--depth','1','--branch',job.baseBranch,'https://github.com/'+job.repository+'.git',dir],
   {cwd:workdir,env:gitEnv,timeout:75000,jobId:job.id});
  else {
   const origin=(await git('remote','get-url','origin')).stdout.trim();
   if(origin!=='https://github.com/'+job.repository+'.git')
    throw Error('Сохранённая рабочая копия относится к другому репозиторию');
   // Never hard reset, checkout -f or clean: a killed Codex turn may leave
   // valuable uncommitted work on disk.
  }
  if(await resumePublishedCommit(job,state,git)){
   state.prUrl=await ensureTaskPullRequest(job,branch,state.checkpoint.commit,'Изменения восстановлены после перезапуска.');
   state.branch=branch;
   assertJobActive(job.id);
   state.status='completed';state.message='Готовый коммит и PR восстановлены из GitHub';
   return;
  }
  // Continue the same branch after failures/restarts if it already exists.
  const remoteBranch=await http('https://api.github.com/repos/'+job.repository+'/branches/'+encodeURIComponent(branch),{
   headers:{Authorization:'Bearer '+job.token,Accept:'application/vnd.github+json','User-Agent':'ai-development-orchestrator'},
   signal:AbortSignal.timeout(20000)
  });
  if(remoteBranch.ok){
   state.message='Продолжение существующей ветки '+branch;
   await git('fetch','--depth','1','origin','refs/heads/'+branch+':refs/remotes/origin/'+branch);
   const currentBranch=(await git('branch','--show-current')).stdout.trim();
   if(currentBranch!==branch){
    const local=(await command('git',['show-ref','--verify','--quiet','refs/heads/'+branch],
     {cwd:dir,env:gitEnv,timeout:10000,jobId:job.id,allowNonzero:true})).exitCode===0;
    await git('checkout',...(local?[branch]:['-b',branch,'refs/remotes/origin/'+branch]));
   }
   // A depth-1 clone of main plus a depth-1 fetch of the task branch often
   // has no merge-base, even when GitHub does. Repair ancestry *before* the
   // model runs, so a 50-second Codex attempt is not wasted on git 128.
   const history=await ensureTaskBranchHistory(git,{baseBranch:job.baseBranch,taskBranch:branch});
   state.branchHistory=history.rehydrated?'restored':'shared';
   const baseRef='refs/remotes/origin/'+job.baseBranch;
   let canFastForward=false;
   try{await git('merge-base','--is-ancestor','HEAD',baseRef);canFastForward=true;}catch{}
   if(canFastForward){
    // Only a true fast-forward of the very same task branch is permitted.
    // No new branch, forced push, synthetic commit or loss of previous work.
    await git('merge','--ff-only',baseRef);
    await git('push','origin','HEAD:refs/heads/'+branch);
   }
  }else if(remoteBranch.status===404){
   const currentBranch=(await git('branch','--show-current')).stdout.trim();
   if(currentBranch!==branch){
    const local=(await command('git',['show-ref','--verify','--quiet','refs/heads/'+branch],
     {cwd:dir,env:gitEnv,timeout:10000,jobId:job.id,allowNonzero:true})).exitCode===0;
    await git('checkout',...(local?[branch]:['-b',branch]));
   }
   state.message='Создание ветки задачи в GitHub';
   // Publish even before Codex edits, so failures retain a stable task branch.
   await git('push','-u','origin','HEAD:refs/heads/'+branch);
  }else{
   throw new Error('Не удалось проверить ветку задачи: GitHub HTTP '+remoteBranch.status);
  }
  state.branch=branch;
  state.message='Изменяет код';
  const prompt=buildDeveloperPrompt(job);
  const policy=await isolatedTaskPolicy(workdir,dir,job.id);
  const developerScope={projectId:job.projectId,taskId:job.taskId,role:'development'};
  let codexTurns=0;
  const runCodex=async(instruction)=>{
   assertJobActive(job.id);
   const remaining=timeLeft();
   if(remaining<15000)throw Error('Исчерпано общее время разработки. Последняя попытка не запускается.');
   const previous=await threadStore.read(developerScope);
   // Initial handoff includes full instructions once. QA rework is a new turn
   // in the SAME thread, with only fresh feedback and the current task state.
   const nextPrompt=previous&&codexTurns===0
    ?'Продолжи разработку ранее назначенной задачи. Не повторяй завершённую работу. '+
     'Проверь текущие файлы и PR, учитывай изменения требований и следующие замечания:\n'+
     ('Задача: '+job.title+'\n'+String(job.description||'').slice(0,4800)+
      '\nЗамечания QA/CI: '+String(job.reworkFeedback||'нет новых замечаний').slice(0,4800))
    :previous&&codexTurns>0
    ?'Продолжи текущую попытку и устрани блокер. '+String(instruction).slice(-2400)
    :instruction;
   codexTurns++;
   await auditCodexPrompt(job,'development',nextPrompt);
   const result=await persistentCli({
    scope:developerScope,requestId:job.id+':dev:'+codexTurns,prompt:nextPrompt,
    model:job.model,reasoning:job.reasoning,cwd:dir,
    timeout:remaining,policyArgs:policy.execArgs,mcpArgs:context.args,
    env:{...cliEnv,...context.env},jobId:job.id,maxOutputChars:500000
   });
   state.threadId=result.threadId;
   const parsed=codexJsonResult(result.stdout);
   cumulativeUsage=addUsage(cumulativeUsage,parsed.usage);
   state.usage=cumulativeUsage;
   return {result,answer:parsed.message,files:await git('status','--porcelain')};
  };
  const completeWithoutEdits=async attempt=>{
   if(attempt.files.stdout.trim())return false;
   const head=(await git('rev-parse','HEAD')).stdout.trim();
   const base=(await git('rev-parse','refs/remotes/origin/'+job.baseBranch)).stdout.trim();
   if(head!==base){
    // Never fabricate a commit when earlier task commits are already present.
    // QA rework requires an explicit, checkable reason that no edits are
    // necessary. On initial recovery, the existing PR can simply be reused.
    const diff=(await git('diff','--name-only','refs/remotes/origin/'+job.baseBranch+'...HEAD')).stdout.trim();
    if(!diff)throw Error('Ветка отличается от базовой, но изменений для PR не обнаружено');
    const rework=String(job.reworkFeedback||'').trim();
    if(rework){
     const tracked=(await git('ls-files')).stdout.split(/\r?\n/).filter(Boolean);
     const review=parseNoChangesNeeded(attempt.answer||'',{headSha:head,trackedFiles:tracked});
     if(!review)return false; // Ask the developer to explain the no-change decision.
     assertJobActive(job.id);
     state.reworkReview=review;
     state.handoffNote='Исправления не требуются. Повторная проверка QA на SHA '+head+
      '. '+review.summary+' Проверено: '+review.files.join(', ')+
      '. Обоснование: '+review.reasons.join(' | ');
     state.message='Разработчик объяснил отсутствие необходимых правок и вернул тот же PR в QA';
    }
    state.prUrl=await ensureTaskPullRequest(job,branch,head,(attempt.answer||'').slice(0,6000));
    state.branch=branch;state.completionKind='pr';state.status='completed';
    if(!rework)state.message='Существующие изменения в ветке переданы в PR без нового коммита';
    return true;
   }
   const tracked=(await git('ls-files')).stdout.split(/\r?\n/).filter(Boolean);
   const evidence=parseExistingImplementation(attempt.answer||'',{baseSha:base,headSha:head,trackedFiles:tracked});
   if(!evidence)return false;
   state.completionKind='already_implemented';
   state.verifiedCommit=head;
   state.implementationEvidence=evidence;
   state.branch=branch; // Persistent task branch, even when QA verifies base SHA.
   state.prUrl=null;
   state.handoffNote=evidence.summary;
   state.status='completed';
   state.message='Разработчик подтвердил существующую реализацию в базовой ветке. Требуется независимый QA.';
   return true;
  };
  let attempt=await runCodex(prompt);
  if(!attempt.files.stdout.trim()){
   if(await completeWithoutEdits(attempt))return;
   if(timeLeft()<45000)throw Error('Не представлены ни изменения, ни подтверждение готовой реализации; времени на повторную попытку недостаточно');
   state.message='Уточняет результат разработки: изменения, повторное использование PR или доказательство готового кода';
   attempt=await runCodex(prompt+'\n\nПовторная попытка: если код уже соответствует замечаниям QA, обязательно предъяви RESULT: no_changes_needed и REWORK_REVIEW с явным объяснением, ссылками на файлы и проверяемыми причинами; если реализация уже в базовой ветке — используй RESULT: already_implemented и IMPLEMENTATION_EVIDENCE. Иначе исправь код. Не меняй файлы только ради коммита. Предыдущий ответ: '+String(attempt.answer||'').slice(-1100));
   if(!attempt.files.stdout.trim()){
    if(await completeWithoutEdits(attempt))return;
    throw Error('Агент не представил изменений или проверяемого доказательства уже реализованной задачи: '+String(attempt.answer||'').slice(-1300));
   }
  }
  assertJobActive(job.id);
  const previous=(await git('rev-parse','HEAD')).stdout.trim();
  state.message='Создание коммита';
  await git('add','--all');
  const staged=await git('diff','--cached','--name-only');
  if(staged.stdout.split('\n').some(x=>/(^|\/)(\.env(\.|$)|auth\.json$|\.git\/|credentials(\.|\/|$))/.test(x)))
   throw new Error('Обнаружены потенциально секретные файлы. Коммит отменён');
  await command('git',['-c','user.name=AI Development Orchestrator','-c','user.email=ai-orchestrator@users.noreply.github.com',
   'commit','-m','AI: '+job.title.slice(0,120)],{cwd:dir,env:gitEnv,timeout:30000});
  const handoff=String(attempt.answer||'').match(/HANDOFF_NOTE:\s*([^\n\r]{1,2800})/i)?.[1]?.trim()||'';
  state.handoffNote=/^(none|нет|отсутствуют)[.!]?$/i.test(handoff)?'':handoff.slice(0,2500);
   const learning=String(attempt.answer||'').match(/LEARNING_SUGGESTION:\s*([^\n\r]{1,1600})/i)?.[1]?.trim()||'';
   state.learningSuggestion=/^(none|нет|отсутствуют)[.!]?$/i.test(learning)?'':learning.slice(0,1600);
  const commit=(await git('rev-parse','HEAD')).stdout.trim();
  assertJobActive(job.id);
  state.checkpoint={previous,commit};
  state.message='Отправка ветки GitHub';
  saveJob(job,state);
  await git('push','-u','origin','HEAD:refs/heads/'+branch);
  assertJobActive(job.id);
  state.message='Создание Pull Request';
  const prBody=String(attempt.answer||'').replace(/^LEARNING_SUGGESTION:.*$/gmi,'').trim();
  const prUrl=await ensureTaskPullRequest(job,branch,commit,prBody||'Изменения подготовлены.');
  assertJobActive(job.id);
  state.prUrl=prUrl;state.completionKind='pr';state.status='completed';state.message='Pull Request создан. Проверь изменения перед слиянием.';
 }catch(e){
  if(!isCancelled(job.id)){state.status='failed';state.message=String(e?.message||e).replaceAll(job.token,'[REDACTED]').slice(0,3500);}
 }finally{
  // Workspace is retained until the task is closed and explicitly archived.
 }
}
 return runJob;
}
