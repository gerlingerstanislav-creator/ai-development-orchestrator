import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ProjectSidebar} from '../src/features/navigation/ProjectSidebar.tsx';

const id='123e4567-e89b-42d3-a456-426614174000';
const selected={id,name:'Test Project',is_owner:true,agents_running:true};
function html(patch={}){
 return renderToStaticMarkup(React.createElement(ProjectSidebar,{
  selected,projects:[selected],section:'tasks',projectMenuOpen:false,
  onToggleProjectMenu:()=>{},onCloseProjectMenu:()=>{},
  agentToggleBusy:false,onToggleProjectAgents:()=>{},
  onFollowLink:()=>{},onCreateProject:()=>{},
  accountSettings:false,onLogout:()=>{},
  ...patch
 }));
}
test('project sidebar preserves all nine navigation destinations and active task link',()=>{
 const result=html();
 for(const segment of ['overview','tasks','docs','plan','qa','processes','team','workflow','settings'])
  assert.match(result,new RegExp('href="/projects/'+id+'/'+segment+'"'));
 assert.match(result,/class="nav active"[^>]+href="\/projects\/123e4567[^"]*\/tasks"/);
 assert.match(result,/Администратор/);
 assert.match(result,/title="Выйти"/);
});
test('selected owner sees agent toggle with durable running/stopped semantics',()=>{
 const running=html();
 assert.match(running,/aria-label="Остановить запуск агентов проекта"/);
 const stopped=html({selected:{...selected,agents_running:false},projects:[{...selected,agents_running:false}]});
 assert.match(stopped,/aria-label="Запустить агентов проекта"/);
 assert.match(html({agentToggleBusy:true}),/disabled=""[^>]*aria-label|aria-label="Остановить запуск агентов проекта"[^>]*disabled/);
});
test('non-owner cannot toggle agent processes',()=>{
 const result=html({selected:{...selected,is_owner:false},projects:[{...selected,is_owner:false}]});
 assert.match(result,/project-agent-toggle[^>]*disabled=""/);
});
test('project dropdown keeps project switching and new-project entry',()=>{
 const second={id:'123e4567-e89b-42d3-a456-426614174001',name:'Second Project'};
 const result=html({projectMenuOpen:true,projects:[selected,second]});
 assert.match(result,/aria-expanded="true"/);
 assert.match(result,/Все проекты/);
 assert.match(result,/Новый проект/);
 assert.match(result,/Second Project/);
 assert.match(result,new RegExp('href="/projects/'+second.id+'/tasks"'));
});
test('without a selected project sidebar uses the workspace link, not project controls',()=>{
 const result=html({selected:null,projects:[],section:'tasks'});
 assert.match(result,/Мои проекты/);
 assert.match(result,/href="\/projects"/);
 assert.doesNotMatch(result,/project-agent-toggle/);
 assert.doesNotMatch(result,/sidebar-label">ПРОЕКТ/);
});
test('account settings link marks the active profile route',()=>{
 const result=html({accountSettings:true});
 assert.match(result,/account-settings-button active/);
 assert.match(result,/href="\/account\/settings"/);
});
