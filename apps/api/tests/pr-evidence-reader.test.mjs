import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv} from 'node:crypto';
import {createPrEvidenceReader} from '../dist/modules/integrations/github/infrastructure/pr-evidence.js';
import {decryptConnectionSecret} from '../dist/modules/integrations/connections/secret-cipher.js';

const project='123e4567-e89b-42d3-a456-426614174002';
const task='123e4567-e89b-42d3-a456-426614174003';
const sha='a'.repeat(40);
const token='safe-secret-github-token';
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status});

function fixture({hasTask=true,prNumber=17,hasGithub=true,
 pr={head:{sha},body:'Owner-approved description'},
 files=[{filename:'apps/web/src/main.tsx',status:'modified',patch:'@@ -1 +1 @@\n+correct behavior'}],
 prStatus=200,filesStatus=200}={}){
 const sql=[],calls=[],tokens=[];
 const pool={query:async(text,args)=>{
  sql.push({text,args});
  if(text.startsWith('SELECT pr_number,git_branch'))return {rows:hasTask?[{pr_number:prNumber,git_branch:'feature/work'}]:[],rowCount:hasTask?1:0};
  if(text.startsWith('SELECT g.repository,c.secret_encrypted'))return {rows:hasGithub?[{repository:'acme/repo',secret_encrypted:'encrypted-token'}]:[],rowCount:hasGithub?1:0};
  throw Error('Unexpected SQL '+text);
 }};
 const http=async(url,options)=>{
  calls.push({url,options});
  assert.ok(url.startsWith('https://api.github.com/repos/acme/repo/pulls/17'),url);
  assert.equal(options.headers.Authorization,'Bearer '+token);
  assert.equal(options.headers['X-GitHub-Api-Version'],'2022-11-28');
  assert.ok(options.signal,'bounded requests must have AbortSignal');
  return url.includes('/files?')?reply(files,filesStatus):reply(pr,prStatus);
 };
 const read=createPrEvidenceReader(pool,encrypted=>{
  tokens.push(encrypted);return token;
 },http);
 return {read,sql,calls,tokens};
}

test('reads current PR evidence from project-scoped GitHub connection, bounded by legacy contracts',async()=>{
 const f=fixture({files:[
  {filename:'src/a.ts',status:'added',patch:'x'.repeat(6000)},
  {filename:'src/b.ts',status:'modified',patch:'smaller'}
 ],pr:{head:{sha},body:'S'.repeat(2500)}});
 const data=await f.read(project,task);
 assert.equal(data.commitSha,sha);
 assert.equal(data.summary.length,2000);
 assert.ok(data.patch.includes('src/a.ts (added)'));
 assert.equal(data.patch.includes('x'.repeat(3801)),false);
 assert.ok(data.patch.includes('src/b.ts (modified)'));
 assert.ok(data.patch.length<=16500);
 assert.equal(f.sql.length,2);
 assert.deepEqual(f.sql[0].args,[task,project]);
 assert.deepEqual(f.sql[1].args,[project]);
 assert.match(f.sql[1].text,/c\.provider='github_token'/);
 assert.deepEqual(f.tokens,['encrypted-token']);
 assert.equal(f.calls.length,2);
 assert.equal(f.calls.filter(x=>x.url.endsWith('/files?per_page=65')).length,1);
 assert.ok(f.calls.every(x=>x.options.signal));
 assert.equal(JSON.stringify(data).includes(token),false);
});

test('missing task and absent PR never perform GitHub requests or decrypt tokens',async()=>{
 const noTask=fixture({hasTask:false});
 await assert.rejects(noTask.read(project,task),/Задача не найдена/);
 assert.equal(noTask.calls.length,0);
 const noPr=fixture({prNumber:null});
 assert.deepEqual(await noPr.read(project,task),{commitSha:'',patch:'PR ещё не создан',summary:''});
 assert.equal(noPr.calls.length,0);
 assert.equal(noPr.tokens.length,0);
 assert.equal(noPr.sql.length,1);
});

test('unavailable project token is rejected before any outbound request',async()=>{
 const f=fixture({hasGithub:false});
 await assert.rejects(f.read(project,task),/GitHub-подключение для анализа PR не найдено/);
 assert.equal(f.calls.length,0);
 assert.equal(f.tokens.length,0);
});

test('GitHub failed PR/files fetch and malformed files are not silently accepted',async()=>{
 const badPr=fixture({prStatus:404});
 await assert.rejects(badPr.read(project,task),/Не удалось прочитать актуальные изменения PR/);
 const badFiles=fixture({filesStatus:403});
 await assert.rejects(badFiles.read(project,task),/Не удалось прочитать актуальные изменения PR/);
 const malformed=fixture({files:{error:'forbidden'}});
 await assert.rejects(malformed.read(project,task),/Некорректный ответ GitHub о файлах PR/);
});

test('empty patch and missing PR description preserve previous fallback values',async()=>{
 const f=fixture({pr:{head:{},body:null},files:[]});
 assert.deepEqual(await f.read(project,task),{commitSha:'',patch:'Нет текстовых изменений',summary:''});
});

test('existing AES-GCM credential envelope remains readable for Temporal GitHub work',()=>{
 const key=Buffer.alloc(32,4);
 const iv=Buffer.alloc(12,5);
 const cipher=createCipheriv('aes-256-gcm',key,iv);
 const raw=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);
 const legacy=Buffer.concat([iv,cipher.getAuthTag(),raw]).toString('base64');
 assert.equal(decryptConnectionSecret(legacy,key),token);
 assert.throws(()=>decryptConnectionSecret(legacy,Buffer.alloc(32,9)));
});
