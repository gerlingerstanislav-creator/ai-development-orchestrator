/** Bounded orchestration of short, idempotent queue reconciliation passes.
 *
 * This is only the periodic dispatcher: long-running user work still runs in
 * Temporal. One API replica never starts overlapping queue scans, while each
 * distributed worker keeps its existing database/Temporal idempotency locks.
 */
export type ReconciliationJob={
 label:string;
 execute:()=>Promise<unknown>;
};

export function createQueueReconciler(
 jobs:readonly ReconciliationJob[],
 reportError:(label:string,error:unknown)=>void
){
 const steps=[...jobs];
 let active:Promise<void>|null=null;

 function run():Promise<void>{
  if(active)return active;
  // Defer job execution until the flight is assigned, including when there
  // are no jobs or the first action rejects synchronously.
  const pass=Promise.resolve().then(async()=>{
   for(const job of steps){
    try{await job.execute();}
    catch(error){
     // A failed worker must not prevent the other independent queues from
     // recovering. Logging itself must not wedge this reconciler.
     try{reportError(job.label,error);}catch{/* Best-effort diagnostics. */}
    }
   }
  });
  active=pass;
  void pass.then(
   ()=>{if(active===pass)active=null;},
   ()=>{if(active===pass)active=null;}
  );
  return pass;
 }

 return {run,isRunning:()=>active!==null};
}
