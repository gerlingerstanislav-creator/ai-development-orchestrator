import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyPmFailure,recordPmInboxDiagnostic,scanStalledPmInbox} from '../dist/modules/planning/infrastructure/pm-inbox-diagnostics.js';

test('nested Runner failure cause is visible but raw error text is not persisted',()=>{
 const refused=new TypeError('secret-message',{cause:Object.assign(new Error('connect'),{code:'ECONNREFUSED'})});
 assert.deepEqual(classifyPmFailure(refused),{category:'runner_refused',message:'runner_refused',causeCode:'ECONNREFUSED'});
 assert.equal(classifyPmFailure(new Error('Request timeout')).category,'timeout');
});
test('PM event stores stage, attempts and timing without secrets',async()=>{
 const calls=[];
 const db={query:async(sql,values)=>{calls.push({sql,values});return {rowCount:1,rows:[]};}};
 await recordPmInboxDiagnostic(db,{projectId:'project',messageId:'message',orderId:'order',attempt:2,
  stage:'retry_scheduled',level:'warning',elapsedMs:8500,
  error:new Error('Bearer abcdefghijklmnop timeout')});
 assert.equal(calls.length,1);assert.match(calls[0].sql,/INSERT INTO process_events/);
 assert.equal(calls[0].values[2],'order');
 const detail=JSON.parse(calls[0].values[5]);
 assert.equal(detail.message_id,'message');assert.equal(detail.attempt,2);
 assert.equal(detail.elapsed_ms,8500);assert.equal(detail.category,'timeout');
 assert.doesNotMatch(calls[0].values[5],/abcdefghijklmnop/);
});
test('stalled PM scanning uses cross-replica lease, 10-minute throttling and no chat body',async()=>{
 const queries=[];
 const db={query:async sql=>{queries.push(sql);return {rowCount:3,rows:[]};}};
 assert.equal(await scanStalledPmInbox(db),3);
 assert.match(queries[0],/pg_try_advisory_xact_lock/);
 assert.match(queries[0],/stalled_processing/);
 assert.match(queries[0],/stalled_waiting_agents/);
 assert.match(queries[0],/e.created_at>now\(\)-interval '10 minutes'/);
 assert.doesNotMatch(queries[0],/m\.body|o\.summary|SELECT \* FROM assistant_messages/);
});
