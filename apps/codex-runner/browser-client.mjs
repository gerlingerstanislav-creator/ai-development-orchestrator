// Browser instructions available to Codex QA inside the strict sandbox.
// Usage: node /opt/codex-runner/browser-client.mjs start
//        node .../browser-client.mjs assert 'document.querySelectorAll(".circle").length === 10'
//        node .../browser-client.mjs viewport 390 844
//        node .../browser-client.mjs screenshot
import {readFile} from 'node:fs/promises';
const [action,...args]=process.argv.slice(2);
const session=JSON.parse(await readFile('.ado-browser-session.json','utf8'));
const body={...session,action};
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
