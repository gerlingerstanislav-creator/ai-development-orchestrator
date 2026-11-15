import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TaskBoard} from '../src/features/tasks/TaskBoard.tsx';
import {TaskBoardControls} from '../src/features/tasks/TaskBoardControls.tsx';
import {TaskExecutionPlan} from '../src/features/tasks/TaskExecutionPlan.tsx';
import {TaskCurrentWork,describeCurrentWork} from '../src/features/tasks/TaskCurrentWork.tsx';
import {kanbanLanes,attentionNeeded,dependencyReady,kanbanOrder,boardLaneFor} from '../src/features/tasks/board-model.ts';

const task=(id,props={})=>({
 id,display_number:Number(id.replace(/\D/g,''))||1,
 title:'Задача '+id,description:'Требования',type:'task',stage:'development',board_status:'in_progress',
 created_at:'2026-11-12T12:00:00Z',...props
});
const props=(tasks,stages=[])=>({
 projectId:'project-1',tasks,filtered:tasks,stages,
 renderTaskPlanningLabels:()=>null,agentWorking:()=>false,onFollowLink:()=>{},
 onMoveTask:()=>{},questionAnswers:{},onQuestionDraft:()=>{},
 onAnswerQuestion:()=>{},processActionBusy:false,mergeBusy:false,
 onMerge:()=>{},knowledgeBusy:false,onUpdateDocumentation:()=>{}
});

test('universal board uses exactly five product states without workflow-stage columns',()=>{
 assert.deepEqual(kanbanLanes.map(s=>s.stage),['backlog','todo','in_progress','acceptance','done']);
 assert.equal(boardLaneFor(task('1',{stage:'testing'})),'in_progress');
 assert.equal(boardLaneFor(task('1',{stage:'development',board_status:'acceptance'})),'acceptance');
 assert.equal(boardLaneFor(task('1',{stage:'done',board_status:undefined})),'done');
 assert.equal(boardLaneFor(task('1',{stage:'analysis',board_status:undefined})),'in_progress');
});
test('an owner question, acceptance request and QA failure need attention, but not a new column',()=>{
 assert.equal(attentionNeeded(task('1',{board_status:'acceptance'})),true);
 assert.equal(attentionNeeded(task('1',{awaits_product_owner:true})),true);
 assert.equal(attentionNeeded(task('1',{stage:'testing',test_feedback:'blocked'})),true);
 assert.equal(attentionNeeded(task('1',{board_status:'todo'})),false);
});
test('dependency readiness remains tied to verified technical stage and PR',()=>{
 const merged=task('1',{stage:'merge_queue',pr_url:'https://github.com/acme/demo/pull/1',git_branch:'feature'});
 const waiting=task('2',{depends_on_task_id:'1'});
 assert.equal(dependencyReady(waiting,[merged,waiting]),true);
 assert.equal(dependencyReady(waiting,[{...merged,git_branch:null},waiting]),false);
 assert.equal(dependencyReady(waiting,[{...merged,pr_url:null},waiting]),false);
 assert.equal(dependencyReady(waiting,[{...merged,stage:'documentation'},waiting]),true);
 assert.equal(dependencyReady(waiting,[waiting]),false);
});
test('priority sorting still puts unblocked work before blocked tasks',()=>{
 const ready=task('10',{priority:3});
 const blocked=task('20',{priority:1,awaits_product_owner:true});
 const urgent=task('30',{priority:1,created_at:'2026-11-12T10:00:00Z'});
 const arr=[blocked,ready,urgent];arr.sort((a,b)=>kanbanOrder(a,b,arr));
 assert.deepEqual(arr.map(x=>x.id),['30','10','20']);
});
test('board renders the five lanes and technical QA is a card detail',()=>{
 const stages=[{stage:'development',label:'Разработка'},{stage:'testing',label:'Тестирование'}];
 const t=task('101',{stage:'testing',board_status:'in_progress',awaits_product_owner:true});
 const html=renderToStaticMarkup(React.createElement(TaskBoard,props([t],stages)));
 assert.match(html,/board board-lifecycle/);
 assert.match(html,/Бэклог/);
 assert.match(html,/К работе/);
 assert.match(html,/В работе/);
 assert.match(html,/На приёмке/);
 assert.match(html,/Готово/);
 assert.match(html,/Тестирование/);
 assert.match(html,/\/projects\/project-1\/tasks\/101/);
 assert.match(html,/Нужен ответ владельца/);
 assert.doesNotMatch(html,/kanban-group/);
});
test('unconfirmed and archived tasks show guarded acceptance controls',()=>{
 const t=task('42',{stage:'done',board_status:'acceptance',acceptance_mode:'undecided'});
 const html=renderToStaticMarkup(React.createElement(TaskBoardControls,{task:t,busy:false,onAction:async()=>{}}));
 assert.match(html,/Решить при завершении/);
 assert.match(html,/Принять результат/);
 assert.match(html,/Есть замечания/);
 assert.doesNotMatch(html,/В архив/);
 const archived=renderToStaticMarkup(React.createElement(TaskBoardControls,{
  task:{...t,board_status:'done',archived_at:'2026-11-15T12:00:00Z'},busy:false,onAction:async()=>{}
 }));
 assert.match(archived,/Восстановить из архива/);
 assert.doesNotMatch(archived,/Принять результат/);
});

