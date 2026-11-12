import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';

type Deps={
 pool:Pick<Pool,'query'>;
 access:(req:any,reply:any,projectId:string)=>Promise<boolean>;
 requireAdmin:(req:any,reply:any)=>Promise<boolean>;
};
function parse<T extends z.ZodTypeAny>(schema:T,input:unknown):z.infer<T>{return schema.parse(input);}

/** Project AI configuration and usage reporting: no Runner dispatch side effects. */
export function registerAiSettingsRoutes(app:FastifyInstance,{pool,access,requireAdmin}:Deps){
// A limited allowlist and manual trigger prevent runaway usage.
const allowedModels=z.enum(['gpt-6-luna','gpt-6-sol','gpt-6.1-sol']);
const projectAiSchema=z.object({
 model:allowedModels,
 reasoning:z.enum(['low','medium']),
 enabled:z.boolean()
});
const aiDefaults={model:'gpt-6-luna',reasoning:'low',enabled:false};
app.get('/api/projects/:id/ai-settings',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const row=await pool.query('SELECT model,reasoning,enabled FROM project_ai_settings WHERE project_id=$1',[id]);
 return row.rows[0]||aiDefaults;
});
app.put('/api/projects/:id/ai-settings',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 if(!await requireAdmin(req,reply))return;
 const p=projectAiSchema.parse(req.body);
 await pool.query("INSERT INTO project_ai_settings(project_id,model,reasoning,enabled) VALUES($1,$2,$3,$4) ON CONFLICT(project_id) DO UPDATE SET model=EXCLUDED.model,reasoning=EXCLUDED.reasoning,enabled=EXCLUDED.enabled,updated_at=now()",
 [id,p.model,p.reasoning,p.enabled]);
 return p;
});
app.get('/api/ai/token-usage',async(req:any,reply)=>{
 if(!await requireAdmin(req,reply))return;
 const totals=await pool.query("SELECT COALESCE(SUM(input_tokens),0)::text AS input_tokens,COALESCE(SUM(cached_input_tokens),0)::text AS cached_input_tokens,COALESCE(SUM(output_tokens),0)::text AS output_tokens,COUNT(*)::int AS requests FROM ai_token_usage");
 const latest=await pool.query("SELECT operation,model,input_tokens::text,cached_input_tokens::text,output_tokens::text,created_at FROM ai_token_usage ORDER BY created_at DESC LIMIT 20");
 return {totals:totals.rows[0],latest:latest.rows};
});
app.get('/api/projects/:id/token-usage',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const result=await pool.query("SELECT COALESCE(SUM(input_tokens),0)::text AS input_tokens,COALESCE(SUM(cached_input_tokens),0)::text AS cached_input_tokens,COALESCE(SUM(output_tokens),0)::text AS output_tokens,COUNT(*)::int AS requests FROM ai_token_usage WHERE project_id=$1",[id]);
 return result.rows[0];
});
app.get('/api/projects/:id/ai-runs',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const runs=await pool.query(`SELECT id,task_id,model,status,branch,pr_url,message,created_at,completed_at,cycle_id
  FROM ai_task_runs WHERE project_id=$1
  UNION ALL
  SELECT q.run_id,q.task_id,COALESCE(s.model,'gpt-6-luna'),'queued',NULL,NULL,q.detail,q.created_at,NULL,NULL
   FROM iteration_execution_queue q LEFT JOIN project_ai_settings s ON s.project_id=q.project_id
   WHERE q.project_id=$1 AND q.status='queued' AND q.run_id IS NOT NULL
  ORDER BY created_at DESC LIMIT 30`,[id]);
 return runs.rows;
});

}
