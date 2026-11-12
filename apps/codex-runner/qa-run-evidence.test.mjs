import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import {qaBaselineCommands,readQaCommands,readQaReceipts,verifyQaExecution} from './qa-run-evidence.mjs';

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


test('structured QA receipts link real executed assertions to case IDs despite shell wrapper differences',()=>{
 const script='node /opt/codex-runner/qa-exec.mjs case qa-1 -- node -e "process.exit(0)"';
 const events=readQaCommands(completed("/bin/bash -lc '"+script+"'",0));
 const receipt={kind:'case',id:'qa-1',executionId:'ba7816bf-8f01-4fea-9f08-77d16817cfa1',exitCode:0,
  command:['node','-e','process.exit(0)'],stdout:'assert passed',stderr:''};
 const verified=readQaReceipts(JSON.stringify(receipt)+'\n',events);
 assert.equal(verified.length,1);
 const result=verifyQaExecution(report(scenario('passed','completely different command text')),events,[],{receipts:verified});
 assert.equal(result.caseResults[0].result,'passed');
 assert.match(result.caseResults[0].evidence,/qa-exec.*код 0/);
});
test('fabricated receipts and echoed invocations do not count as execution',()=>{
 const receipt={kind:'case',id:'qa-1',executionId:'ba7816bf-8f01-4fea-9f08-77d16817cfa1',exitCode:0,
  command:['node','--test'],stdout:'pass'};
 const fake=readQaReceipts(JSON.stringify(receipt),readQaCommands(completed('echo "node /opt/codex-runner/qa-exec.mjs case qa-1 -- node --test"',0)));
 assert.equal(fake.length,0);
 const result=verifyQaExecution(report(scenario('passed','unexecuted')),[],[],{receipts:fake});
 assert.equal(result.caseResults[0].result,'not_run');
 assert.equal(result.verdict,'blocked');
});
test('failed structured test remains failed even if outer shell exits successfully',()=>{
 const script='node /opt/codex-runner/qa-exec.mjs case qa-1 -- node -e "process.exit(1)" || true';
 const receipt={kind:'case',id:'qa-1',executionId:'ba7816bf-8f01-4fea-9f08-77d16817cfa1',exitCode:1,command:['node','-e','process.exit(1)'],stdout:'',stderr:'assert failed'};
 const receipts=readQaReceipts(JSON.stringify(receipt),readQaCommands(completed(script,0)));
 const result=verifyQaExecution(report(scenario('passed','irrelevant')),[],[],{receipts});
 assert.equal(result.caseResults[0].result,'failed');
 assert.equal(result.verdict,'failed');
});
test('trusted browser evidence verifies six distinct cases with no extra checks',()=>{
 const cases=Array.from({length:6},(_,i)=>({case_id:'qa-'+(i+1),result:'passed',reason:'executed',command:'',evidence:'visual check'}));
 const browserEvidence=cases.map(c=>({kind:'case',id:c.case_id,result:'passed',expression:'document.querySelectorAll(".circle").length===10',viewport:{width:390,height:844}}));
 const result=verifyQaExecution({verdict:'blocked',caseResults:cases,checks:[],findings:[]},[],[],{browserEvidence});
 assert.equal(result.verdict,'passed');
 assert.equal(result.caseResults.filter(x=>x.browserVerified&&x.result==='passed').length,6);
});
test('a failed browser assertion cannot be overridden by a claimed pass',()=>{
 const browserEvidence=[{kind:'case',id:'qa-1',result:'passed',expression:'1===1'},{kind:'case',id:'qa-1',result:'failed',expression:'1===2',actual:false}];
 const result=verifyQaExecution(report(scenario('passed','text claimed success')),[],[],{browserEvidence});
 assert.equal(result.caseResults[0].result,'failed');
 assert.equal(result.verdict,'failed');
});

test('unverified optional diagnostics cannot erase independently verified acceptance cases',()=>{
 const evidence=[{kind:'case',id:'qa-1',result:'passed',expression:'document.querySelectorAll(".circle").length===10'}];
 const outcome=verifyQaExecution({verdict:'blocked',caseResults:[scenario('passed','')],
  checks:[{name:'Optional lint',result:'not_run',details:'not available'}],findings:[]},[],[],{browserEvidence:evidence});
 assert.equal(outcome.caseResults[0].result,'passed');
 assert.equal(outcome.verdict,'passed');
 assert.equal(outcome.checks[0].result,'not_run');
});
