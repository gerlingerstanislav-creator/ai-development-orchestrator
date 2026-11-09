import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {parseAgentObject,completeStructured} from '../dist/structured-agent-response.js';

const schema=z.object({
 body:z.string().min(15),
 questions:z.array(z.string()).default([])
});

test('agent JSON: plain, fenced and quoted braces; do not swallow a second object',()=>{
 const one={body:'Требование с фигурной скобкой { внутри текста.',questions:['Как оформляется оплата?']};
 const fence=String.fromCharCode(96).repeat(3);
 assert.deepEqual(parseAgentObject(JSON.stringify(one)),one);
 assert.deepEqual(parseAgentObject(fence+'json\n'+JSON.stringify(one)+'\n'+fence),one);
 assert.deepEqual(parseAgentObject('Ответ аналитика:\n'+JSON.stringify(one)),one);
 assert.throws(()=>parseAgentObject(JSON.stringify(one)+'\n'+JSON.stringify({body:'Второе требование из продолжения',questions:[]})),
  /дополнительное содержимое/);
 assert.throws(()=>parseAgentObject('{"body":"оборванный текст'),/обрывается/);
});

test('malformed response near offset 5270: repair preserves both bodies and all PO questions',async()=>{
 const firstBody='Сохранённое требование. '+'А'.repeat(5140);
 const secondBody='Требование из второго JSON-объекта';
 const original=JSON.stringify({body:firstBody,questions:['Первый вопрос']})+'\n'+
  JSON.stringify({body:secondBody,questions:['Второй вопрос','Третий вопрос','Четвёртый вопрос','Пятый вопрос','Шестой вопрос','Седьмой вопрос']});
 const events=[],prompts=[],charged=[];
 const result=await completeStructured({
  prompt:'Составь четвёртую часть ТЗ',
  schema,label:'Предзаказ и выдача · часть 4/11',
  formatExample:'{"body":"...","questions":["..."]}',
  complete:async(prompt)=>{
   prompts.push(prompt);
   if(prompts.length===1)return {text:original,usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}};
   assert.match(prompt,/исправляешь структуру своего ответа/);
   assert.ok(prompt.includes(firstBody));
   assert.ok(prompt.includes(secondBody));
   assert.ok(prompt.includes('Седьмой вопрос'));
   return {text:JSON.stringify({body:firstBody+'\n'+secondBody,
    questions:['Первый вопрос','Второй вопрос','Третий вопрос','Четвёртый вопрос','Пятый вопрос','Шестой вопрос','Седьмой вопрос']}),
    usage:{input_tokens:2,cached_input_tokens:0,output_tokens:2}};
  },
  recordUsage:async usage=>charged.push(usage),
  progress:async(stage,message)=>events.push({stage,message})
 });
 assert.ok(result.body.includes(firstBody));
 assert.ok(result.body.includes(secondBody));
 assert.equal(result.questions.length,7);
 assert.equal(prompts.length,2);
 assert.equal(charged.length,2,'Record token usage for invalid and repaired answers');
 assert.deepEqual(events.map(e=>e.stage),['format_retry']);
 assert.match(events[0].message,/4\/11/);
});

test('exhausted structural repair fails explicitly and does not accept partial valid JSON',async()=>{
 let calls=0;
 await assert.rejects(completeStructured({
  prompt:'Тема',
  schema,label:'Тема · часть 4/11',formatExample:'{"body":"...","questions":[]}',
  complete:async()=>{calls++;return {text:'{"body":"Первая валидная часть длинного документа","questions":[]}{"body":"Вторая часть","questions":[]}'};},
  recordUsage:async()=>{},progress:async()=>{}
 }),/после 3 попыток/);
 assert.equal(calls,3);
});

test('oversized malformed answer is never truncated during repair',async()=>{
 let calls=0;
 await assert.rejects(completeStructured({
  prompt:'Тема',
  schema,label:'Большой документ',formatExample:'{"body":"...","questions":[]}',
  complete:async()=>{
   calls++;
   return {text:JSON.stringify({body:'Б'.repeat(33000),questions:[]})+'{"body":"продолжение"}'};
  },
  recordUsage:async()=>{},progress:async()=>{}
 }),/слишком велик для безопасного восстановления/);
 assert.equal(calls,1);
});
