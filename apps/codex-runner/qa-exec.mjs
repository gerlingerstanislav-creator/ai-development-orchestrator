// Runs a QA assertion inside the existing Codex sandbox and emits a
// machine-readable per-case receipt. The Runner validates that Codex actually
// invoked this helper; the agent's report text never makes a test "passed".
//
// node /opt/codex-runner/qa-exec.mjs case UUID -- node --test ...
// node /opt/codex-runner/qa-exec.mjs check smoke -- sh -c 'test ...'
import {spawn} from 'node:child_process';
import {appendFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

const [kind,id,separator,...argv]=process.argv.slice(2);
if(!['case','check'].includes(kind)||typeof id!=='string'||id.length>100
 ||!/^[a-zA-Z0-9_.-]+$/.test(id)||separator!=='--'||!argv.length){
 process.stderr.write('Usage: qa-exec.mjs case|check ID -- executable [args...]\n');
 process.exit(2);
}
let stdout='',stderr='';
const child=spawn(argv[0],argv.slice(1),{cwd:process.cwd(),env:process.env,shell:false,stdio:['ignore','pipe','pipe']});
const collect=(previous,chunk)=>{const text=previous+chunk.toString();return text.slice(-1800);};
child.stdout.on('data',chunk=>{stdout=collect(stdout,chunk);process.stdout.write(chunk);});
child.stderr.on('data',chunk=>{stderr=collect(stderr,chunk);process.stderr.write(chunk);});
let result=1;
try{
 result=await new Promise((resolve,reject)=>{
  child.once('error',reject);
  child.once('close',(code,signal)=>resolve(signal?128:code??1));
 });
}catch(error){
 stderr=String(error.message||error).slice(0,1600);
 process.stderr.write(stderr+'\n');
}
const receipt={kind,id,executionId:randomUUID(),exitCode:result,
 command:argv,stdout:stdout.slice(-1500),stderr:stderr.slice(-1500)};
await appendFile('.ado-qa-executions.jsonl',JSON.stringify(receipt)+'\n',{mode:0o600});
process.stdout.write('\nADO_QA_RECEIPT '+JSON.stringify({kind,id,executionId:receipt.executionId,exitCode:result})+'\n');
process.exitCode=result;
