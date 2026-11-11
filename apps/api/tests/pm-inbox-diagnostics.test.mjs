import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyPmFailure,recordPmInboxDiagnostic,scanStalledPmInbox} from '../dist/pm-inbox-diagnostics.js';

test('PM errors preserve the underlying network cause rather than generic fetch failed',()=>{
 const refused=new TypeError('fetch failed',{cause:Object.assign(new Error('connect refused'),{code:'ECONNREFUSED'})});
 assert.deepEqual(classifyPmFailure(refused),{category:'runner_refused',message:'fetch failed',causeCode:'ECONNREFUSED'});
 assert.equal(classifyPmFailure(new Error('Исполнитель этой роли занят')).category,'capacity');
 assert.equal(classifyPmFailure(new Error('Request timeout')).category,'timeout');
});
test('PM diagnostic events contain correlation IDs and timing but no conversation or secret',async()=>{
 const calls=[];
 const pool={query:async(sql,values)=>{calls.push({sql,values});return {rows:[],rowCount:1};}};
 await recordPmInboxDiagnostic(pool,{
  projectId:'project-a',messageId:'message-a',orderId:'order-a',attempt:2,
  stage:'retry_scheduled',level:'warning',elapsedMs:8500,
  error:new Error('Bearer abcdefghijklmnop timeout')
 });
 assert.equal(calls.length,1);
 assert.match(calls[0].sql,/INSERT INTO process_events/);
 assert.equal(calls[0].values[2],'order-a');
 const detail=JSON.parse(calls[0].values[6]);
 assert.equal(detail.message_id,'message-a');
 assert.equal(detail.attempt,2);
 assert.equal(detail.elapsed_ms,8500);
 assert.equal(detail.category,'timeout');
 assert.doesNotMatch(calls[0].values[6],/abcdefghijklmnop/);
});
test('stalled scan records deduplicated warnings and avoids storing chat bodies',async()=>{
 const queries=[];
 const pool={query:async(sql)=>{queries.push(sql);return {rowCount:3,rows:[]};}};
 assert.equal(await scanStalledPmInbox(pool),3);
 assert.match(queries[0],/stalled_processing/);
 assert.match(queries[0],/stalled_waiting_agents/);
 assert.match(queries[0],/e\.created_at>now\(\)-interval '10 minutes'/);
 assert.doesNotMatch(queries[0],/m\.body|o\.summary|SELECT \* FROM assistant_messages/);
});
