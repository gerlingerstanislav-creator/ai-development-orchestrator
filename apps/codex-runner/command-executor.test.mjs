import test from 'node:test';
import assert from 'node:assert/strict';
import {createCommandExecutor} from './command-executor.mjs';

const executor=({assertJobActive=()=>{},jobChildren=new Map(),stopCommand=child=>child.kill('SIGKILL')}={})=>
 createCommandExecutor({baseEnv:{RUNNER_TEST_BASE:'base'},assertJobActive,jobChildren,stopCommand,codexFailureDetail:(_stdout,stderr)=>stderr});

test('command executor captures stdout/stderr, injected environment and exit code',async()=>{
 const cmd=executor();
 const result=await cmd(process.execPath,['-e',`process.stdout.write(process.env.RUNNER_TEST_BASE);process.stderr.write('diagnostic')`]);
 assert.equal(result.stdout,'base');
 assert.equal(result.stderr,'diagnostic');
 assert.equal(result.exitCode,0);
});

test('nonzero status is rejected unless explicitly allowed',async()=>{
 const cmd=executor();
 await assert.rejects(
  cmd(process.execPath,['-e',`process.stderr.write('failed');process.exit(7)`]),
  /завершился с кодом 7/
 );
 const result=await cmd(process.execPath,['-e','process.exit(7)'],{allowNonzero:true});
 assert.equal(result.exitCode,7);
});

test('job-specific secret is redacted and child references are released',async()=>{
 const children=new Map();
 const cmd=executor({jobChildren:children});
 const token='sensitive-unique-session-token';
 const result=await cmd(process.execPath,['-e',`process.stdout.write(process.env.ADO_AGENT_SESSION_TOKEN);process.stderr.write(process.env.ADO_AGENT_SESSION_TOKEN)`],
  {env:{ADO_AGENT_SESSION_TOKEN:token},jobId:'job-a'});
 assert.equal(result.stdout,'[REDACTED]');
 assert.equal(result.stderr,'[REDACTED]');
 assert.equal(children.has('job-a'),false);
});

test('cancellation is checked before process launch',async()=>{
 const cmd=executor({assertJobActive:()=>{throw new Error('cancelled')}});
 await assert.rejects(cmd(process.execPath,['-e','process.exit(0)'],{jobId:'stopped'}),/cancelled/);
});
