import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTaskPolicy,runnerEnvironment} from './execution-policy.mjs';

const root=await mkdtemp(join(tmpdir(),'ado-isolation-'));
const server=net.createServer(socket=>socket.end());
try{
 await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
 const workdir=join(root,'job'),repo=join(workdir,'repo'),git=join(repo,'.git'),sibling=join(root,'other-job');
 const auth=join(root,'codex-home'),agentSettings=join(repo,'.agents','project.txt');
 await Promise.all([mkdir(git,{recursive:true}),mkdir(sibling,{recursive:true}),mkdir(auth,{recursive:true}),mkdir(join(repo,'.agents'),{recursive:true})]);
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
 const env={...runnerEnvironment(),HOME:auth,CODEX_HOME:auth};
 const child=spawn('codex',[...policy.sandboxArgs,'--','node','-e',probe,secret,otherFile,gitConfig,agentSettings,join(workdir,'scratch'),String(server.address().port)],{
  cwd:repo,env,stdio:['ignore','inherit','inherit'],timeout:15000
 });
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 assert.equal(code,0,'Codex sandbox must enforce filesystem and network boundaries');
 assert.equal(await readFile(gitConfig,'utf8'),'git metadata');
 assert.equal(await readFile(join(repo,'job.txt'),'utf8'),'workspace works');
 assert.equal(await readFile(join(workdir,'scratch','temp.txt'),'utf8'),'scratch works');
 console.log('Runner sandbox isolates project files, Codex credentials, Git metadata, and loopback');
}finally{
 server.close();
 await rm(root,{recursive:true,force:true});
}