test('task details display live PM work DAG, dependencies and a separate legacy technical stage',()=>{
 const a={id:'a',plan_id:'plan-1',plan_key:'research',role:'analysis',
  objective:'Исследовать технические ограничения',acceptance:'Проверенная архитектурная заметка',
  status:'completed',result:'Готово',evidence:'Проверенный отчёт',prerequisites:[],created_at:'2026-11-15'};
 const b={id:'b',plan_id:'plan-1',plan_key:'qa',role:'testing',
  objective:'Проверить работу по требуемым критериям',acceptance:'Результаты браузерных тестов',
  status:'queued',result:null,evidence:null,prerequisites:[{id:'a',key:'research',status:'completed'}],created_at:'2026-11-15'};
 const html=renderToStaticMarkup(React.createElement(TaskExecutionPlan,{
  assignments:[a,b],kickoff:{id:'msg',pm_order_id:'order',status:'completed',pm_dispatch_attempt:1},
  stage:'backlog',stageLabel:'Бэклог',busy:false,onRetry:()=>{}
 }));
 assert.match(html,/План выполнения/);
 assert.match(html,/Аналитик/);
 assert.match(html,/QA/);
 assert.match(html,/После:/);
 assert.match(html,/В очереди/);
 assert.match(html,/Текущий технический этап: Бэклог/);
});
test('failed kickoff supports retry without inventing task completion',()=>{
 const html=renderToStaticMarkup(React.createElement(TaskExecutionPlan,{
  assignments:[],kickoff:{id:'msg',pm_order_id:'order',status:'failed',pm_dispatch_attempt:1},
  stage:'backlog',stageLabel:'Бэклог',busy:false,onRetry:()=>{}
 }));
 assert.match(html,/Планирование PM завершилось ошибкой/);
 assert.match(html,/Повторить запуск PM/);
 assert.doesNotMatch(html,/Принять результат/);
});

test('Kanban and task list reveal which specialist is actually working and what they do',()=>{
 const work=[{role:'documentation',status:'running',detail:'Сделать desktop и mobile снимки сайта',
  source:'assignment',updated_at:'2026-11-15T12:00:00Z'}];
 const t=task('47',{stage:'backlog',board_status:'in_progress',current_work:work});
 const html=renderToStaticMarkup(React.createElement(TaskBoard,props([t],[])));
 assert.match(html,/В работе/);
 assert.match(html,/Исполнение по плану ПМ/);
 assert.match(html,/Документация · Работает/);
 assert.match(html,/desktop и mobile/);
 const compact=renderToStaticMarkup(React.createElement(TaskCurrentWork,{items:work,compact:true}));
 assert.match(compact,/Сделать desktop и mobile/);
 assert.match(describeCurrentWork({role:'manager',status:'processing',detail:'План',
  source:'pm'}),/ПМ · Работает/);
});

test('task modal execution stays collapsed but exposes real screenshot status and age',()=>{
 const old='2026-01-01T10:00:00Z';
 const html=renderToStaticMarkup(React.createElement(TaskExecutionPlan,{
  assignments:[],kickoff:null,stage:'testing',stageLabel:'Тестирование',
  evidenceRun:{id:'run1',source_sha:'a'.repeat(40),status:'queued',
   message:'Waiting for Temporal',created_at:old,updated_at:old},
  busy:false,onRetry:()=>{}
 }));
 assert.match(html,/<details class="task-dynamic-plan"/);
 assert.match(html,/<summary class="task-dynamic-summary"/);
 assert.match(html,/Скриншоты · в очереди/);
 assert.match(html,/нет обновлений более 8 мин/);
 assert.match(html,/Последнее событие/);
});
test('acceptance and defer date no longer occupy large permanent task cards',()=>{
 const taskData=task('18',{stage:'testing',board_status:'in_progress'});
 const html=renderToStaticMarkup(React.createElement(TaskBoardControls,{
  task:taskData,busy:false,onAction:async()=>{}
 }));
 assert.match(html,/<details class="task-board-policy"/);
 assert.match(html,/Приёмка: При завершении/);
 assert.match(html,/Отложить/);
 assert.doesNotMatch(html,/Отложить до \(необязательно\)/,
  'date selector is only revealed when user chooses to postpone');
});
