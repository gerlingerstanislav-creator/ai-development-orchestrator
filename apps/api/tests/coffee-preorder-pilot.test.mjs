import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {importByTopics,splitSourceFragments} from '../dist/topic-import.js';

const fixture=JSON.parse(await readFile(new URL('./fixtures/coffee-preorder-43-0.3.json',import.meta.url),'utf8'));
const classifications={
 'README.md':{key:'concept',title:'Концепция и цели'},
 'REQUIREMENTS.md':{key:'preorder',title:'Предзаказ и выдача'},
 'USER_STORIES.md':{key:'preorder',title:'Предзаказ и выдача'},
 'OPERATIONS_AND_BARISTA_UX.md':{key:'preorder',title:'Предзаказ и выдача'},
 'LOYALTY.md':{key:'loyalty',title:'Лояльность'},
 'RESTAURANT_UX.md':{key:'restaurant',title:'Ресторанный контур'},
 'CATALOG_AND_ONBOARDING.md':{key:'catalog',title:'Каталог и подключение'},
 'Оценка.md':{key:'research',title:'Исследования и гипотезы'},
 'MARKET_RESEARCH_2026-10-17.md':{key:'research',title:'Исследования и гипотезы'}
};
function topicFor(prompt){
 const line=prompt.split('\n').find(l=>l.startsWith('Источник: coffee-preorder-43-0.3/'));
 assert.ok(line,'Each source fragment must retain its real Coffee Preorder path');
 const path=line.slice('Источник: '.length).split(' · ')[0];
 const name=path.slice(path.lastIndexOf('/')+1);
 assert.ok(classifications[name],'Missing classification for '+path);
 return classifications[name];
}

