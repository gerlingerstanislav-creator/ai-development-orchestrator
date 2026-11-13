/** Keep strict Codex CLI sandbox policies for QA/browser and architecture
 * while still persisting their conversation IDs across process restarts.
 * Uses the same thread store as App Server (both persist to CODEX_HOME).
 */
export function codexThreadIdFromJson(line){
 try{
  const event=JSON.parse(line);
  const id=event.type==='thread.started'?(event.thread_id||event.thread?.id):null;
  return typeof id==='string'&&/^[a-zA-Z0-9_-]{8,128}$/.test(id)?id:null;
 }catch{return null;}
}
export function createPersistentCliExecutor(store,command){
 return async function run({scope,requestId,model,reasoning,prompt,cwd,env,
  policyArgs=[],mcpArgs=[],outputSchema,timeout,jobId,maxOutputChars=350000}){
  return store.run(scope,requestId,async()=>{
   const saved=await store.read(scope);
   const common=['-m',model,'-c','model_reasoning_effort="'+reasoning+'"',
    '--json','--skip-git-repo-check',...policyArgs,...mcpArgs];
   // The output schema is used for first turns. On resume, follow-up prompts
   // are validated by the existing QA verifier regardless of model prose.
   const args=['exec',...common,...(outputSchema?['--output-schema',outputSchema]:[]),
    ...(saved?['resume',saved.threadId]:[]),prompt];
   let pending='',seenThread=false;
   const writes=[];
   let result;
   try{
    result=await command('codex',args,{cwd,env,timeout,jobId,maxOutputChars,
     onStdout:chunk=>{
      pending=(pending+chunk).slice(-200000);
      for(let i=pending.indexOf('\n');i>=0;i=pending.indexOf('\n')){
       const line=pending.slice(0,i);pending=pending.slice(i+1);
       const threadId=codexThreadIdFromJson(line);
       if(threadId&&!seenThread){seenThread=true;writes.push(store.save(scope,threadId));}
      }
     }
    });
   }finally{
    // Preserve the thread ID even when the Codex turn times out after emitting
    // its first event. Never silently lose a failed storage write.
    await Promise.all(writes);
   }
   const current=await store.read(scope);
   if(!current)throw Error('Codex CLI не сохранил идентификатор сессии для безопасного продолжения');
   return {...result,threadId:current.threadId};
  });
 };
}
