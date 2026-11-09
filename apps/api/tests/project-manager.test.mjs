import test from 'node:test';
import assert from 'node:assert/strict';
import {checkedWithActualCapabilities,isVisualAcceptanceCase} from '../dist/qa-evidence.js';
import {managerRequestText} from '../dist/project-manager.js';

test('browserless QA cannot certify a visual circle layout by reading CSS',()=>{
 const planned=[{id:'circle',title:'Фигуры расположены по окружности и стрелки видны',
  steps:[{action:'Открыть страницу в браузере',expected:'Фигуры по окружности, стрелки не пересекаются'}]}];
 const reported=[{case_id:'circle',result:'passed',reason:'executed',evidence:'Read CSS and concluded that positions are correct'}];
 const result=checkedWithActualCapabilities(planned,reported,
  'chromium: unavailable\nchromium-browser: unavailable\ngoogle-chrome: unavailable\nplaywright: unavailable');
 assert.equal(isVisualAcceptanceCase(planned[0]),true);
 assert.equal(result.visualToolGap,true);
 assert.equal(result.cases[0].result,'blocked');
 assert.equal(result.cases[0].reason,'tool_unavailable');
 assert.match(result.cases[0].evidence,/не запускалась/);
});
test('real browser capability does not replace actual per-case evidence',()=>{
 const planned=[{id:'layout',title:'Responsive layout'}];
 const reported=[{case_id:'layout',result:'not_run',reason:'unknown',evidence:'No checks'}];
 const result=checkedWithActualCapabilities(planned,reported,'chromium: available\nplaywright: available');
 assert.equal(result.visualToolGap,false);
 assert.equal(result.cases[0].result,'not_run');
});
test('non-visual server checks may pass without browser',()=>{
 const planned=[{id:'api',title:'API returns 200 and schema matches'}];
 const reported=[{case_id:'api',result:'passed',reason:'executed',evidence:'curl returned 200 and API schema matched'}];
 const result=checkedWithActualCapabilities(planned,reported,'chromium: unavailable');
 assert.equal(result.visualToolGap,false);
 assert.equal(result.cases[0].result,'passed');
});
test('the manager asks for an explicit decision without asserting that skipped tests passed',()=>{
 const message=managerRequestText('qa_visual',{assessment:{passed:2,total:5,unverified:[
  {title:'Circle layout',evidence:'Chrome browser not installed'},
  {title:'Responsive arrows',evidence:'No browser screenshot tool'},
  {title:'Viewport 360',evidence:'No device emulator'}
 ]}});
 assert.match(message,/Менеджер|Тестировщик|Тестировщик/);
 assert.match(message,/не смог проверить 3 сценариев/);
 assert.match(message,/ждём появления инструментов/);
 assert.match(message,/не объявляю эти проверки успешными/);
});
