import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {conversationPolicy,createTaskPolicy,gitEnvironment,runnerEnvironment} from '../../codex-runner/execution-policy.mjs';

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
