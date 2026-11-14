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
 assert.match(message,/✅.*1[.] Страница открывается/);
 assert.match(message,/❌.*2[.] Пять разноцветных фигур/);
 assert.match(message,/⚠️.*3[.] Цвета и стрелки видны в браузере/);
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
 assert.match(text,/3[.] Цвета и стрелки видны в браузере/);
});
test('QA report does not claim success for incomplete/failed run',()=>{
 const text=formatQaReportMessage({status:'failed',message:'Исполнитель недоступен',qa_plan_snapshot:plan});
 assert.match(text,/Ошибка запуска/);
 assert.match(text,/0 из 3 пройдено/);
});
test('old QA event JSON becomes a plain summary, regular events are untouched',()=>{
 assert.match(qaEventDetail(JSON.stringify(run.report)),/QA обнаружил проблему/);
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

test('a negative verified verdict never repeats unsupported all-passed claims in the chat',()=>{
 const report={
  summary:'Проверено 5 из 5. Все критерии подтверждены фактическими проверками.',
  checks:[{name:'npm run build',result:'failed',details:'/bin/bash -c npm run build'}],
  findings:[{description:'Ошибка Vue template: AdminLogin.vue содержит v-else-if без v-if'}],
  caseResults:[
   {case_id:'qa-1',result:'passed',evidence:'[qa-exec] case qa-1 exited 0'},
   {case_id:'qa-2',result:'failed',evidence:'[qa-exec] case qa-2 npm run build → code 1'},
   {case_id:'qa-3',result:'failed',evidence:'[Chromium/Playwright] #app empty'},
   {case_id:'qa-4',result:'blocked',reason:'tool_unavailable'},
   {case_id:'qa-5',result:'not_run'}
  ]
 };
 const text=formatQaReportMessage({status:'completed',verdict:'failed',report,
  qa_plan_snapshot:{cases:[
   {id:'qa-1',title:'Исходники доступны'},
   {id:'qa-2',title:'Сборка сайта'},
   {id:'qa-3',title:'Главная страница отображается'},
   {id:'qa-4',title:'Desktop скриншот'},
   {id:'qa-5',title:'Mobile скриншот'}
  ]}});
 assert.match(text,/1 из 5 пройдено/);
 assert.match(text,/Ошибка Vue template/);
 assert.match(text,/Дальше:/);
 assert.doesNotMatch(text,/Все критерии подтверждены|\/bin\/bash|\[qa-exec\]|\[Chromium\/Playwright\]/);
 const event=qaEventDetail(JSON.stringify(report));
 assert.match(event,/QA обнаружил проблему/);
 assert.doesNotMatch(event,/Все критерии подтверждены/);
});
