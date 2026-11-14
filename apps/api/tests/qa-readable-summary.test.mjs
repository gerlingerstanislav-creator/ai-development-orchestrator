import test from 'node:test';
import assert from 'node:assert/strict';
import {qaReadableSummary} from '../dist/qa-readable-summary.js';

test('failed Vue build always outweighs a model summary claiming all cases passed',()=>{
 const summary=qaReadableSummary({
  verdict:'failed',
  caseResults:[
   {result:'passed',evidence:'Executed npm check'},
   {result:'failed',evidence:'[qa-exec] case qa-2 -> exit 1'},
   {result:'failed',evidence:'[Chromium/Playwright] assert failed'},
   {result:'not_run'},
   {result:'blocked'}
  ],
  checks:[{name:'Production build',result:'failed',details:'npm run build -> status 1'}],
  findings:[{description:'Vue compiler: у v-else-if в AdminLogin.vue нет соседнего v-if.'}]
 },5);
 assert.match(summary,/QA обнаружил проблему/);
 assert.match(summary,/1 из 5 сценариев пройдено/);
 assert.match(summary,/2 с ошибкой/);
 assert.match(summary,/2 не проверено/);
 assert.match(summary,/AdminLogin.vue/);
 assert.doesNotMatch(summary,/все критерии подтверждены|всё успешно|\[qa-exec\]/i);
});
test('browser artifact gate can block even after successful case assertions',()=>{
 const summary=qaReadableSummary({
  verdict:'blocked',caseResults:[{result:'passed'},{result:'passed'}],
  evidenceIssue:'Не подтверждены desktop и mobile скриншоты'
 },2);
 assert.match(summary,/не смог полностью проверить/);
 assert.match(summary,/скриншоты|снимки/);
 assert.doesNotMatch(summary,/QA завершён успешно/);
});
test('zero cases cannot be reported as a successful QA run',()=>{
 assert.match(qaReadableSummary({verdict:'passed',caseResults:[]}),/не смог полностью проверить/);
});
test('low-level CLI/stack output is not repeated as a human-facing conclusion',()=>{
 const result=qaReadableSummary({verdict:'failed',caseResults:[{result:'failed',evidence:'[qa-exec] /bin/bash -c npm run build'}]});
 assert.doesNotMatch(result,/\/bin\/bash|\[qa-exec\]/);
 assert.match(result,/Требуется исправление/);
});
