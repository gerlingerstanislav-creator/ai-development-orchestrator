import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TaskBoard} from '../src/features/tasks/TaskBoard.tsx';
import {groupKanbanStages,dependencyReady,kanbanOrder,boardLaneFor} from '../src/features/tasks/board-model.ts';

const task=(id,props={})=>({
 id,display_number:Number(id.replace(/\D/g,''))||1,
 title:'Задача '+id,description:'Требования',type:'task',stage:'development',
 created_at:'2026-11-12T12:00:00Z',...props
});
test('stage grouping preserves horizontal workflow order and includes custom stages',()=>{
 const stages=[
  {stage:'backlog',label:'Бэклог'},{stage:'analysis',label:'Анализ'},
  {stage:'development',label:'Разработка'},{stage:'testing',label:'Тестирование'},
  {stage:'merge_queue',label:'Слияние'},{stage:'deployment',label:'Выкладка'},
  {stage:'documentation',label:'Документация'},{stage:'done',label:'Готово'},
  {stage:'custom',label:'Дополнительно'}
 ];
 const groups=groupKanbanStages(stages);
 assert.deepEqual(groups.map(g=>g.key),['analytics','development','results','other']);
 assert.deepEqual(groups[1].stages.map(s=>s.stage),['development','testing','merge_queue']);
 assert.deepEqual(groups[3].stages.map(s=>s.stage),['custom']);
 assert.deepEqual(groupKanbanStages([]),[]);
});
test('dependency readiness requires completed handoff or an attached merge PR',()=>{
 const merged=task('1',{stage:'merge_queue',pr_url:'https://github.com/acme/demo/pull/1',git_branch:'feature'});
 const waiting=task('2',{depends_on_task_id:'1'});
 assert.equal(dependencyReady(waiting,[merged,waiting]),true);
 assert.equal(dependencyReady(waiting,[{...merged,git_branch:null},waiting]),false);
 assert.equal(dependencyReady(waiting,[{...merged,pr_url:null},waiting]),false);
 assert.equal(dependencyReady(waiting,[{...merged,stage:'documentation'},waiting]),true);
 assert.equal(dependencyReady(waiting,[waiting]),false);
 assert.equal(dependencyReady(task('3'),[]),true);
 assert.equal(boardLaneFor(merged),'merge_queue');
});
test('priority sorting puts unblocked work before blocked tasks and is stable',()=>{
 const ready=task('10',{priority:3});
 const blocked=task('20',{priority:1,awaits_product_owner:true});
 const urgent=task('30',{priority:1,created_at:'2026-11-12T10:00:00Z'});
 const arr=[blocked,ready,urgent];
 arr.sort((a,b)=>kanbanOrder(a,b,arr));
 assert.deepEqual(arr.map(x=>x.id),['30','10','20']);
});
test('board renders an expandable set of lane columns without changing task links',()=>{
 const stages=[{stage:'development',label:'Разработка'},{stage:'testing',label:'Тестирование'}];
 const t=task('101',{awaits_product_owner:true});
 const html=renderToStaticMarkup(React.createElement(TaskBoard,{
  projectId:'project-1',tasks:[t],filtered:[t],stages,
  expandedGroups:['development'],onToggleGroup:()=>{},
  renderTaskPlanningLabels:()=>null,agentWorking:()=>false,onFollowLink:()=>{},
  onMoveTask:()=>{},questionAnswers:{},onQuestionDraft:()=>{},
  onAnswerQuestion:()=>{},processActionBusy:false,
  mergeBusy:false,onMerge:()=>{},knowledgeBusy:false,onUpdateDocumentation:()=>{}
 }));
 assert.match(html,/board board-groups/);
 assert.match(html,/kanban-group-stages/);
 assert.match(html,/Разработка/);
 assert.match(html,/Тестирование/);
 assert.match(html,/\/projects\/project-1\/tasks\/101/);
 assert.match(html,/Нужен ответ владельца/);
});
test('collapsed groups show tasks together instead of rendering stage columns',()=>{
 const stages=[{stage:'development',label:'Разработка'},{stage:'testing',label:'Тестирование'}];
 const html=renderToStaticMarkup(React.createElement(TaskBoard,{
  projectId:'project-2',tasks:[task('1')],filtered:[task('1')],stages,
  expandedGroups:[],onToggleGroup:()=>{},renderTaskPlanningLabels:()=>null,
  agentWorking:()=>false,onFollowLink:()=>{},onMoveTask:()=>{},
  questionAnswers:{},onQuestionDraft:()=>{},onAnswerQuestion:()=>{},
  processActionBusy:false,mergeBusy:false,onMerge:()=>{},
  knowledgeBusy:false,onUpdateDocumentation:()=>{}
 }));
 assert.match(html,/kanban-group-combined/);
 assert.doesNotMatch(html,/kanban-group-stages/);
});
