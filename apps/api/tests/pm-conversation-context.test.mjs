import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPmConversationContext}
 from '../dist/modules/planning/domain/pm-conversation-context.js';

test('ordinary conversation remains light without durable goals or decisions',()=>{
 assert.equal(buildPmConversationContext([],[]),'');
});

test('active goals and prior owner decisions survive the short chat context window',()=>{
 const current=[
  {id:'00000000-0000-4000-8000-000000000001',objective:'Получить проверенные скриншоты',
   criteria:['Снимки отображаются в задаче','Проверена текущая версия'],status:'working',
   order_id:'00000000-0000-4000-8000-000000000002'},
  {id:'00000000-0000-4000-8000-000000000003',objective:'Подготовить документы',
   criteria:['ТЗ воспроизведено по исходникам'],status:'waiting_user'}
 ];
 const context=buildPmConversationContext(current,[
  {question:'Можно ли выкладывать?',answer:'Нет, только после согласования'}
 ]);
 assert.match(context,/Получить проверенные скриншоты/);
 assert.match(context,/00000000-0000-4000-8000-000000000001/);
 assert.match(context,/критерии: Снимки отображаются в задаче/);
 assert.match(context,/ТЗ воспроизведено/);
 assert.match(context,/Нет, только после согласования/);
 assert.doesNotMatch(context,/задача завершена/i);
});
test('bounded context never inserts a full document or a large conversation into prompts',()=>{
 const huge='A'.repeat(10000);
 const rows=Array.from({length:15},(_,i)=>({id:String(i),objective:huge,
  criteria:[huge],status:'working',order_id:null}));
 const text=buildPmConversationContext(rows,[{question:huge,answer:huge}],1000);
 assert.ok(text.length<=1150);
 assert.ok(!text.includes(huge.slice(0,1000)));
 assert.match(text,/Цель 0/);
});

test('a blocked goal preserves its proposed system improvement across PM turns',()=>{
 const context=buildPmConversationContext([{
  id:'00000000-0000-4000-8000-000000000001',
  objective:'Получить проверенные снимки работающего сайта',criteria:['Проверенные артефакты'],
  status:'needs_action',
  capability_proposal:{
   limitation:'Тестовая среда не допускает нужное действие браузера',
   options:[{description:'Подключить scoped browser tool к MCP Runner'}],
   recommended_index:0
  }
 }],[]);
 assert.match(context,/блокировка: Тестовая среда/);
 assert.match(context,/предлагаемый вариант: Подключить scoped browser tool/);
 assert.match(context,/подробности через goals.read/);
});
