import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gitEnvironment} from './execution-policy.mjs';
import {discoverProjectCi,classifyProjectCi} from './ci-test-discovery.mjs';

/** Project-owned CI runs in a disposable checkout and a private PostgreSQL
 * cluster when needed. All commands go through the Runner sandbox port.
 * Keeping this job separate from HTTP dispatch prevents duplicate CI policies.
 */
export function createDeterministicCiJobRunner({command,assertJobActive,saveJob,isolatedTaskPolicy,cliEnv}){
 async function runDeterministicCiJob(job,state){
  const workspace=await mkdtemp(join(tmpdir(),'ado-ci-'));
  const dir=join(workspace,'repo');
  const gitEnv=gitEnvironment(job.token);
  const checks=[];
  let postgresStarted=false;
  const postgresData=join(workspace,'ci-postgres');
  const socketDir=join(workspace,'scratch','pgsocket');
  let databaseUrl='';
  const run=async(name,args,timeout=120000)=>{
   assertJobActive(job.id);state.message='CI: '+name;
   const commandResult=await command('codex',[...policy.sandboxArgs,'--',...(databaseUrl?['env','DATABASE_URL='+databaseUrl]:[]),...args],{
    cwd:dir,env:cliEnv,timeout,maxOutputChars:9000,jobId:job.id,allowNonzero:true});
   const result={name,exitCode:commandResult.exitCode,output:(commandResult.stdout+'\n'+commandResult.stderr).slice(-3500)};
   checks.push(result);state.ciChecks=checks;saveJob(job,state);
   return result.exitCode===0;
  };
  let policy;
  try{
   state.message='CI: получение точного SHA';
   await command('git',['clone','--branch',job.branch||job.taskId,'https://github.com/'+job.repository+'.git',dir],
    {cwd:workspace,env:gitEnv,timeout:90000,jobId:job.id});
   const head=(await command('git',['rev-parse','HEAD'],{cwd:dir,jobId:job.id})).stdout.trim();
   if(head!==job.expectedCommit)throw Error('SHA PR изменился до запуска CI');
   state.testedCommit=head;
   if(job.baseCommit){
    await command('git',['fetch','origin',job.baseBranch],{cwd:dir,env:gitEnv,jobId:job.id,timeout:90000});
    const base=(await command('git',['rev-parse','FETCH_HEAD'],{cwd:dir,jobId:job.id})).stdout.trim();
    if(base!==job.baseCommit)throw Error('Целевая ветка PR изменилась: необходимо новое CI');
    // Validate conflict-free integration without changing the checked-out PR.
    const merge=await command('git',['-c','user.name=ADO CI','-c','user.email=ci@users.noreply.github.com','merge','--no-commit','--no-ff','FETCH_HEAD'],{
     cwd:dir,env:gitEnv,jobId:job.id,timeout:60000,allowNonzero:true});
    checks.push({name:'merge compatibility',exitCode:merge.exitCode,output:(merge.stdout+'\n'+merge.stderr).slice(-2500)});
    if(merge.exitCode!==0){state.ciChecks=checks;state.ciVerdict='failed';state.status='completed';state.message='CI: конфликт интеграции веток';return;}
   }
   policy=await isolatedTaskPolicy(workspace,dir,job.id,true,true);
   const files=(await command('git',['ls-files'],{cwd:dir,jobId:job.id,maxOutputChars:400000})).stdout.split(/\r?\n/).filter(Boolean);
   const has=(file)=>files.includes(file);
   const pkg=has('package.json')?JSON.parse(await readFile(join(dir,'package.json'),'utf8')):null;
   // A fresh PostgreSQL cluster is local to THIS CI job, socket-only, and erased on exit.
   // Never point arbitrary project tests at the application's real DATABASE_URL.
   const packages=await Promise.all(files.filter(file=>file==='package.json'||file.endsWith('/package.json')).slice(0,30)
    .map(async file=>readFile(join(dir,file),'utf8').then(JSON.parse).catch(()=>null)));
   const needsPg=packages.some(x=>x&&(x.dependencies?.pg||x.devDependencies?.pg));
   if(needsPg){
    state.message='CI: изолированная PostgreSQL-база';
    await mkdir(socketDir,{recursive:true,mode:0o700});
    await command('/usr/lib/postgresql/15/bin/initdb',['-D',postgresData,'-U','orchestrator','--auth-local=trust','--auth-host=reject','--no-instructions'],
     {cwd:workspace,timeout:120000,jobId:job.id,maxOutputChars:6000});
    await command('/usr/lib/postgresql/15/bin/pg_ctl',['-D',postgresData,'-l',join(workspace,'ci-postgres.log'),
     '-o',"-c listen_addresses='' -c shared_buffers=16MB -c max_connections=20 -c fsync=off -k "+socketDir+" -p 5432",'start','-w'],
     {cwd:workspace,timeout:90000,jobId:job.id,maxOutputChars:6000});
    postgresStarted=true;
    await command('/usr/bin/createdb',['-h',socketDir,'-U','orchestrator','orchestrator'],
     {cwd:workspace,timeout:20000,jobId:job.id});
    databaseUrl='postgres://orchestrator@localhost:5432/orchestrator?host='+encodeURIComponent(socketDir);
   }
   let executed=0;
   if(pkg){
    if(!await run('npm dependencies',['npm','install','--no-audit','--no-fund'],480000)){
     state.ciChecks=checks;state.ciVerdict='failed';state.status='completed';state.message='CI: установка зависимостей не выполнена';return;
    }
    for(const name of ['check','build','test']){
     if(pkg.scripts?.[name]){executed++;await run('npm '+name,['npm','run',name],360000);}
    }
    const nodeTests=files.filter(x=>/\.test\.(mjs|js)$/.test(x)).slice(0,200);
    if(nodeTests.length&&!pkg.scripts?.test){executed++;await run('node unit tests',['node','--test',...nodeTests],360000);}
    const syntax=files.filter(x=>/^apps\/(codex-runner|qa-browser)\/.*\.mjs$/.test(x)).slice(0,80);
    for(const filename of syntax){executed++;await run('syntax '+filename,['node','--check',filename],30000);}
   }
   // pytest does not need a pytest.ini or pyproject.toml: tests/test_*.py
   // is a complete, discoverable suite. Explicit Makefile targets are also
   // valid. Prefer the project-owned make target when both exist.
   const makefileName=files.find(file=>['Makefile','GNUmakefile','makefile'].includes(file));
   const makefile=makefileName?await readFile(join(dir,makefileName),'utf8').catch(()=> ''):'';
   const discovery=discoverProjectCi(files,makefile);
   // Prefer the existing pytest suite when both pytest and Makefile exist:
   // it needs no extra tools and avoids a false CI rejection due to a missing
   // make binary in minimal Runner images.
   if(discovery.pytest){executed++;await run('python tests',['python3','-m','pytest','-q'],360000);}
   else if(discovery.makeTest){executed++;await run('make test',['make','test'],360000);}
   if(!executed){
    // Absence of a test runner is a capability/configuration gap, NOT an
    // application defect. Never send the same PR back to the developer
    // repeatedly for this reason.
    checks.push({name:'supported tests',exitCode:null,
     output:'CI_UNSUPPORTED_TESTS: не обнаружены исполняемые проверки проекта. Добавь тестовый скрипт, Makefile target test или pytest suite (tests/test_*.py). До этого CI заблокирован, но реализация не признана дефектной.'});
   }
   state.ciChecks=checks;state.ciVerdict=classifyProjectCi(checks,executed);
   state.status='completed';state.message=state.ciVerdict==='passed'?'Собственный CI: все проверки пройдены':
    state.ciVerdict==='blocked'?'Собственный CI: требуются исполняемые проверки проекта':'Собственный CI: обнаружены ошибки';
  }finally{
   if(postgresStarted)await command('/usr/lib/postgresql/15/bin/pg_ctl',['-D',postgresData,'stop','-m','immediate','-w'],{
    cwd:workspace,timeout:20000,allowNonzero:true
   }).catch(()=>{});
   await rm(workspace,{recursive:true,force:true}).catch(()=>{});
  }
 }
 return runDeterministicCiJob;
}
