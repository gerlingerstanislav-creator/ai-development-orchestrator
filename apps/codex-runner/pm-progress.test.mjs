import test from 'node:test';
import assert from 'node:assert/strict';
import {visibleCodexProgress,createPmProgressPublisher} from './pm-progress.mjs';

test('never expose raw reasoning, shell commands, tool input or tool results',()=>{
 assert.equal(visibleCodexProgress({method:'item/reasoning/textDelta',params:{delta:'hidden reasoning'}}),null);
 assert.equal(visibleCodexProgress({method:'item/started',params:{item:{
  type:'commandExecution',command:'cat ~/.codex/auth.json',result:'secret'
 }}}).text,'Выполняет разрешённую команду');
 assert.equal(visibleCodexProgress({method:'item/started',params:{item:{
  type:'mcpToolCall',tool:'tasks.read',arguments:{token:'supersecret'}
 }}}).text,'Вызов инструмента tasks.read');
 assert.equal(visibleCodexProgress({method:'item/completed',params:{
  item:{type:'mcpToolCall',tool:'tools.exec',result:'access_token=secret'}
 }}).text,'Инструмент tools.exec завершил работу');
 assert.equal(visibleCodexProgress({method:'item/reasoning/summaryTextDelta',params:{delta:'Проверяю сценарии'}}).kind,'summary');
 assert.equal(visibleCodexProgress({method:'item/agentMessage/delta',params:{delta:'Готовлю ответ'}}).kind,'message');
 assert.equal(visibleCodexProgress({method:'turn/plan/updated',params:{plan:[{
  step:'Передаю QA проверку',status:'inProgress'
 }]}}).text,'План: Передаю QA проверку');
});
test('publisher posts only sanitized sequential events with stable project and message identity',async()=>{
 const sent=[];
 const reporter=createPmProgressPublisher({
  apiUrl:'http://api:3001/internal/agent-tools',
  secret:'r'.repeat(40),projectId:'project',messageId:'message',attempt:2,
  fetchImpl:async(_url,options)=>{sent.push({
   url:_url,headers:options.headers,body:JSON.parse(options.body)
  });return {ok:true};}
 });
 reporter.publish({kind:'status',text:'ПМ начал работу'});
 reporter.onEvent({method:'item/reasoning/textDelta',params:{delta:'SECRET PRIVATE RAW'}});
 reporter.onEvent({method:'item/reasoning/summaryTextDelta',params:{delta:'Ищу доступные инструменты'}});
 reporter.onEvent({method:'item/started',params:{item:{type:'mcpToolCall',tool:'work.delegate',arguments:{
  password:'password must not be forwarded'
 }}}});
 reporter.onEvent({method:'item/agentMessage/delta',params:{delta:'Готовлю ответ'}});
 reporter.onEvent({method:'turn/completed'});
 await reporter.flush();
 assert.deepEqual(sent.map(item=>item.body.kind),['status','summary','tool','message','status']);
 assert.deepEqual(sent.map(item=>item.body.sequence),[1,2,3,4,5]);
 assert.ok(sent.every(item=>item.url==='http://api:3001/internal/pm-turn-progress'));
 assert.ok(sent.every(item=>item.headers['X-Runner-Secret']==='r'.repeat(40)));
 assert.ok(sent.every(item=>item.body.projectId==='project'&&item.body.messageId==='message'&&item.body.attempt===2));
 assert.ok(!JSON.stringify(sent).includes('SECRET PRIVATE RAW'));
 assert.ok(!JSON.stringify(sent).includes('password must not'));
});
