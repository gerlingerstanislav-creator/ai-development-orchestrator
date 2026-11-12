// Browser instructions available to Codex QA inside the strict sandbox.
// Usage: node /opt/codex-runner/browser-client.mjs start
//        node .../browser-client.mjs assert 'document.querySelectorAll(".circle").length === 10'
//        node .../browser-client.mjs viewport 390 844
//        node .../browser-client.mjs screenshot
import {readFile} from 'node:fs/promises';
// Optional --case UUID / --check slug attaches a verified Chromium assertion
// to a single QA scenario. Positional placement is accepted before or after assert.
const input=process.argv.slice(2);
let qaKind='',qaId='';
for(const flag of ['--case','--check']){
 const index=input.indexOf(flag);
 if(index>=0){
  if(qaKind||!input[index+1])throw Error('Invalid QA evidence identity');
  qaKind=flag.slice(2);qaId=input[index+1];
  input.splice(index,2);
 }
}
const [action,...args]=input;
if(qaKind&&action!=='assert')throw Error('Evidence ID requires an assert action');
const session=JSON.parse(await readFile('.ado-browser-session.json','utf8'));
const body={...session,action,...(qaKind?{qaKind,qaId}:{})};
if(action==='goto')body.path=args[0]||'/';
else if(action==='viewport'){body.width=Number(args[0]);body.height=Number(args[1]);}
else if(action==='click'||action==='count'||action==='text')body.selector=args[0];
else if(action==='fill'){body.selector=args[0];body.value=args[1]||'';}
else if(action==='assert')body.expression=args[0];
else if(!['start','screenshot','close'].includes(action))throw Error('Unknown action: '+action);
try{
 const response=await fetch('http://127.0.0.1:4311/action',{method:'POST',
  headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(35000)});
 const result=await response.json();
 process.stdout.write(JSON.stringify(result)+'\n');
 if(!response.ok||result.ok!==true)process.exitCode=1;
}catch(error){process.stderr.write('QA browser unavailable: '+String(error.message||error)+'\n');process.exitCode=1;}
