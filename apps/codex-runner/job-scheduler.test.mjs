import test from 'node:test';
import assert from 'node:assert/strict';
import {jobRole,nextRunnableJobIndex,projectKey} from './job-scheduler.mjs';

const job=(projectId,role,number,capacity=2)=>({
 projectId,taskId:projectId+'-task-'+number,repository:projectId+'/repo',
 kind:role==='testing'?'test':role==='architect'?'review':role==='devops'?'ci':undefined,
 roleCapacity:capacity
});
const select=(queue,projects={},roles={},branches=[])=>nextRunnableJobIndex(
 queue.map(job=>({job})),{
  activeBranches:new Set(branches),activeByRole:new Map(Object.entries(roles)),
  activeByProject:new Map(Object.entries(projects))
 }
);

test('different projects keep independent developer and QA capacities',()=>{
 const aDev=job('project-a','development',1,1);
 const aQa=job('project-a','testing',2,1);
 const bDev=job('project-b','development',3,1);
 const bQa=job('project-b','testing',4,1);
 assert.equal(jobRole(aQa),'testing');
 assert.equal(projectKey(bDev),'project-b');
 assert.equal(select([aDev,aQa,bDev,bQa],{ 'project-a':1 },{
  'project-a:development':1
 }),2,'an occupied developer role in A does not block the developer in B');
 assert.equal(select([aQa,bQa],{'project-a':1},{
  'project-a:testing':1
 }),1,'an occupied QA role in A does not block QA in B');
 assert.equal(select([aDev,aQa,bDev],{'project-a':1},{
  'project-a:development':1,'project-b:development':1
 }),1,'Developer and QA do not consume one another\'s role quota');
});

test('the least active project receives the next free shared runner slot',()=>{
 const a1=job('project-a','development',1,10);
 const a2=job('project-a','testing',2,10);
 const b1=job('project-b','development',1,10);
 assert.equal(select([a1,a2,b1],{'project-a':12,'project-b':0}),2,
  'a full project cannot monopolize new runner slots');
 assert.equal(select([a1,b1],{'project-a':5,'project-b':5}),0,
  'FIFO order is preserved between projects with equal active counts');
 assert.equal(select([a1,b1],{}, {},[a1.repository+':'+a1.taskId]),1,
  'a branch/task lock does not block another project');
 assert.equal(select([a1],{}, {},[a1.repository+':'+a1.taskId]),-1);
});
