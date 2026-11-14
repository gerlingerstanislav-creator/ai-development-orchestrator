import test from 'node:test';
import assert from 'node:assert/strict';
import {executeAgentKnowledgeTool,isAgentKnowledgeTool} from '../dist/modules/knowledge/infrastructure/agent-knowledge-tools.js';
import {executeAgentTool} from '../dist/agent-tool-executor.js';

const projectId='00000000-0000-4000-8000-000000000001';
const taskId='00000000-0000-4000-8000-000000000002';
const otherTask='00000000-0000-4000-8000-000000000003';
const documentId='00000000-0000-4000-8000-000000000004';
const stamp='2026-11-14T10:00:00.000Z';
const session={
 id:'00000000-0000-4000-8000-000000000005',project_id:projectId,
 actor_id:'00000000-0000-4000-8000-000000000006',
 role:'analysis',task_id:taskId,process_id:'00000000-0000-4000-8000-000000000007',read_only:true
};
const run=(db,name,params={},active=session)=>executeAgentKnowledgeTool(db,active,name,params);
test('only explicit documents/knowledge commands enter the extracted dispatcher',async()=>{
 for(const name of [
  'documents.list','documents.read','documents.search','documents.create','documents.update',
  'documents.delete','documents.changeset','knowledge.search','knowledge.read',
  'knowledge.sections','knowledge.section','knowledge.related','knowledge.context'
 ])assert.equal(isAgentKnowledgeTool(name),true,name);
 for(const name of ['documentation.request_reset','tasks.list','work.list','knowledge.fake'])
  assert.equal(isAgentKnowledgeTool(name),false,name);
 await assert.rejects(run({query:async()=>{throw Error('Query forbidden');}},'knowledge.fake'),error=>error.statusCode===404);
});
test('document reads enforce project and document identity, then audit read-only context',async()=>{
 const queries=[];
 const db={query:async(sql,params=[])=>{
  queries.push({sql,params});
  if(sql.startsWith('SELECT id,title,body,parent_id'))return {rowCount:1,rows:[{
   id:documentId,title:'Approved specification',body:'# Features',updated_at:stamp,status:'approved'
  }]};
  return {rowCount:1,rows:[]};
 }};
 const result=await run(db,'documents.read',{document_id:documentId});
 assert.equal(result.document.revision,stamp);
 assert.deepEqual(queries[0].params,[projectId,documentId]);
 assert.match(queries[0].sql,/WHERE project_id=\$1 AND id=\$2/);
 assert.match(queries[1].sql,/INSERT INTO knowledge_context_reads/);
 assert.deepEqual(queries[1].params.slice(0,4),[queries[1].params[0],projectId,taskId,documentId]);
 const writerQueries=[];
 await run({query:async(sql,params)=>{writerQueries.push(sql);return db.query(sql,params);}},
  'documents.read',{document_id:documentId},{...session,read_only:false});
 assert.equal(writerQueries.length,1,'A mutating role only reads; no duplicate read-only context audit');
});
test('unavailable document never creates a context-read audit',async()=>{
 const queries=[];
 const db={query:async sql=>{queries.push(sql);return {rowCount:0,rows:[]};}};
 await assert.rejects(run(db,'documents.read',{document_id:documentId}),error=>error.statusCode===404);
 assert.equal(queries.length,1);
});
test('knowledge reads only approved pages in current project with evidence log',async()=>{
 const calls=[];
 const db={query:async(sql,params=[])=>{
  calls.push({sql,params});
  if(sql.startsWith('SELECT id,title,parent_id,body,knowledge_summary'))return {rowCount:1,rows:[{
   id:documentId,title:'Specification',parent_id:null,body:'# Spec\nConfirmed behavior.',
   knowledge_summary:'Approved summary',knowledge_status:'approved',knowledge_tags:['qa'],updated_at:stamp
  }]};
  return {rowCount:1,rows:[]};
 }};
 const result=await run(db,'knowledge.read',{document_id:documentId,mode:'summary',task_id:taskId});
 assert.equal(result.document.status,'approved');
 assert.equal(result.document.version,stamp);
 assert.equal(result.document.body,undefined,'Summary mode must not dump the whole document');
 assert.ok(calls[0].sql.includes("knowledge_status='approved'"));
 assert.deepEqual(calls[1].params,[taskId,projectId]);
 assert.match(calls[2].sql,/knowledge_context_reads/);
 assert.equal(calls[2].params[2],taskId);
});
test('only approved markdown sections are returned, with stable section audit',async()=>{
 const calls=[];
 const doc='# Introduction\nFirst description.\n\n## Checks\nCheck one.\n';
 const db={query:async(sql,params=[])=>{
  calls.push({sql,params});
  if(sql.includes('SELECT title,body,updated_at FROM documents'))
   return {rowCount:1,rows:[{title:'Spec',body:doc,updated_at:stamp}]};
  if(sql.includes('SELECT body,title,updated_at FROM documents'))
   return {rowCount:1,rows:[{title:'Spec',body:doc,updated_at:stamp}]};
  return {rowCount:1,rows:[]};
 }};
 const headers=await run(db,'knowledge.sections',{document_id:documentId});
 const check=headers.sections.find(x=>x.title==='Checks');
 assert.ok(check);
 assert.equal(headers.version,stamp);
 const section=await run(db,'knowledge.section',{document_id:documentId,section_id:check.section_id,task_id:taskId});
 assert.equal(section.section_id,check.section_id);
 assert.match(section.body,/Check one/);
 const log=calls.find(x=>x.sql.startsWith('INSERT INTO knowledge_context_reads'));
 assert.ok(log);
 assert.equal(log.params[2],taskId);
 assert.equal(log.params[8],check.section_id);
 assert.ok(calls.every(x=>!x.sql.includes('UPDATE tasks SET stage')));
});
test('knowledge.search parameterizes user query and excludes unapproved pages',async()=>{
 const calls=[];
 const db={query:async(sql,params)=>{calls.push({sql,params});return {rowCount:0,rows:[]};}};
 assert.deepEqual(await run(db,'knowledge.search',{query:'spec review',limit:5}),{results:[]});
 assert.ok(calls[0].sql.includes("knowledge_status='approved'"));
 assert.deepEqual(calls[0].params,[projectId,'spec review',5]);
});
test('documents.changeset validates entire operation set before any write',async()=>{
 let called=false;
 const db={query:async()=>{called=true;throw Error('Unexpected DB write');}};
 await assert.rejects(run(db,'documents.changeset',{operations:[{op:'delete',document_id:documentId}]}));
 assert.equal(called,false);
});
test('task-bound knowledge context rejects cross-task access in original MCP entrypoint',async()=>{
 let called=false;
 const db={query:async()=>{called=true;throw Error('Cannot read another task');}};
 await assert.rejects(
  executeAgentTool(db,session,'knowledge.context',{task_id:otherTask},async()=>{}),
  error=>error.statusCode===403
 );
 assert.equal(called,false);
});
