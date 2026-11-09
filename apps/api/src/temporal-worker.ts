import {NativeConnection,Worker} from '@temporalio/worker';
import * as activities from './temporal-activities.js';

const address=process.env.TEMPORAL_ADDRESS||'temporal:7233';
async function main(){
 const conn=await NativeConnection.connect({address});
 try{
  const worker=await Worker.create({
   connection:conn,namespace:'default',taskQueue:'agent-pipeline',
   workflowsPath:new URL('./temporal-workflows.js',import.meta.url).pathname,
   activities,maxConcurrentActivityTaskExecutions:12
  });
  console.log('Temporal worker started: '+address);
  await worker.run();
 }finally{await conn.close();}
}
main().catch(e=>{console.error('Temporal worker fatal:',e);process.exitCode=1;});
