import test from 'node:test';
import assert from 'node:assert/strict';
import {incompleteQaCases,qaCompletionPrompt,completedQaSummary,applyVisualEvidenceGate} from './qa-completion.mjs';
import {verifyQaExecution} from './qa-run-evidence.mjs';

const visualCase={
 id:'qa-1',title:'Структурная проверка количества, геометрии и уникальности цветов',
 steps:[{action:'Проверить восемь линий',expected:'8 параллельных прямых разноцветных линий'}]
};
const browserCase={id:'qa-2',title:'Видимость восьми линий в Chromium'};
const initial={
 verdict:'blocked',
 caseResults:[
  {case_id:'qa-1',title:visualCase.title,result:'passed',reason:'executed',evidence:'npm test passed'},
  {case_id:'qa-2',title:browserCase.title,result:'passed',reason:'executed',evidence:'Chromium checked'}
 ],
 checks:[],findings:[],summary:'Система видит 8 линий'
};
const browserEvidence=[
 {kind:'case',id:'qa-2',result:'passed',expression:'document.querySelectorAll("main .line").length === 8',viewport:{width:375,height:667}}
];

test('the verified result of qa-2 cannot silently pass qa-1',()=>{
 const verified=verifyQaExecution(initial,[],[],{browserEvidence});
 assert.equal(verified.caseResults[0].result,'not_run');
 assert.equal(verified.caseResults[1].result,'passed');
 assert.equal(verified.verdict,'blocked');
 const targets=incompleteQaCases(verified,[visualCase,browserCase],{browserAvailable:true});
 assert.deepEqual(targets.map(item=>item.id),['qa-1']);
 const prompt=qaCompletionPrompt(targets,{taskTitle:'Eight lines'});
 assert.match(prompt,/--case CASE_ID/);
 assert.match(prompt,/qa-1/);
 assert.doesNotMatch(prompt,/"id":"qa-2"/);
 assert.match(prompt,/Структурная проверка/);
});

test('recovered Chromium proof linked to qa-1 completes both cases',()=>{
 const before=verifyQaExecution(initial,[],[],{browserEvidence});
 assert.equal(before.verdict,'blocked');
 const recovered=verifyQaExecution(initial,[],[],{browserEvidence:[
  ...browserEvidence,
  {kind:'case',id:'qa-1',result:'passed',expression:'document.querySelectorAll("main .line").length === 8'},
  {kind:'case',id:'qa-1',result:'passed',expression:'new Set([...document.querySelectorAll("main .line")].map(e=>getComputedStyle(e).backgroundColor)).size === 8'}
 ]});
 assert.equal(recovered.verdict,'passed');
 assert.equal(recovered.caseResults[0].browserVerified,true);
 assert.equal(recovered.caseResults[1].browserVerified,true);
 assert.equal(incompleteQaCases(recovered,[visualCase,browserCase],{browserAvailable:true}).length,0);
 assert.match(completedQaSummary(recovered,{retriedIds:['qa-1']}),/Проверено 2 из 2/);
});

test('a reported command pass of a visual case still needs Chromium proof',()=>{
 const existing={
  ...initial,
  caseResults:initial.caseResults.map((item,i)=>i?item:{...item,browserVerified:false})
 };
 const receipts=[{kind:'case',id:'qa-1',exitCode:0,stdout:'structure pass',stderr:''}];
 const verified=verifyQaExecution(existing,[],[],{receipts,browserEvidence});
 assert.equal(verified.caseResults[0].result,'passed');
 assert.equal(verified.caseResults[0].browserVerified,false);
 assert.deepEqual(incompleteQaCases(verified,[visualCase,browserCase],{browserAvailable:true}).map(item=>item.id),['qa-1']);
});

