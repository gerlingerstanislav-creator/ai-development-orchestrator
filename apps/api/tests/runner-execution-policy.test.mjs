import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {codexFailureDetail,conversationPolicy,createTaskPolicy,gitEnvironment,runnerEnvironment,qaAllowedDomains} from '../../codex-runner/execution-policy.mjs';

test('the subprocess environment is explicit and Git credentials stay with Runner Git commands',()=>{
 const base=runnerEnvironment({PATH:'/usr/bin',LANG:'C',RUNNER_SHARED_SECRET:'runner',JWT_SECRET:'jwt',CODEX_HOME:'/auth',GITHUB_TOKEN:'github'});
 assert.deepEqual(base,{PATH:'/usr/bin',LANG:'C'});
 const withoutToken=gitEnvironment(),authenticated=gitEnvironment('test-token');
 assert.equal(withoutToken.GIT_CONFIG_COUNT,'2');
 assert.equal(authenticated.GIT_CONFIG_COUNT,'3');
 assert.equal(authenticated.GIT_CONFIG_KEY_0,'core.hooksPath');
 assert.equal(authenticated.GIT_CONFIG_VALUE_0,'/dev/null');
 assert.match(authenticated.GIT_CONFIG_KEY_2,/github\.com/);
 assert.equal(withoutToken.GIT_CONFIG_VALUE_2,undefined);
});

test('each task gets its own restricted workspace and scratch directory',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ado-policy-test-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const first=await createTaskPolicy(join(root,'first'));
 const second=await createTaskPolicy(join(root,'second'));
 assert.ok(first.execArgs.includes('permissions.ado-task.network.enabled=false'));
 assert.ok(first.execArgs.includes('shell_environment_policy.inherit="none"'));
 assert.ok(first.execArgs.includes('approval_policy="never"'));
 assert.match(first.execArgs.join('\n'),/"\.git"="read"/);
 assert.ok(first.execArgs.some(arg=>arg.includes(join(root,'first','scratch'))));
 assert.ok(!first.execArgs.some(arg=>arg.includes(join(root,'second','scratch'))));
 assert.notDeepEqual(first.execArgs,second.execArgs);
 assert.ok(conversationPolicy.includes('features.shell_tool=false'));
 assert.ok(conversationPolicy.includes('features.unified_exec=false'));
});

test('Codex diagnostics prefer structured failures over the stdin notice',()=>{
 const events=JSON.stringify({type:'turn.failed',error:{message:'Invalid schema for the QA report'}});
 assert.equal(codexFailureDetail(events,'Reading additional input from stdin...'),'Invalid schema for the QA report');
 assert.equal(codexFailureDetail('', 'Reading additional input from stdin...\nSandbox failed'),'Sandbox failed');
});

test('QA alone receives a proxy-enforced registry/loopback allowlist',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ado-qa-policy-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const qa=await createTaskPolicy(join(root,'qa'),{qa:true});
 const dev=await createTaskPolicy(join(root,'dev'));
 const options=qa.execArgs.join('\n');
 assert.match(options,/default_permissions="ado-qa"/);
 assert.match(options,/features\.network_proxy=true/);
 assert.match(options,/permissions\.ado-qa\.network\.enabled=true/);
 assert.match(options,/permissions\.ado-qa\.network\.allow_local_binding=false/);
 assert.match(options,/permissions\.ado-qa\.network\.allow_upstream_proxy=false/);
 for(const domain of qaAllowedDomains)assert.ok(options.includes('"'+domain+'"="allow"'),domain+' is missing');
 for(const disallowed of ['api','db','*','example.com','auth.openai.com'])
  assert.ok(!qaAllowedDomains.includes(disallowed),'unexpected QA permission '+disallowed);
 assert.match(options,/PIP_INDEX_URL/);
 assert.match(options,/npm_config_registry/);
 assert.match(dev.execArgs.join('\n'),/permissions\.ado-task\.network\.enabled=false/);
 assert.ok(!dev.execArgs.some(arg=>arg.includes('network_proxy=true')));
 assert.ok(!qa.execArgs.some(arg=>arg.includes('RUNNER_SHARED_SECRET')));
 assert.ok(!qa.execArgs.some(arg=>arg.includes('GITHUB_TOKEN')));
});
