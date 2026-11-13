import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import type {Client} from '@temporalio/client';
import {z} from 'zod';
import {createMergeService} from '../../../merge-service.js';
import {createMergeBatch,readMergeBatch} from '../../../merge-batch.js';

type MergeDeps={
 app:FastifyInstance;
 pool:Pool;
 uid:(req:any)=>string;
 access:(req:any,reply:any,projectId:string)=>Promise<boolean>;
 requireAdmin:(req:any,reply:any)=>Promise<boolean>;
 temporal:()=>Promise<Client>;
 decryptToken:(encrypted:string)=>string;
};
function parse<T extends z.ZodTypeAny>(schema:T,input:unknown):z.infer<T>{return schema.parse(input);}

/**
 * Merge HTTP boundary. The existing merge service owns QA, CI, GitHub and
 * database invariants; Temporal remains the only long-lived batch executor.
 */
export function registerMergeOperationsRoutes({app,pool,uid,access,requireAdmin,temporal,decryptToken}:MergeDeps){
 const {mergeTaskPr}=createMergeService(pool,decryptToken);

 async function startMergeBatch(batchId:string){
  const client=await temporal();
  await client.withDeadline(Date.now()+5000,()=>client.workflow.start('mergeReadyBatch',{
   workflowId:'merge-ready-'+batchId,workflowIdReusePolicy:'REJECT_DUPLICATE',taskQueue:'agent-pipeline',args:[batchId]
  }));
 }

 app.post('/api/projects/:id/tasks/:taskId/merge',async(req:any,reply)=>{
  const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  try{return await mergeTaskPr(id,taskId,uid(req));}
  catch(error){const err=error as Error&{statusCode?:number};return reply.code(err.statusCode||502).send({error:err.message});}
 });

 app.post('/api/projects/:id/merge-ready',async(req:any,reply)=>{
  const {id}=parse(z.object({id:z.string().uuid()}),req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const batch=await createMergeBatch(pool,id,uid(req));
  return reply.code(202).send(batch);
 });

 app.get('/api/projects/:id/merge-ready/:batchId',async(req:any,reply)=>{
  const {id,batchId}=parse(z.object({id:z.string().uuid(),batchId:z.string().uuid()}),req.params);
  if(!await access(req,reply,id))return;
  const batch=await readMergeBatch(pool,id,batchId);
  return batch??reply.code(404).send({error:'Очередь слияния не найдена'});
 });

 return {mergeTaskPr,startMergeBatch};
}