test('false or failed browser assertions never turn an incomplete QA into passed',()=>{
 const blocked=verifyQaExecution(initial,[],[],{browserEvidence});
 assert.deepEqual(incompleteQaCases(blocked,[visualCase,browserCase],{browserAvailable:false}),[]);
 const failed=verifyQaExecution(initial,[],[],{browserEvidence:[
  ...browserEvidence,{kind:'case',id:'qa-1',result:'failed',expression:'document.querySelectorAll("main .line").length===7',actual:false}
 ]});
 assert.equal(failed.verdict,'failed');
 assert.equal(failed.caseResults[0].result,'failed');
 assert.deepEqual(incompleteQaCases(failed,[visualCase,browserCase],{browserAvailable:true}),[]);
});

test('previously blocked case can be verified only by its own late proof',()=>{
 const first={...initial,caseResults:initial.caseResults.map((item,i)=>i?item:{...item,result:'blocked',reason:'unknown'})};
 const now=verifyQaExecution(first,[],[],{browserEvidence:[
  ...browserEvidence,{kind:'case',id:'qa-1',result:'passed',expression:'document.querySelectorAll(".line").length===8'}
 ]});
 assert.equal(now.caseResults[0].result,'passed');
 assert.equal(now.verdict,'passed');
});

test('QA never announces 2/2 when both visual criteria lack case-linked Chromium assertions',()=>{
 const claimed={
  verdict:'passed',summary:'Все критерии подтверждены!',
  caseResults:[
   {case_id:'qa-1',title:visualCase.title,result:'passed',reason:'executed',browserVerified:false,evidence:'npm test PASS'},
   {case_id:'qa-2',title:browserCase.title,result:'passed',reason:'executed',browserVerified:false,evidence:'npm test PASS'}
  ],checks:[{name:'npm test',result:'passed'}]
 };
 const checked=applyVisualEvidenceGate(claimed,[visualCase,browserCase],{browserAvailable:true});
 assert.equal(checked.verdict,'blocked');
 assert.deepEqual(checked.caseResults.map(c=>c.result),['blocked','blocked']);
 assert.deepEqual(incompleteQaCases(checked,[visualCase,browserCase],{browserAvailable:true}).map(c=>c.id),['qa-1','qa-2']);
 const summary=completedQaSummary(checked,{retriedIds:['qa-1','qa-2']});
 assert.match(summary,/Проверено 0 из 2/);
 assert.doesNotMatch(summary,/Все критерии подтверждены фактическими проверками/);
});
test('QA accepts both visual cases only after real per-case browser proof',()=>{
 const data={
  verdict:'blocked',caseResults:[
   {case_id:'qa-1',title:visualCase.title,result:'blocked',reason:'unverified',evidence:''},
   {case_id:'qa-2',title:browserCase.title,result:'blocked',reason:'unverified',evidence:''}
  ],checks:[],findings:[],summary:'Продолжение тестирования'
 };
 const browser=[
  {kind:'case',id:'qa-1',result:'passed',expression:'document.querySelectorAll(".line").length === 8'},
  {kind:'case',id:'qa-2',result:'passed',expression:'[...document.querySelectorAll(".line")].every(e=>e.getBoundingClientRect().width>0)'}
 ];
 const checked=applyVisualEvidenceGate(verifyQaExecution(data,[],[],{browserEvidence:browser}),
  [visualCase,browserCase],{browserAvailable:true});
 assert.equal(checked.verdict,'passed');
 assert.equal(checked.caseResults.every(c=>c.browserVerified===true),true);
 assert.match(completedQaSummary(checked),/Проверено 2 из 2/);
});
test('focused QA instructions require an actual browser assertion, not narrative proof',()=>{
 const prompt=qaCompletionPrompt([{id:'qa-1',title:'Восемь видимых параллельных линий',steps:[]}],{taskTitle:'Линии'});
 assert.match(prompt,/ОБЯЗАТЕЛЬНО выполни реальную browser-client/);
 assert.match(prompt,/assert --case/);
 assert.match(prompt,/не просто напиши об этом/);
});
