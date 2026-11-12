import {NativeConnection,Worker} from '@temporalio/worker';
import * as activities from './temporal-activities.js';

const address=process.env.TEMPORAL_ADDRESS||'temporal:7233';
// Long-running QA/CI activities await external jobs. Keep enough worker slots
// for independent projects without removing the bounded shared-resource guard.
const parsedConcurrency=Number(process.env.TEMPORAL_ACTIVITY_CONCURRENCY||48);
const activityConcurrency=Number.isInteger(parsedConcurrency)?Math.min(128,Math.max(12,parsedConcurrency)):48;
async function main(){
 const conn=await NativeConnection.connect({address});
 try{
  const worker=await Worker.create({
   connection:conn,namespace:'default',taskQueue:'agent-pipeline',
   workflowsPath:new URL('./temporal-workflows.js',import.meta.url).pathname,
   activities,maxConcurrentActivityTaskExecutions:activityConcurrency
  });
  console.log('Temporal worker started: '+address);
  await worker.run();
 }finally{await conn.close();}
}
main().catch(e=>{console.error('Temporal worker fatal:',e);process.exitCode=1;});
