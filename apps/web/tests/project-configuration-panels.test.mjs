import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ProjectWorkflowDiagram,ProjectSettingsPanel} from '../src/features/projects/ProjectConfigurationPanels.js';

const noop=()=>{};
const stages=[
 {stage:'analysis',label:'Анализ',description:'Собрать требования',mode:'automatic',position:1,agent_name:'analyst',agent_instructions:''},
 {stage:'development',label:'Разработка',description:'Изменить код',mode:'automatic',position:2,agent_name:'developer',agent_instructions:''},
 {stage:'testing',label:'Тестирование',description:'Проверить результат',mode:'approval',position:3,agent_name:'QA',agent_instructions:''},
 {stage:'deployment',label:'Выкатка',description:'Развернуть',mode:'manual',position:4,agent_name:'devops',agent_instructions:''}
];
const diagram=(mode='skip')=>renderToStaticMarkup(React.createElement(ProjectWorkflowDiagram,{
 stages,deploymentMode:mode,onOpenStage:noop
}));
const defaultSettings={
 aiSettings:{model:'gpt-6-sol',reasoning:'medium',enabled:true},onAiSettingsChange:noop,
 aiBusy:false,onSaveAiSettings:noop,aiMessage:'',
 gitRepository:'owner/repo',onGitRepositoryChange:noop,
 targetBranch:'release',onTargetBranchChange:noop,
 gitTokenId:'token-a',onGitTokenIdChange:noop,
 connections:[{id:'token-a',name:'Personal GitHub',provider:'github_token'}],
 gitLink:{repository:'owner/repo',default_branch:'main',target_branch:'release',connection_id:'token-a'},
 gitBusy:false,gitMessage:'',onSaveGitLink:noop,onRemoveGitLink:noop,onFollowLink:noop
};
const settings=(overrides={})=>renderToStaticMarkup(React.createElement(ProjectSettingsPanel,{...defaultSettings,...overrides}));

test('workflow stays horizontal with every configured stage and transition label',()=>{
 const html=diagram();
 assert.match(html,/workflow-diagram-scroll/);
 assert.match(html,/Последовательность этапов проекта/);
 for(const stage of stages)assert.match(html,new RegExp(stage.label));
 assert.match(html,/Переход: Анализ → Разработка/);
 assert.match(html,/Переход: Разработка → Тестирование/);
 assert.equal((html.match(/workflow-stage-card /g)||[]).length,4);
});
test('QA failure retains an explicit return path to development',()=>{
 const html=diagram();
 assert.match(html,/Тестирование → Разработка/);
 assert.match(html,/Возврат из тестирования в разработку при ошибках/);
 assert.match(html,/workflow-feedback-path/);
});
test('deployment mode is rendered from workflow settings without changing the stage list',()=>{
 assert.match(diagram('skip'),/Пропуск без окружения/);
 assert.match(diagram('manual'),/Ручное подтверждение/);
 assert.match(diagram('automatic'),/GitHub Actions \+ проверка/);
});
test('project settings retain AI model, reasoning, enable control, and GitHub association',()=>{
 const html=settings();
 assert.match(html,/gpt-6-sol/);
 assert.match(html,/Модель по умолчанию/);
 assert.match(html,/Глубина рассуждений/);
 assert.match(html,/Разрешить работу AI-агентов/);
 assert.match(html,/checked=""/);
 assert.match(html,/owner\/repo/);
 assert.match(html,/release/);
 assert.match(html,/Personal GitHub/);
 assert.match(html,/Отвязать репозиторий/);
 assert.match(html,/Управлять токенами/);
});
test('settings disable mutations when API action is running',()=>{
 const html=settings({aiBusy:true,gitBusy:true});
 assert.match(html,/disabled=""[^>]*>Сохранить настройки AI/);
 assert.match(html,/disabled=""[^>]*>Проверить и сохранить/);
 assert.match(html,/disabled=""[^>]*>Отвязать репозиторий/);
});
test('missing GitHub credentials point to profile rather than accepting an invalid association',()=>{
 const html=settings({connections:[],gitTokenId:'',gitLink:null,gitRepository:''});
 assert.match(html,/Нет сохранённых токенов/);
 assert.match(html,/Добавить токен в профиле/);
 assert.match(html,/disabled=""[^>]*>Проверить и сохранить/);
 assert.doesNotMatch(html,/Отвязать репозиторий/);
});
test('AI disabled setting is displayed without silently enabling agents',()=>{
 const html=settings({aiSettings:{model:'gpt-6-luna',reasoning:'low',enabled:false}});
 assert.match(html,/Разрешить работу AI-агентов/);
 assert.doesNotMatch(html,/checked=""/);
});
