import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {taskBranchName,ensureTaskBranchHistory} from './task-branch-history.mjs';

function git(cwd,...args){
 return execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
}
test('development reuses exactly one task branch and restores missing merge-base before comparison',async t=>{
 const root=mkdtempSync(join(tmpdir(),'ado-git-branch-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const remote=join(root,'remote.git'),seed=join(root,'seed'),work=join(root,'work');
 mkdirSync(seed);
 git(root,'init','--bare','-b','main',remote);
 git(root,'init','-b','main',seed);
 git(seed,'config','user.name','QA Branch Tests');
 git(seed,'config','user.email','qa@example.test');
 git(seed,'remote','add','origin',remote);
 writeFileSync(join(seed,'README.md'),'First commit\n');
 git(seed,'add','README.md');git(seed,'commit','-m','initial');
 git(seed,'push','-u','origin','main');
 const taskId='11111111-1111-4111-8111-111111111111';
 git(seed,'checkout','-b',taskBranchName(taskId));
 writeFileSync(join(seed,'feature.html'),'Eight colorful lines\n');
 git(seed,'add','feature.html');git(seed,'commit','-m','feature in task branch');
 const commit=git(seed,'rev-parse','HEAD');
 git(seed,'push','-u','origin',taskId);
 git(seed,'checkout','main');
 writeFileSync(join(seed,'unrelated.txt'),'Main advanced independently\n');
 git(seed,'add','unrelated.txt');git(seed,'commit','-m','main advanced');
 git(seed,'push','origin','main');

 // GitHub's real Runner clones main at depth one then fetches the task branch
 // at depth one. That normally produces two grafted roots: no merge-base.
 execFileSync('git',['clone','--depth','1','--branch','main','file://'+remote,work],{stdio:'pipe'});
 git(work,'fetch','--depth','1','origin','refs/heads/'+taskId+':refs/remotes/origin/'+taskId);
 git(work,'checkout','-b',taskId,'refs/remotes/origin/'+taskId);
 assert.equal(git(work,'rev-parse','HEAD'),commit);
 assert.throws(()=>git(work,'merge-base','refs/remotes/origin/main','HEAD'));
 const callback=async(...args)=>({stdout:git(work,...args)+'\n'});
 const result=await ensureTaskBranchHistory(callback,{baseBranch:'main',taskBranch:taskId});
 assert.equal(result.rehydrated,true);
 assert.match(result.mergeBase,/^[a-f0-9]{40}$/);
 assert.equal(git(work,'branch','--show-current'),taskId);
 assert.equal(git(work,'rev-parse','HEAD'),commit,'never change existing task work');
 assert.deepEqual(git(work,'diff','--name-only','refs/remotes/origin/main...HEAD').split('\n'),['feature.html']);
 const again=await ensureTaskBranchHistory(callback,{baseBranch:'main',taskBranch:taskId});
 assert.equal(again.rehydrated,false,'later developer attempts reuse hydrated ancestry');
 assert.equal(again.mergeBase,result.mergeBase);
});
test('branch identity cannot depend on developer attempt',()=>{
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 assert.equal(taskBranchName(id),taskBranchName(id));
 assert.throws(()=>taskBranchName('new-run-42'),/Некорректный/);
});
