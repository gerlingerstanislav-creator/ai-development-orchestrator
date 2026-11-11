import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {jobIdentity,openJobJournal,recoveryAction,runtimeLimitResult} from '../../codex-runner/job-journal.mjs';

test('Runner recovers only nonterminal jobs and matches the pushed commit before repeating work',t=>{
 const directory=mkdtempSync(join(tmpdir(),'ado-journal-test-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const journal=openJobJournal(directory);
 const secret='credential-test-never-write';
 const identity=jobIdentity({repository:'example/repo',taskId:randomUUID(),baseBranch:'main',token:secret});
 const checkpoint={previous:'a'.repeat(40),commit:'b'.repeat(40)};
 const running={id:randomUUID(),status:'running',checkpoint,message:'redact '+secret};
 const queued={id:randomUUID(),status:'queued'};
 const done={id:randomUUID(),status:'completed',verdict:'passed',testedCommit:checkpoint.commit};
 const cancelled={id:randomUUID(),status:'cancelled'};
 for(const state of [running,queued,done,cancelled])journal.save({identity,state},secret);
 assert.ok(!readFileSync(join(directory,running.id+'.json'),'utf8').includes(secret));
 const restarted=openJobJournal(directory);
 restarted.recover();
 assert.equal(restarted.read(running.id).state.status,'interrupted');
 assert.equal(restarted.read(queued.id).state.status,'interrupted');
 assert.deepEqual(restarted.read(done.id).state,done);
 assert.deepEqual(restarted.read(cancelled.id).state,cancelled);
 const saved=restarted.read(running.id).state.checkpoint;
 assert.equal(recoveryAction(saved,checkpoint.commit),'published');
 assert.equal(recoveryAction(saved,checkpoint.previous),'run');
 assert.equal(recoveryAction(saved,'c'.repeat(40)),'changed');
});

test('a time limit allows one recovery with the original checkpoint and then fails',t=>{
 const directory=mkdtempSync(join(tmpdir(),'ado-journal-timeout-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const journal=openJobJournal(directory);
 const identity=jobIdentity({repository:'example/repo',taskId:randomUUID(),baseBranch:'main'});
 const state={id:randomUUID(),status:'running',checkpoint:{previous:'a'.repeat(40),commit:'b'.repeat(40)}};
 Object.assign(state,runtimeLimitResult(state,'Создание Pull Request',900));
 journal.save({identity,state});
 assert.equal(state.status,'interrupted');
 assert.match(state.message,/900.*Создание Pull Request.*одна попытка/);
 const restored=journal.read(state.id).state;
 assert.equal(recoveryAction(restored.checkpoint,state.checkpoint.commit),'published');
 Object.assign(restored,runtimeLimitResult(restored,'Проверка',900));
 assert.equal(restored.status,'failed');
 assert.match(restored.message,/попытка восстановления исчерпана/);
});
