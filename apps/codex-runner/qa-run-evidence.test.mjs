import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import {qaBaselineCommands,readQaCommands,verifyQaExecution} from './qa-run-evidence.mjs';

const completed=(command,exit_code)=>JSON.stringify({type:'item.completed',item:{type:'command_execution',command,exit_code}});
const scenario=(result,command)=>({case_id:'qa-1',title:'Неоплаченный заказ',result,command,reason:'executed',evidence:'Заказ остался неоплаченным'});
const report=(item)=>({
 verdict:item.result,caseResults:[item],findings:[],
 checks:[{name:'Проверка заказа',result:item.result,command:item.command,details:item.evidence}]
});

test('QA counts an executed assertion and retains its exit code',()=>{
 const script='node -e "require(\'node:assert/strict\').equal(\'unpaid\', \'unpaid\')"';
 const run=spawnSync('sh',['-c',script],{encoding:'utf8'});
 assert.equal(run.status,0);
 const result=verifyQaExecution(report(scenario('passed',script)),readQaCommands(completed("/bin/bash -lc '"+script+"'",run.status)));
 assert.equal(result.verdict,'passed');
 assert.equal(result.cases[0].title,'Неоплаченный заказ');
 assert.match(result.caseResults[0].evidence,/код 0/);
});

test('QA does not count a claimed command, a substring, or a mismatching exit code',()=>{
 for(const events of ['',completed('echo npm test',0),completed('npm test',1)]){
  const result=verifyQaExecution(report(scenario('passed','npm test')),readQaCommands(events));
  assert.equal(result.verdict,'blocked');
  assert.equal(result.caseResults[0].result,'not_run');
  assert.equal(result.checks[0].result,'not_run');
 }
});

test('QA retains confirmed failures and records standard suite execution independently',()=>{
 const baseline=[{command:'npm test',name:'Тесты Node.js',exitCode:0,output:'3 tests passed'}];
 const result=verifyQaExecution(report(scenario('failed','python3 -m pytest -q')),
  readQaCommands(completed('python3 -m pytest -q',1)),baseline);
 assert.equal(result.verdict,'failed');
 assert.deepEqual(result.checks.map(c=>c.result),['failed','passed']);
});

test('QA detects standard test suites from tracked source and available tools',()=>{
 assert.deepEqual(qaBaselineCommands(['package.json','tests/test_order.py'],{scripts:{test:'node --test'}},
  'npm: available\npytest: available').map(c=>c.command),['npm test','python3 -m pytest -q']);
 assert.deepEqual(qaBaselineCommands(['src/order.py'],null,'pytest: available'),[]);
});
