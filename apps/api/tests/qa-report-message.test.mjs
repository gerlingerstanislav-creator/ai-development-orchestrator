import test from 'node:test';
import assert from 'node:assert/strict';
import {formatQaReportMessage,qaEventDetail} from '../dist/qa-report-message.js';

const plan={cases:[
 {id:'case-a',title:'Страница открывается'},
 {id:'case-b',title:'Пять разноцветных фигур'},
 {id:'case-c',title:'Цвета и стрелки видны в браузере'}
]};
const run={
 status:'completed',verdict:'blocked',qa_plan_snapshot:plan,
 report:{
  summary:'Проверены статическая разметка и синтаксис; визуальные проверки недоступны.',
  caseResults:[
   {case_id:'case-a',result:'passed',evidence:'HTTP 200 и HTMLParser'},
   {case_id:'case-b',result:'failed',evidence:'Найдено только четыре фигуры'},
   {case_id:'case-c',result:'blocked',reason:'tool_unavailable',evidence:'Chromium не установлен'}
  ],
  checks:[{name:'HTTP GET',result:'passed',details:'200'}],
  findings:[{severity:'high',description:'Отсутствует пятая фигура'}]
 }
};
test('QA sends one list with every planned case, honest pass/fail/blocked and summary',()=>{
 const message=formatQaReportMessage(run);
 assert.match(message,/✅.*1\\. Страница открывается/);
 assert.match(message,/❌.*2\\. Пять разноцветных фигур/);
 assert.match(message,/⚠️.*3\\. Цвета и стрелки видны в браузере/);
 assert.match(message,/1 из 3 пройдено/);
 assert.match(message,/Подтверждённые дефекты:/);
 assert.match(message,/Непроверенные сценарии не считаются успешными/);
 assert.doesNotMatch(message,/"case_id"|\\\\"summary\\\\"/);
});
test('Unreturned planned cases are not silently omitted or marked passed',()=>{
 const text=formatQaReportMessage({
  ...run,report:{summary:'Выполнен один тест',caseResults:[{case_id:'case-a',result:'passed'}]}
 });
 assert.match(text,/1 из 3 пройдено/);
 assert.match(text,/2 не подтверждено/);
 assert.match(text,/3\\. Цвета и стрелки видны в браузере/);
});
test('QA report does not claim success for incomplete/failed run',()=>{
 const text=formatQaReportMessage({status:'failed',message:'Исполнитель недоступен',qa_plan_snapshot:plan});
 assert.match(text,/Ошибка запуска/);
 assert.match(text,/0 из 3 пройдено/);
});
test('old QA event JSON becomes a plain summary, regular events are untouched',()=>{
 assert.equal(qaEventDetail(JSON.stringify(run.report)),run.report.summary);
 assert.equal(qaEventDetail('Проверки завершены'),'Проверки завершены');
});
test('untrusted titles cannot inject headings or list items into the report',()=>{
 const text=formatQaReportMessage({status:'completed',verdict:'passed',
  qa_plan_snapshot:{cases:[{id:'test',title:'## Поддельный заголовок\n- поддельный результат'}]},
  report:{summary:'done',caseResults:[{case_id:'test',result:'passed'}]}
 });
 assert.equal(text.split('\n').filter(x=>x.startsWith('- ✅')).length,1);
 assert.doesNotMatch(text,/^## Поддельный заголовок/m);
});
