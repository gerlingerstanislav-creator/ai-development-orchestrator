import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {importByTopics,splitSourceFragments,fingerprint} from '../dist/topic-import.js';

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
 for(const [key,title] of [['architecture','Архитектура и технические решения'],['operations','Запуск и эксплуатация'],['design','Дизайн и интерфейсы'],['research','Исходные материалы и исследования']]){
  await db.query('INSERT INTO documents(id,project_id,title,body,parent_id,system_key) VALUES($1,$2,$3,\'\',NULL,$4)',[randomUUID(),projectId,title,key]);
 }
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
 assert.equal((await db.query("SELECT count(*)::int n FROM document_import_topics WHERE job_id=$1 AND status NOT IN ('complete','conflict')",[job.id])).rows[0].n,0);
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

 // Regression for an actual failed import: 122/122 fragments were classified,
 // the model put all of them in one topic, and its second portion returned >5 questions.
 // The first portion and its page UUID must survive remapping and resumption.
 const collapsedProject=randomUUID(),collapsedRoot=randomUUID(),collapsedPage=randomUUID(),collapsedJobId=randomUUID();
 const collapsedSourceKey=sourceKey+':collapsed-regression';
 const legacyTitle='Вся документация';
 const legacyDraft='Первый блок требований уже подготовлен и должен остаться неизменным.';
 const legacyBody='# '+legacyTitle+'\n\n'+legacyDraft+'\n\n---\n\n## Исходные материалы\nИсходный фрагмент';
 const classificationNotes='Выделены требования и открытые вопросы данного раздела.';
 await db.query(
  "INSERT INTO documents(id,project_id,title,body,parent_id,system_key) VALUES($1,$2,'Техническое задание','',NULL,'spec')",
  [collapsedRoot,collapsedProject]);
 for(const [key,title] of [['architecture','Архитектура и технические решения'],['operations','Запуск и эксплуатация'],['design','Дизайн и интерфейсы'],['research','Исходные материалы и исследования']]){
  await db.query('INSERT INTO documents(id,project_id,title,body,parent_id,system_key) VALUES($1,$2,$3,\'\',NULL,$4)',[randomUUID(),collapsedProject,title,key]);
 }
 await db.query(
  "INSERT INTO documents(id,project_id,title,body,parent_id,import_source,import_synced_hash) VALUES($1,$2,$3,$4,$5,$6,$7)",
  [collapsedPage,collapsedProject,legacyTitle,legacyBody,collapsedRoot,'topic:'+collapsedSourceKey+':everything',fingerprint(legacyTitle,legacyBody)]);
 await db.query(
  "INSERT INTO document_import_jobs(id,project_id,actor_id,status,message,source_key,request_text) VALUES($1,$2,$3,'running','Resume',$4,'Перенеси документацию')",
  [collapsedJobId,collapsedProject,actorId,collapsedSourceKey]);
 for(const fragment of fragments){
  await db.query(
   'INSERT INTO document_import_fragments(job_id,fragment_index,file_path,heading,content_sha,notes,topics,exclusion_reason) VALUES($1,$2,$3,$4,$5,$6,$7,NULL)',
   [collapsedJobId,fragment.index,fragment.path,fragment.heading,fragment.sha,classificationNotes,
    JSON.stringify([{key:'everything',title:legacyTitle}])]);
 }
 await db.query(
  "INSERT INTO document_import_topics(job_id,topic_key,title,status,cursor,page_id,draft_body) VALUES($1,'everything',$2,'processing',1,$3,$4)",
  [collapsedJobId,legacyTitle,collapsedPage,legacyDraft]);
 const largeQuestions=Array.from({length:9},(_,i)=>'Какой порядок принятия решения владельцем продукта для варианта '+(i+1)+'?');
 let planCalls=0,assignmentCalls=0,partCalls=0,remapCalls=0;
 const collapsedComplete=async prompt=>{
  if(prompt.includes('Первичное распределение материалов ошибочно')){
   planCalls++;
   return {text:JSON.stringify({topics:Object.values(classifications).filter((topic,i,a)=>a.findIndex(t=>t.key===topic.key)===i)})};
  }
  if(prompt.includes('Распредели каждый фрагмент документации')){
   assignmentCalls++;
   const marker='Фрагменты:\n';
   const rows=JSON.parse(prompt.slice(prompt.lastIndexOf(marker)+marker.length));
   return {text:JSON.stringify({assignments:rows.map(f=>{
    const name=f.path.split('/').pop();
    return {index:f.index,key:classifications[name].key};
   })})};
  }
  if(prompt.includes('Сформируй ОДНУ самостоятельную порцию ТЗ')){
   partCalls++;
   return {text:JSON.stringify({
    body:'## Требования\nПредметные требования подготовлены из сохранённых источников. Все существующие требования остаются доступными.',
    questions:largeQuestions
   })};
  }
  throw Error('Unexpected regression prompt '+prompt.slice(0,200));
 };
 const collapsedJob={id:collapsedJobId,project_id:collapsedProject,actor_id:actorId,source_key:collapsedSourceKey,request_text:'Перенеси документацию'};
 const collapsedEvents=[];
 const collapsedArgs={pool,job:collapsedJob,files:fixture.files,sourceName:'Coffee Preorder',
  location:{owner:'gerlingerstanislav-creator',repository:'ideas',commit:fixture.source_commit},
  instructions:'',rules:'',analystInstructions:'',complete:collapsedComplete,
  progress:async(stage,message)=>collapsedEvents.push({stage,message}),
  recordUsage:async()=>{},getInstructions:async()=>''};
 const repaired=await importByTopics(collapsedArgs);
 assert.ok(repaired.generated_documents>=6,'A 122-fragment import must be split across genuine topics');
 assert.equal(planCalls,1,'Global topic plan should be proposed once');
 assert.ok(assignmentCalls>2,'Incomplete fragments should be assigned in bounded groups');
 assert.ok(partCalls>1,'Separate topics must be synthesized incrementally');
 const retained=(await db.query('SELECT id,body,source_refs FROM documents WHERE id=$1',[collapsedPage])).rows[0];
 assert.equal(retained.id,collapsedPage,'The previously saved document must retain its identity');
 assert.match(retained.body,/Первый блок требований уже подготовлен/);
 assert.ok(retained.source_refs.length<fragments.length,'An old partial topic must not falsely cite the entire repository');
 const oldCheckpoint=(await db.query("SELECT status,cursor FROM document_import_topics WHERE job_id=$1 AND topic_key='everything'",[collapsedJobId])).rows[0];
 assert.equal(oldCheckpoint.status,'complete');
 assert.equal(oldCheckpoint.cursor,1);
 const collapsedDocs=(await db.query("SELECT id,title,import_source FROM documents WHERE project_id=$1 AND import_source LIKE $2",
  [collapsedProject,'topic:'+collapsedSourceKey+':%'])).rows;
 assert.ok(collapsedDocs.length>=6,'The recovery must create multiple topic-specific pages');
 assert.equal((await db.query('SELECT count(*)::int n FROM documentation_questions WHERE project_id=$1',[collapsedProject])).rows[0].n,
  largeQuestions.length*(collapsedDocs.length-1),'Nine distinct questions per new topic must survive, without duplicates from successive batches');
 assert.ok(collapsedEvents.some(event=>event.stage==='remapped'));
 assert.equal((await db.query('SELECT status FROM document_import_jobs WHERE id=$1',[collapsedJobId])).rows[0].status,'completed');
 const callsBefore=planCalls+assignmentCalls+partCalls;
 await importByTopics(collapsedArgs);
 assert.equal(planCalls+assignmentCalls+partCalls,callsBefore,'Retry of completed topic checkpoints must not invoke Codex again');
 assert.equal((await db.query("SELECT count(*)::int n FROM documents WHERE project_id=$1 AND import_source LIKE $2",
  [collapsedProject,'topic:'+collapsedSourceKey+':%'])).rows[0].n,collapsedDocs.length,'Retry must not duplicate documents');

 // A separate interrupted job mirrors the screenshot: 3/11 parts of a topic are
 // already saved, but the 4th reply contains two concatenated JSON objects.
 const replayProject=randomUUID(),replayRoot=randomUUID(),replayPage=randomUUID(),replayJobId=randomUUID();
 const replayKey='topic:coffee-json-regression:preorder';
 const replayFiles=[{path:'replay-preorder.md',
  body:Array.from({length:11},(_,i)=>'## Раздел '+(i+1)+'\n'+('Подтверждённое требование сценария предзаказа №'+(i+1)+'. ').repeat(100)).join('\n')}];
 const replayFragments=splitSourceFragments(replayFiles);
 assert.equal(replayFragments.length,11);
 const replayDraft='## Ранее согласованные требования\nТри части уже проверены и сохранены.';
 const replayBody='# Предзаказ и выдача\n\n'+replayDraft+'\n\n---\n\n## Исходные материалы\n- replay-preorder.md';
 await db.query(
  "INSERT INTO documents(id,project_id,title,body,parent_id,system_key) VALUES($1,$2,'Техническое задание','',NULL,'spec')",
  [replayRoot,replayProject]);
 for(const [key,title] of [['architecture','Архитектура и технические решения'],['operations','Запуск и эксплуатация'],['design','Дизайн и интерфейсы'],['research','Исходные материалы и исследования']]){
  await db.query('INSERT INTO documents(id,project_id,title,body,parent_id,system_key) VALUES($1,$2,$3,\'\',NULL,$4)',[randomUUID(),replayProject,title,key]);
 }
 await db.query(
  "INSERT INTO documents(id,project_id,title,body,parent_id,import_source,import_synced_hash) VALUES($1,$2,'Предзаказ и выдача',$3,$4,$5,$6)",
  [replayPage,replayProject,replayBody,replayRoot,replayKey,fingerprint('Предзаказ и выдача',replayBody)]);
 await db.query(
  "INSERT INTO document_import_jobs(id,project_id,actor_id,status,message,source_key,request_text) VALUES($1,$2,$3,'running','Part 4/11','coffee-json-regression','Импорт ТЗ')",
  [replayJobId,replayProject,actorId]);
 for(const fragment of replayFragments){
  await db.query(
   "INSERT INTO document_import_fragments(job_id,fragment_index,file_path,heading,content_sha,notes,topics,exclusion_reason) VALUES($1,$2,$3,$4,$5,$6,$7,NULL)",
   [replayJobId,fragment.index,fragment.path,fragment.heading,fragment.sha,'Подтверждённая постановка. '.repeat(30),
    JSON.stringify([{key:'preorder',title:'Предзаказ и выдача'}])]);
 }
 await db.query(
  "INSERT INTO document_import_topics(job_id,topic_key,title,status,cursor,page_id,draft_body) VALUES($1,'preorder','Предзаказ и выдача','processing',3,$2,$3)",
  [replayJobId,replayPage,replayDraft]);
 let generated=0,repairedJson=0;
 const replayEvents=[];
 const replayArgs={pool,job:{id:replayJobId,project_id:replayProject,actor_id:actorId,
  source_key:'coffee-json-regression',request_text:'Импорт ТЗ'},files:replayFiles,
  sourceName:'Coffee Preorder',location:{owner:'gerlingerstanislav-creator',repository:'ideas',commit:fixture.source_commit},
  instructions:'',rules:'',analystInstructions:'',
  complete:async prompt=>{
   if(prompt.includes('Ты исправляешь структуру своего ответа')){
    repairedJson++;
    assert.match(prompt,/часть 4\/11/);
    assert.match(prompt,/Требование из дополнительного JSON/);
    return {text:JSON.stringify({body:'## Требование из первого JSON\nСохранить.\n\n## Требование из дополнительного JSON\nТакже сохранить.',
     questions:Array.from({length:7},(_,i)=>'Вопрос владельцу продукта номер '+(i+1)+'?' )})};
   }
   assert.match(prompt,/Сформируй ОДНУ самостоятельную порцию ТЗ/);
   generated++;
   if(generated===1){
    return {text:JSON.stringify({body:'## Требование из первого JSON\nСохранить.',questions:['Вопрос владельцу продукта номер 1?']})+
     '\n'+JSON.stringify({body:'## Требование из дополнительного JSON\nТакже сохранить.',
      questions:Array.from({length:6},(_,i)=>'Вопрос владельцу продукта номер '+(i+2)+'?')})};
   }
   return {text:JSON.stringify({body:'## Продолжение требований\nОставшиеся разделы предзаказа.',
    questions:[]})};
  },
  progress:async(stage,message)=>replayEvents.push({stage,message}),
  recordUsage:async()=>{},getInstructions:async()=>''};
 const replayResult=await importByTopics(replayArgs);
 assert.equal(replayResult.generated_documents,1);
 assert.equal(generated,8,'Only unfinished portions 4 through 11 are requested');
 assert.equal(repairedJson,1,'Malformed fourth portion is repaired in-place');
 const replayState=(await db.query("SELECT cursor,status FROM document_import_topics WHERE job_id=$1 AND topic_key='preorder'",[replayJobId])).rows[0];
 assert.deepEqual(replayState,{cursor:11,status:'complete'});
 const replaySaved=(await db.query('SELECT id,body FROM documents WHERE id=$1',[replayPage])).rows[0];
 assert.equal(replaySaved.id,replayPage);
 assert.match(replaySaved.body,/Три части уже проверены и сохранены/);
 assert.match(replaySaved.body,/Требование из первого JSON/);
 assert.match(replaySaved.body,/Требование из дополнительного JSON/);
 assert.equal((await db.query('SELECT count(*)::int n FROM documentation_questions WHERE project_id=$1',[replayProject])).rows[0].n,7);
 assert.ok(replayEvents.some(event=>event.stage==='format_retry'));
 const replayCalls=generated+repairedJson;
 await importByTopics(replayArgs);
 assert.equal(generated+repairedJson,replayCalls,'Reusing completed job must not replay past portions');
 assert.equal((await db.query("SELECT count(*)::int n FROM documents WHERE project_id=$1 AND import_source=$2",
  [replayProject,replayKey])).rows[0].n,1);

});
