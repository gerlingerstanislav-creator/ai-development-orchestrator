import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ProjectListPage} from '../src/features/projects/ProjectListPage.tsx';

const p1={id:'123e4567-e89b-42d3-a456-426614174000',name:'First Project',
 description:'Active product',is_owner:true};
const p2={id:'123e4567-e89b-42d3-a456-426614174001',name:'Member Project',
 description:'',is_owner:false};
const deleted={id:'123e4567-e89b-42d3-a456-426614174002',name:'Deleted Project',
 description:'Archived project',deleted_at:'2026-11-14T00:00:00.000Z'};
function render(props={}){
 return renderToStaticMarkup(React.createElement(ProjectListPage,{
  projects:[p1,p2],trashedProjects:[deleted],showTrash:false,
  projectDeleteBusy:false,onToggleTrash:()=>{},onCreateProject:()=>{},
  onRestoreProject:()=>{},onPermanentlyDeleteProject:()=>{},
  onMoveProjectToTrash:()=>{},onFollowLink:()=>{},...props
 }));
}
test('workspace lists project links, descriptions and only owner-specific delete controls',()=>{
 const html=render();
 assert.match(html,/Мои проекты/);
 assert.match(html,/First Project/);
 assert.match(html,/Active product/);
 assert.match(html,/Member Project/);
 assert.match(html,/Описание проекта пока не добавлено/);
 assert.match(html,new RegExp('href="/projects/'+p1.id+'/tasks"'));
 assert.match(html,new RegExp('href="/projects/'+p2.id+'/tasks"'));
 assert.equal((html.match(/project-trash-button/g)||[]).length,1);
 assert.match(html,/Новый проект/);
});
test('trash shows recovery and permanent deletion without rendering active project cards',()=>{
 const html=render({showTrash:true});
 assert.match(html,/Корзина проектов/);
 assert.match(html,/Deleted Project/);
 assert.match(html,/Восстановить/);
 assert.match(html,/Удалить навсегда/);
 assert.doesNotMatch(html,/First Project/);
 assert.doesNotMatch(html,/Новый проект/);
 assert.match(html,/Репозитории GitHub не затрагиваются/);
});
test('busy delete state disables all dangerous project actions',()=>{
 const html=render({showTrash:true,projectDeleteBusy:true});
 assert.equal((html.match(/disabled=""/g)||[]).length,2);
 const active=render({projectDeleteBusy:true});
 assert.equal((active.match(/project-trash-button[^>]*disabled=""/g)||[]).length,1);
});
test('empty workspace and empty trash have distinct helpful placeholders',()=>{
 assert.match(render({projects:[],trashedProjects:[]}),/Пока нет проектов/);
 assert.match(render({showTrash:true,trashedProjects:[]}),/Корзина пуста/);
});
