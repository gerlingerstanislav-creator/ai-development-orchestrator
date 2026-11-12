import {spawn} from 'node:child_process';
import {setTimeout as wait} from 'node:timers/promises';

// Runs INSIDE the image, unlike node --check on the host: import resolution and
// actual HTTP readiness must both succeed before this smoke test passes.
const child=spawn(process.execPath,['/opt/codex-runner/server.mjs'],{stdio:['ignore','ignore','pipe']});
let errorOutput='';
child.stderr.on('data',chunk=>{errorOutput=(errorOutput+chunk.toString()).slice(-2500);});
let exited=false;
child.once('exit',()=>{exited=true;});
let ok=false;
try{
 for(let attempt=0;attempt<30;attempt++){
  if(exited)break;
  try{
   const response=await fetch('http://127.0.0.1:4300/device',{
    headers:{'X-Runner-Secret':process.env.RUNNER_SHARED_SECRET||''},
    signal:AbortSignal.timeout(800)
   });
   if(response.ok){
    const data=await response.json();
    if(data&&'login' in data){ok=true;break;}
   }
  }catch{/* Server may still be starting. */}
  await wait(250);
 }
 if(!ok)throw new Error('Codex Runner did not become ready: '+errorOutput);
 process.stdout.write('Codex Runner module imports and HTTP startup: OK\n');
}finally{
 child.kill('SIGTERM');
 await Promise.race([new Promise(resolve=>child.once('exit',resolve)),wait(1000)]);
 if(!exited)child.kill('SIGKILL');
}
