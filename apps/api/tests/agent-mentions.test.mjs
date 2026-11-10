import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAgentMention,resolveAgentMention} from '../dist/agent-mentions.js';

test('resolves explicit, case-insensitive leading agent mentions',()=>{
 assert.deepEqual(parseAgentMention('@Analyst проверь ТЗ'),{alias:'Analyst',stage:'analysis',message:'проверь ТЗ'});
 assert.deepEqual(parseAgentMention('  @qa: какие проверки нужны?'),{alias:'QA',stage:'testing',message:'какие проверки нужны?'});
 assert.equal(parseAgentMention('Пожалуйста, позови @QA'),null);
 assert.equal(parseAgentMention('@QAnalyst проверь'),null);
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