test('Coffee Preorder pinned snapshot: all 9 originals, visible checkpoints after 2 themes, resume, conflicts',async t=>{
 assert.equal(fixture.source_repo,'gerlingerstanislav-creator/ideas');
 assert.match(fixture.source_commit,/^[a-f0-9]{40}$/);
 assert.equal(fixture.files.length,9,'Pilot must use every Coffee Preorder source file');
 const fragments=splitSourceFragments(fixture.files);
 assert.ok(fragments.length>45,'Pilot processes real headings, not one synthetic summary');

 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 t.after(()=>db.end());
 await db.query(String.raw`
  CREATE TEMP TABLE documents(id uuid PRIMARY KEY,project_id uuid,title text,body text,parent_id uuid,system_key text,import_source text,source_refs jsonb DEFAULT '[]'::jsonb,import_synced_hash text,document_kind text,implementation_status text,updated_at timestamptz DEFAULT now());
  CREATE UNIQUE INDEX ON documents(project_id,import_source) WHERE import_source IS NOT NULL;
  CREATE TEMP TABLE document_import_jobs(id uuid PRIMARY KEY,project_id uuid,actor_id uuid,status text,message text,source_key text,request_text text,result jsonb,saved_documents int DEFAULT 0,source_file_count int,total_chunks int,analyzed_chunks int,updated_at timestamptz DEFAULT now());
  CREATE TEMP TABLE document_import_fragments(job_id uuid,fragment_index int,file_path text,heading text,content_sha text,notes text,topics jsonb,exclusion_reason text,PRIMARY KEY(job_id,fragment_index));
  CREATE TEMP TABLE document_import_topics(job_id uuid,topic_key text,title text,status text DEFAULT 'pending',cursor int DEFAULT 0,page_id uuid,draft_body text DEFAULT '',source_refs jsonb DEFAULT '[]'::jsonb,review_suggestion text,updated_at timestamptz DEFAULT now(),PRIMARY KEY(job_id,topic_key));
  CREATE TEMP TABLE document_import_proposals(id uuid,project_id uuid,job_id uuid,topic_key text,document_id uuid,title text,proposed_body text,base_hash text,status text DEFAULT 'open',created_at timestamptz DEFAULT now(),decided_at timestamptz,UNIQUE(job_id,topic_key));
  CREATE TEMP TABLE documentation_questions(id uuid,project_id uuid,job_id uuid,topic_key text,question_key text,document_id uuid,question text,answer text,status text DEFAULT 'open',created_at timestamptz DEFAULT now(),answered_at timestamptz,UNIQUE(project_id,document_id,question_key));
  CREATE TEMP TABLE assistant_messages(id uuid,project_id uuid,task_id uuid,actor_id uuid,role text,body text,created_document_id uuid,channel text,created_at timestamptz);
 `.replaceAll('\\`','`'));
 const pool={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),release(){}})};
 const projectId=randomUUID(),actorId=randomUUID(),rootId=randomUUID();
 await db.query("INSERT INTO documents(id,project_id,title,body,parent_id,system_key) VALUES($1,$2,'Техническое задание','',NULL,'spec')",[rootId,projectId]);
 const sourceKey='github-ai:gerlingerstanislav-creator/ideas@main:coffee-preorder-43-0.3';
 const makeJob=async()=>{const id=randomUUID();await db.query("INSERT INTO document_import_jobs(id,project_id,actor_id,status,message,source_key,request_text) VALUES($1,$2,$3,'running','start',$4,'Подготовь ТЗ по темам')",[id,projectId,actorId,sourceKey]);return {id,project_id:projectId,actor_id:actorId,request_text:'Подготовь ТЗ по темам',source_key:sourceKey};};
 const job=await makeJob();
 const events=[];
 let deliberateFailure=true,analystCalls=0;
 const completion=async prompt=>{
  analystCalls++;
  if(prompt.includes('Выдели факты')){
   const topic=topicFor(prompt);
   return {text:JSON.stringify({notes:'Факты из исходного раздела. Решения отличать от гипотез и противоречий.',topics:[topic],exclusion_reason:null})};
  }
  assert.ok(prompt.includes('Сформируй ОДНУ самостоятельную порцию ТЗ'),'Topic synthesis must never use global compression');
  if(deliberateFailure&&prompt.includes('теме Лояльность')){
   deliberateFailure=false;
   throw Error('Симуляция остановки после нескольких завершённых тем');
  }
  return {text:JSON.stringify({body:'## Согласованные требования\nСформулированы из переданных выдержек.\n\n## Гипотезы и противоречия\nТребуют подтверждения владельцем.\n\n## Критерии приёмки\nПроверяемость определяется по утверждённому ТЗ.',
   questions:prompt.includes('теме Предзаказ и выдача')?['Нужно ли оплачивать заказ до выдачи?']:[]})};
 };
 const makeArgs=job=>({
  pool,job,files:fixture.files,sourceName:'Coffee Preorder',
  location:{owner:'gerlingerstanislav-creator',repository:'ideas',commit:fixture.source_commit},
  instructions:'Подготовь ТЗ',rules:'',analystInstructions:'',complete:completion,
  progress:async(stage,message)=>events.push({stage,message}),
  recordUsage:async()=>{},getInstructions:async()=>''});
 await assert.rejects(importByTopics(makeArgs(job)),/Симуляция остановки/);
 const visible=(await db.query("SELECT id,body,import_source FROM documents WHERE project_id=$1 AND import_source LIKE 'topic:%' ORDER BY import_source",[projectId])).rows;
 assert.equal(visible.length,2,'At least two completed theme pages must be visible before interrupted import');
 assert.equal((await db.query("SELECT count(*)::int n FROM document_import_topics WHERE job_id=$1 AND status='complete'",[job.id])).rows[0].n,2);
 const callsBeforeResume=analystCalls;
 const result=await importByTopics(makeArgs(job));
 assert.equal(result.generated_documents,6,'Six distinct cross-file topics from the nine real source files');
 assert.equal(result.commit,fixture.source_commit);
 const resumedCalls=analystCalls-callsBeforeResume;
 assert.ok(resumedCalls<fragments.length,'Resume must reuse every classified fragment and completed theme');
 assert.equal((await db.query('SELECT count(*)::int n FROM document_import_fragments WHERE job_id=$1',[job.id])).rows[0].n,fragments.length);
 const total=(await db.query("SELECT count(*)::int n FROM documents WHERE import_source LIKE 'topic:%'")).rows[0].n;
 assert.equal(total,6);
 const preorder=(await db.query("SELECT id,body,source_refs FROM documents WHERE import_source=$1",['topic:'+sourceKey+':preorder'])).rows[0];
 assert.ok(preorder);
 const paths=preorder.source_refs.map(x=>x.path);
 assert.ok(paths.some(x=>x.endsWith('REQUIREMENTS.md')));
 assert.ok(paths.some(x=>x.endsWith('USER_STORIES.md')));
 assert.ok(paths.some(x=>x.endsWith('OPERATIONS_AND_BARISTA_UX.md')));
 assert.ok(preorder.source_refs.every(x=>x.url?.includes('/blob/'+fixture.source_commit+'/')),'Every GitHub citation is SHA-pinned');
 const questions=(await db.query('SELECT document_id FROM documentation_questions WHERE project_id=$1',[projectId])).rows;
 assert.ok(questions.some(x=>x.document_id===preorder.id));
 assert.equal((await db.query('SELECT count(*)::int n FROM document_import_topics WHERE job_id=$1 AND status NOT IN (\\'complete\\',\\'conflict\\')',[job.id])).rows[0].n,0);
 assert.ok(events.some(x=>x.stage==='topic_saved'));

 // Reimport the same repository reference after a manual edit: same document ID,
 // a review proposal rather than overwriting the user's changes.
 await db.query("UPDATE documents SET body='Ручная правка заказчика',updated_at=now() WHERE id=$1",[preorder.id]);
 const fresh=await makeJob();
 const rerun=await importByTopics(makeArgs(fresh));
 assert.equal(rerun.generated_documents,6);
 const updated=(await db.query('SELECT id,body FROM documents WHERE import_source=$1',['topic:'+sourceKey+':preorder'])).rows[0];
 assert.equal(updated.id,preorder.id);
 assert.equal(updated.body,'Ручная правка заказчика');
 assert.equal((await db.query("SELECT count(*)::int n FROM documents WHERE import_source LIKE 'topic:%'")).rows[0].n,6,'Reimports must update stable topic pages, never clone them');
 const proposals=(await db.query("SELECT id,proposed_body,status FROM document_import_proposals WHERE project_id=$1 AND document_id=$2",[projectId,preorder.id])).rows;
 assert.equal(proposals.length,1);
 assert.equal(proposals[0].status,'open');
 assert.match(proposals[0].proposed_body,/Предзаказ и выдача/);
});
