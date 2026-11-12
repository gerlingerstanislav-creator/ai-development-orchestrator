import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAgentMention,resolveAgentMention} from '../dist/agent-mentions.js';

test('resolves explicit, case-insensitive leading agent mentions',()=>{
 assert.deepEqual(parseAgentMention('@Analyst проверь ТЗ'),{alias:'Analyst',stage:'analysis',message:'проверь ТЗ'});
 assert.deepEqual(parseAgentMention('  @qa: какие проверки нужны?'),{alias:'QA',stage:'testing',message:'какие проверки нужны?'});
 assert.equal(parseAgentMention('Пожалуйста, позови @QA'),null);
 assert.equal(parseAgentMention('@QAnalyst проверь'),null);
 assert.deepEqual(parseAgentMention('@DevOps проверь CI'),{alias:'DevOps',stage:'devops',message:'проверь CI'});
 assert.deepEqual(parseAgentMention(' @devops: статус деплоя?'),{alias:'DevOps',stage:'devops',message:'статус деплоя?'});
 assert.equal(parseAgentMention('обратись к @DevOps'),null);
});
test('uses workflow-scoped instructions and rejects unavailable agents',async()=>{
 const calls=[];
 const pool={query:async(sql,params)=>{calls.push(params);return {rowCount:1,rows:[{agent_name:'AI-тестировщик',agent_instructions:'Проверяй регрессии'}]};}};
 const agent=await resolveAgentMention(pool,'project-1','@QA Покажи риски');
 assert.equal(agent.name,'AI-тестировщик');
 assert.equal(agent.instructions,'Проверяй регрессии');
 assert.deepEqual(calls[0],['project-1','testing']);
 await assert.rejects(()=>resolveAgentMention(pool,'project-1','@QA'),/напиши сообщение/);
 const empty={query:async()=>({rowCount:0,rows:[]})};
 await assert.rejects(()=>resolveAgentMention(empty,'project-1','@Analyst вопрос'),/не настроен/);
});

test('DevOps resolves from project specialist registry, not the merge workflow stage',async()=>{
 const calls=[];
 const pool={query:async(sql,params)=>{calls.push({sql,params});return {rowCount:1,rows:[{agent_name:'AI-DevOps',agent_instructions:'Keep deployments idempotent'}]};}};
 const agent=await resolveAgentMention(pool,'project-1','@DevOps проверь повторные CI сборки');
 assert.equal(agent.name,'AI-DevOps');
 assert.equal(agent.stage,'devops');
 assert.match(calls[0].sql,/project_specialist_agents/);
 assert.deepEqual(calls[0].params,['project-1','devops']);
});

test('Architect mention addresses a specialist without starting a workflow',async()=>{
 const calls=[];
 const pool={query:async(sql,params)=>{calls.push({sql,params});return {rowCount:1,rows:[{agent_name:'Архитектор платформы',agent_instructions:'Review the PR'}]};}};
 const agent=await resolveAgentMention(pool,'project-1','@Architect проверь PR');
 assert.equal(agent.stage,'architect');assert.equal(agent.alias,'Architect');
 assert.match(calls[0].sql,/project_specialist_agents/);
 assert.deepEqual(calls[0].params,['project-1','architect']);
});
