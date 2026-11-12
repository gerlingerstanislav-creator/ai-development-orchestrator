import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createCodexDeviceAuth} from './device-auth.mjs';

function child(){
 const proc=new EventEmitter();
 proc.stdout=new EventEmitter();proc.stderr=new EventEmitter();
 proc.killed=false;proc.exitCode=null;
 proc.kill=signal=>{proc.killed=true;proc.signal=signal;return true};
 return proc;
}
function fixture({execute=async()=>({stdout:'Logged in',stderr:''})}={}){
 const commands=[],children=[],proxyStats={attempts:2,successes:1,lastError:''};
 const proxy={
  reset:()=>{proxyStats.attempts=0;proxyStats.successes=0;proxyStats.lastError=''},
  stats:()=>({...proxyStats}),
  probe:async()=> 'Tunnel TLS verified'
 };
 const auth=createCodexDeviceAuth({
  cliEnv:{CODEX_HOME:'/tmp/test-codex'},
  codexProxy:proxy,
  probeAuthEndpoint:async()=> 'Node HTTPS verified',
  execFileAsync:async(...args)=>{commands.push(args);return execute(...args)},
  spawnImpl:(binary,args,opts)=>{
   assert.equal(binary,'codex');
   assert.deepEqual(args,['login','--device-auth']);
   assert.equal(opts.env.CODEX_HOME,'/tmp/test-codex');
   const proc=child();children.push(proc);return proc;
  }
 });
 return {auth,commands,children};
}
test('device auth status uses the configured CLI, without any standalone API key',async()=>{
 const f=fixture();
 assert.deepEqual(await f.auth.connected(),{connected:true,detail:'Logged in'});
 assert.deepEqual(f.commands[0].slice(0,2),['codex',['login','status']]);
 assert.equal(f.commands[0][2].env.CODEX_HOME,'/tmp/test-codex');
 assert.equal(f.auth.activeLogin(),null);
 const unavailable=fixture({execute:async()=>{throw Error('not connected')}});
 assert.equal((await unavailable.auth.connected()).connected,false);
});
test('device login is single-flight and only exposes the actual device authorization link',async()=>{
 const f=fixture();
 f.auth.runLogin();
 f.auth.runLogin();
 assert.equal(f.children.length,1);
 f.children[0].stdout.emit('data',Buffer.from('https://auth.openai.com/api/accounts/deviceauth/usercode CODE-1234'));
 assert.equal(f.auth.deviceInfo().url,null);
 assert.equal(f.auth.deviceInfo().code,null);
 f.children[0].stdout.emit('data',Buffer.from('\nVisit https://auth.openai.com/codex/device with ABCD-123456'));
 const info=f.auth.deviceInfo();
 assert.equal(info.state,'waiting');
 assert.equal(info.url,'https://auth.openai.com/codex/device');
 assert.equal(info.code,'ABCD-123456');
 assert.ok(info.startedAt>0);
 f.children[0].emit('exit',0,null);
 assert.equal(f.auth.deviceInfo().state,'completed');
});
test('logout terminates an active device session and invokes Codex CLI logout',async()=>{
 const f=fixture();
 f.auth.runLogin();
 await f.auth.logout();
 assert.equal(f.children[0].killed,true);
 assert.equal(f.children[0].signal,'SIGTERM');
 assert.equal(f.auth.activeLogin(),null);
 assert.equal(f.auth.deviceInfo().state,'idle');
 assert.deepEqual(f.commands[0].slice(0,2),['codex',['logout']]);
});
test('failed Codex device authorization reports the existing proxy diagnostics',async()=>{
 const f=fixture();
 f.auth.runLogin();
 f.children[0].stderr.emit('data',Buffer.from('auth failed'));
 f.children[0].emit('exit',1,null);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.auth.deviceInfo().state,'error');
 assert.match(f.auth.deviceInfo().diagnosis,/Node HTTPS verified; Tunnel TLS verified/);
 assert.match(f.auth.deviceInfo().instructions,/auth failed/);
});
