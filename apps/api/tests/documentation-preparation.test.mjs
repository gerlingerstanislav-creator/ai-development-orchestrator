import test from 'node:test';
import assert from 'node:assert/strict';
import {assertDocumentationWasPrepared,readGitHubProjectSource} from '../dist/documentation-preparation.js';

const commit='a'.repeat(40),treeSha='b'.repeat(40);
const repo='https://api.github.com/repos/acme/landing';
function fixtureResponse(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});}
test('delegated spec preparation cannot complete without saved documents, while conversational no-op remains valid',()=>{
 assert.throws(()=>assertDocumentationWasPrepared(true,0,'Нет нужного материала'),/не создал и не обновил.*Нет нужного материала/);
 assert.doesNotThrow(()=>assertDocumentationWasPrepared(false,0,'Только консультация'));
 assert.doesNotThrow(()=>assertDocumentationWasPrepared(true,1,'Страница записана'));
});

test('project research pins source to the commit, uses its tree SHA and reads bounded text only',async()=>{
 const calls=[],source=new Map([
  [repo+'/commits/main',{sha:commit,commit:{tree:{sha:treeSha}}}],
  [repo+'/git/trees/'+treeSha+'?recursive=1',{tree:[
   {path:'images/logo.png',type:'blob',size:1000},
   {path:'index.html',type:'blob',size:220},
   {path:'README.md',type:'blob',size:140}
  ]}],
  [repo+'/contents/README.md?ref='+commit,{type:'file',encoding:'base64',content:Buffer.from('# Сайт перевозки маломобильных пассажиров').toString('base64')}],
  [repo+'/contents/index.html?ref='+commit,{type:'file',encoding:'base64',content:Buffer.from('<h1>Заказ специального автомобиля</h1>').toString('base64')}]
 ]);
 const client=async (url,opts)=>{
  calls.push({url,auth:opts?.headers?.Authorization});
  assert.ok(source.has(url),'Unexpected GitHub request '+url);
  return fixtureResponse(source.get(url));
 };
 const result=await readGitHubProjectSource('acme/landing','main','private-token',client);
 assert.equal(result.commit,commit);
 assert.deepEqual(result.files.map(f=>f.path),['README.md','index.html']);
 assert.ok(result.files[0].content.includes('перевозки'));
 assert.ok(!calls.some(c=>/logo.png/.test(c.url)));
 assert.ok(calls.every(c=>c.auth==='Bearer private-token'));
 assert.ok(calls.every(c=>c.url.startsWith(repo+'/')));
});
test('missing GitHub permission must block research, never be replaced with invented facts',async()=>{
 await assert.rejects(()=>readGitHubProjectSource('acme/landing','main','',async()=>fixtureResponse({message:'Forbidden'},403)),/HTTP 403/);
 await assert.rejects(()=>readGitHubProjectSource('https://other.host/repo','main','',async()=>fixtureResponse({})),/Некорректный GitHub-репозиторий/);
});
