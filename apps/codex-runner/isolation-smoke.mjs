import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import net from 'node:net';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTaskPolicy,runnerEnvironment,qaAllowedDomains} from './execution-policy.mjs';

const root=await mkdtemp(join(tmpdir(),'ado-isolation-'));
const auth=await mkdtemp(join(process.env.CODEX_HOME||homedir(),'ado-smoke-auth-'));
const server=net.createServer(socket=>socket.end());
try{
 await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
 const workdir=join(root,'job'),repo=join(workdir,'repo'),git=join(repo,'.git'),sibling=join(root,'other-job');
 const agentSettings=join(repo,'.agents','project.txt');
 await Promise.all([mkdir(git,{recursive:true}),mkdir(sibling,{recursive:true}),mkdir(join(repo,'.agents'),{recursive:true})]);
 const gitConfig=join(git,'config'),secret=join(auth,'auth.json'),otherFile=join(sibling,'private.txt');
 await Promise.all([writeFile(gitConfig,'git metadata'),writeFile(secret,'fake OAuth credentials'),writeFile(otherFile,'other task'),writeFile(agentSettings,'project settings')]);
 const policy=await createTaskPolicy(workdir);
 const probe=`
  const assert=require('node:assert/strict');
  const fs=require('node:fs');
  const net=require('node:net');
  const [secret,other,gitConfig,agentSettings,scratch,port]=process.argv.slice(1);
  for(const path of [secret,other])assert.throws(()=>fs.readFileSync(path));
  for(const path of [gitConfig,agentSettings])assert.throws(()=>fs.writeFileSync(path,'changed'));
  fs.writeFileSync('job.txt','workspace works');
  fs.writeFileSync(scratch+'/temp.txt','scratch works');
  const socket=net.connect(Number(port),'127.0.0.1');
  socket.on('connect',()=>{socket.destroy();process.exitCode=91;});
  socket.on('error',()=>{});
 `;
 const env={...runnerEnvironment(),HOME:homedir(),CODEX_HOME:auth};
 const child=spawn('codex',[...policy.sandboxArgs,'--','node','-e',probe,secret,otherFile,gitConfig,agentSettings,join(workdir,'scratch'),String(server.address().port)],{
  cwd:repo,env,stdio:['ignore','inherit','inherit'],timeout:15000
 });
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 assert.equal(code,0,'Codex sandbox must enforce filesystem and network boundaries');
 assert.equal(await readFile(gitConfig,'utf8'),'git metadata');
 assert.equal(await readFile(join(repo,'job.txt'),'utf8'),'workspace works');
 assert.equal(await readFile(join(workdir,'scratch','temp.txt'),'utf8'),'scratch works');
 const qaPolicy=await createTaskPolicy(workdir,{qa:true});
 const qaArgs=qaPolicy.sandboxArgs.join(' ');
 assert.match(qaArgs,/features\.network_proxy=true/);
 assert.match(qaArgs,/permissions\.ado-qa\.network\.enabled=true/);
 for(const domain of qaAllowedDomains)assert.ok(qaArgs.includes(domain),'missing QA network allowlist entry '+domain);
 assert.ok(!qaAllowedDomains.includes('api'),'QA cannot access platform service DNS');
 assert.ok(!qaAllowedDomains.includes('db'),'QA cannot access PostgreSQL DNS');
 const qaRun=async(label,binary,args,timeout=45000)=>{
  const command=spawn('codex',[...qaPolicy.sandboxArgs,'--',binary,...args],{
   cwd:repo,env,stdio:['ignore','pipe','pipe']
  });
  let out='',err='';
  command.stdout.on('data',chunk=>{out+=chunk.toString();});
  command.stderr.on('data',chunk=>{err+=chunk.toString();});
  const timer=setTimeout(()=>command.kill('SIGTERM'),timeout);
  const status=await new Promise((resolve,reject)=>{command.once('error',reject);command.once('close',resolve);});
  clearTimeout(timer);
  assert.equal(status,0,label+' failed: '+out.slice(-1200)+' '+err.slice(-1200));
  return out;
 };
 // Codex QA commands may install dependencies from approved registries.
 // This is an end-to-end check of the actual proxy, not just config parsing.
 const version=await qaRun('registry allowlist','npm',['view','is-number@7.0.0','version','--fetch-retries=0'],90000);
 assert.match(version,/7\.0\.0/);
 // Local test servers run entirely inside the disposable QA workspace.
 const proxyEnv=await qaRun('QA network diagnostics','node',['-e',
  "console.log(JSON.stringify({http:process.env.HTTP_PROXY,https:process.env.HTTPS_PROXY,no:process.env.NO_PROXY,lower:process.env.no_proxy,node:process.env.NODE_USE_ENV_PROXY}))"]);
 console.log('QA sandbox network configuration:',proxyEnv.trim());
 const localCheck=`
  const assert=require('node:assert/strict'),http=require('node:http');
  const server=http.createServer((req,res)=>res.end('qa-local-ok'));
  server.listen(0,'127.0.0.1',async()=>{
   try{const response=await fetch('http://127.0.0.1:'+server.address().port);
    assert.equal(await response.text(),'qa-local-ok');server.close();}
   catch(error){console.error(error);server.close();process.exitCode=1;}
  });
 `;
 await qaRun('QA loopback server','env',['NO_PROXY=localhost,127.0.0.1,::1','no_proxy=localhost,127.0.0.1,::1','node','-e',localCheck],30000);
 // Arbitrary public destinations must remain denied, even though registry
 // downloads succeeded and loopback is available.
 const deniedCheck=`
  const assert=require('node:assert/strict');
  (async()=>{try{
   const response=await fetch('https://example.com',{signal:AbortSignal.timeout(7000)});
   assert.ok(response.status===403,'Unapproved external host reached (HTTP '+response.status+')');
  }catch(error){
   if(error.code==='ERR_ASSERTION')throw error;
   // An enforced proxy may reject the socket instead of returning HTTP 403.
  }})().catch(error=>{console.error(error);process.exitCode=1;});
 `;
 await qaRun('QA deny unapproved domain','node',['-e',deniedCheck],17000);
 // Ensure a real headless browser launches under the *same* sandbox profile.
 const browserCheck=`
  const {chromium}=require('@playwright/test'),assert=require('node:assert/strict');
  (async()=>{const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
   try{const page=await browser.newPage();await page.goto('data:text/html,<title>QA ready</title>');
    assert.equal(await page.title(),'QA ready');await page.screenshot({path:'qa-browser-smoke.png'});}
   finally{await browser.close();}
  })().catch(error=>{console.error(error);process.exitCode=1;});
 `;
 await qaRun('Playwright Chromium','node',['-e',browserCheck],40000);
 assert.equal((await readFile(join(repo,'qa-browser-smoke.png'))).subarray(0,4).toString('hex'),'89504e47');
 console.log('Runner sandbox isolates project files, Codex credentials and Git metadata; QA proxy allows registries, loopback, and headless browser');
}finally{
 server.close();
 await Promise.all([rm(root,{recursive:true,force:true}),rm(auth,{recursive:true,force:true})]);
}
