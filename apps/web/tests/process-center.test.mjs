import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ProcessCenter} from '../src/features/processes/ProcessCenter.tsx';
import {
 compactProcessDescription,filterProjectProcesses,processStatus,selectProjectProcess
} from '../src/features/processes/process-center-model.ts';

const projectId='123e4567-e89b-42d3-a456-426614174000';
const stamp='2026-11-12T09:00:00.000Z';
const example=(id,status='running',kind='development')=>({
 id,kind,title:'Development '+id,status,detail:'Development progress',createdAt:stamp,
 taskId:undefined,updatedAt:null
});
const callbacks={
 projectId,processes:[],events:[],prompts:[],selectedProcessId:null,
 onSelectProcess:()=>{},filter:'all',onFilterChange:()=>{},
 diagnosticHours:24,onDiagnosticHoursChange:()=>{},
 includeMessages:false,onIncludeMessagesChange:()=>{},
 exporting:false,onDownloadDiagnostics:()=>{},
 actionBusy:false,instruction:'',onInstructionChange:()=>{},
 onInterrupt:()=>{},onRestartImport:()=>{},onSendInstruction:()=>{},
 onStopAnalyst:()=>{},onFollowLink:()=>{},onNavigate:()=>{}
};
const render=(props={})=>renderToStaticMarkup(
 React.createElement(ProcessCenter,{...callbacks,...props})
);

test('process status, filtering and selection are independent of React',()=>{
 assert.equal(processStatus('running'),'Выполняется');
 assert.equal(processStatus('failed'),'Ошибка');
 assert.equal(processStatus('completed'),'Завершён');
 assert.equal(processStatus('queued'),'В очереди');
 assert.equal(processStatus('cancelled'),'Остановлен');
 assert.equal(processStatus('unexpected'),'unexpected');
 const processes=[example('run','running'),example('queued','queued'),
  example('failure','failed'),example('done','completed')];
 assert.deepEqual(filterProjectProcesses(processes,'active').map(p=>p.id),['run','queued']);
 assert.deepEqual(filterProjectProcesses(processes,'failed').map(p=>p.id),['failure']);
 assert.deepEqual(filterProjectProcesses(processes,'completed').map(p=>p.id),['done']);
 assert.equal(selectProjectProcess(processes,'queued','completed')?.id,'queued',
  'explicit selection stays open when filter changes, matching existing UI');
 assert.equal(selectProjectProcess(processes,'absent','failed')?.id,'failure');
 assert.equal(selectProjectProcess([],null,'all'),undefined);
});
test('long descriptions use a word boundary and empty descriptions have a fallback',()=>{
 assert.equal(compactProcessDescription('  \n  '),'Подробности доступны справа.');
 assert.equal(compactProcessDescription(' A  B\nC '),'A B C');
 const text='Документирование '.repeat(16);
 const compact=compactProcessDescription(text);
 assert.ok(compact.length<=112);
 assert.ok(compact.endsWith('…'));
});
test('empty process center preserves diagnostics controls and empty journal',()=>{
 const html=render();
 assert.match(html,/Центр процессов/);
 assert.match(html,/Скачать логи/);
 assert.match(html,/Переписка/);
 assert.match(html,/Процессов пока нет/);
 assert.match(html,/Выбери процесс слева/);
 assert.match(html,/process-center-filters/);
 assert.match(html,/value="24" selected/);
});
test('active process shows status, interruption command and time-stamped journal',()=>{
 const p=example('running-id','running');
 const html=render({processes:[p],selectedProcessId:p.id,events:[
  {id:'event-1',stage:'started',level:'info',detail:'Runner accepted job',created_at:stamp}
 ]});
 assert.match(html,/Development running-id/);
 assert.match(html,/process-status running/);
 assert.match(html,/Прервать процесс/);
 assert.match(html,/Runner accepted job/);
 assert.match(html,/process-timeline/);
});
test('document import preserves metrics, analyst instructions and recovery actions',()=>{
 const base={
  ...example('import-1','running','document_import'),
  sourceFileCount:3,progress:{completed:4,total:10},
  topicProgress:{completed:2,total:5},savedDocuments:2
 };
 const running=render({processes:[base],selectedProcessId:base.id,
  instruction:'Уточнить технические требования'});
 assert.match(running,/Файлов:.*3/);
 assert.match(running,/Фрагментов:.*4.*10/);
 assert.match(running,/Диалог с аналитиком во время работы/);
 assert.match(running,/Уточнить технические требования/);
 assert.match(running,/Отправить аналитику/);
 const failed=render({processes:[{...base,status:'failed'}],selectedProcessId:base.id});
 assert.match(failed,/Возобновить тот же импорт/);
 assert.doesNotMatch(failed,/Диалог с аналитиком во время работы/);
});
test('prompt audit, summary and links remain bound to the selected process',()=>{
 const p={...example('run-2','completed','testing'),
  result:{message:'QA complete',verdict:'passed',commit:'sha123',
   checks:[{name:'Unit tests',result:'passed',details:'20 passed'}],
   prUrl:'https://github.com/example/demo/pull/42'}};
 const html=render({processes:[p],selectedProcessId:p.id,
  prompts:[{id:'prompt-1',role:'testing',operation:'run',prompt:'Plan and tests',
   original_chars:14,truncated:false,created_at:stamp}]});
 assert.match(html,/Промпты запусков \(1\)/);
 assert.match(html,/Plan and tests/);
 assert.match(html,/Проверки пройдены/);
 assert.match(html,/Unit tests/);
 assert.match(html,/sha123/);
 assert.match(html,/https:\/\/github.com\/example\/demo\/pull\/42/);
 const other=render({processes:[p],selectedProcessId:null,
  prompts:[{id:'prompt-1',role:'testing',operation:'run',prompt:'private process prompt',
   original_chars:14,truncated:false,created_at:stamp}]});
 assert.doesNotMatch(other,/private process prompt/,'do not expose prompt for inactive selection');
});
