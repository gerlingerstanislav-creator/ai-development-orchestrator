import test from 'node:test';
import assert from 'node:assert/strict';
import {createQueueReconciler} from '../dist/modules/execution/application/queue-reconciler.js';

const deferred=()=>{
 let resolve;
 const promise=new Promise(done=>{resolve=done});
 return {promise,resolve};
};
test('a slow queue scan cannot overlap itself across periodic scheduler ticks',async()=>{
 const gate=deferred();
 let firstStarted=0,secondStarted=0;
 const scheduler=createQueueReconciler([
  {label:'peer',execute:async()=>{firstStarted++;await gate.promise;}},
  {label:'manager',execute:async()=>{secondStarted++;}}
 ],()=>{throw Error('Unexpected queue failure')});
 const first=scheduler.run();
 const during=scheduler.run();
 assert.strictEqual(during,first,'concurrent ticks share one in-flight reconciliation');
 assert.equal(scheduler.isRunning(),true);
 await Promise.resolve();await Promise.resolve();
 assert.equal(firstStarted,1);
 assert.equal(secondStarted,0,'later jobs wait for earlier jobs');
 assert.strictEqual(scheduler.run(),first);
 gate.resolve();
 await first;
 assert.equal(firstStarted,1);
 assert.equal(secondStarted,1);
 assert.equal(scheduler.isRunning(),false);
 await scheduler.run();
 assert.equal(firstStarted,2,'next tick starts only after prior pass finishes');
 assert.equal(secondStarted,2);
});
test('failure of one queue does not suppress the remaining independent queues',async()=>{
 const executed=[],failures=[];
 const scheduler=createQueueReconciler([
  {label:'peer queue',execute:async()=>{executed.push('peer');throw Error('Postgres unavailable');}},
  {label:'merge queue',execute:async()=>{executed.push('merge');}},
  {label:'PM inbox',execute:async()=>{executed.push('pm');}}
 ],(label,error)=>failures.push({label,message:error.message}));
 await scheduler.run();
 assert.deepEqual(executed,['peer','merge','pm']);
 assert.deepEqual(failures,[{label:'peer queue',message:'Postgres unavailable'}]);
 assert.equal(scheduler.isRunning(),false);
 await scheduler.run();
 assert.deepEqual(executed,['peer','merge','pm','peer','merge','pm']);
});
test('sync throw and reporting errors cannot wedge an active queue flight',async()=>{
 let attempts=0;
 const scheduler=createQueueReconciler([
  {label:'bad queue',execute:()=>{attempts++;throw Error('Immediate failure')}},
  {label:'good queue',execute:async()=>{attempts++;}}
 ],()=>{throw Error('Unable to write diagnostics')});
 await scheduler.run();
 assert.equal(attempts,2);
 assert.equal(scheduler.isRunning(),false);
 await scheduler.run();
 assert.equal(attempts,4);
});
test('an empty queue set completes and releases the active scheduler slot',async()=>{
 const scheduler=createQueueReconciler([],()=>{});
 await scheduler.run();
 assert.equal(scheduler.isRunning(),false);
 await scheduler.run();
 assert.equal(scheduler.isRunning(),false);
});
