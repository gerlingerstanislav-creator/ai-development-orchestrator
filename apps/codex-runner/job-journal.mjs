import {closeSync,fsyncSync,mkdirSync,openSync,readFileSync,readdirSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

const jobIdPattern=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export function openJobJournal(directory){
 mkdirSync(directory,{recursive:true,mode:0o700});
 function save(record,secret){
  if(!jobIdPattern.test(record.state.id))throw Error('Некорректный идентификатор задания');
  const path=join(directory,record.state.id+'.json');
  const pending=path+'.tmp';
  const file=openSync(pending,'w',0o600);
  try{
   // Persist only the execution identity and status. Job payloads include GitHub credentials.
   writeFileSync(file,JSON.stringify(record,(_key,value)=>secret&&typeof value==='string'?value.replaceAll(secret,'[REDACTED]').replaceAll(Buffer.from('x-access-token:'+secret).toString('base64'),'[REDACTED]'):value));
   fsyncSync(file);
  }finally{closeSync(file);}
  renameSync(pending,path);
  const folder=openSync(directory,'r');
  try{fsyncSync(folder);}finally{closeSync(folder);}
 }
 function read(id){
  if(!jobIdPattern.test(id))return undefined;
  try{return JSON.parse(readFileSync(join(directory,id+'.json'),'utf8'));}
  catch(error){if(error.code==='ENOENT')return undefined;throw error;}
 }
 function recover(){
  for(const file of readdirSync(directory)){
   if(!file.endsWith('.json'))continue;
   const record=read(file.slice(0,-5));
   if(record&&['running','queued'].includes(record.state.status)){
    record.state.status='interrupted';
    record.state.message='Исполнитель перезапущен. Ожидает восстановления задания.';
    save(record);
   }
  }
 }
 return {read,save,recover};
}

export function jobIdentity(job){
 return {repository:job.repository,taskId:job.taskId,projectId:job.projectId??null,kind:job.kind??'development',baseBranch:job.baseBranch};
}

export function recoveryAction(checkpoint,remoteHead){
 if(!checkpoint)return 'run';
 if(remoteHead===checkpoint.commit)return 'published';
 if(remoteHead===checkpoint.previous)return 'run';
 return 'changed';
}

export function runtimeLimitResult(state,phase,seconds){
 const retry=(state.runtimeLimitRetries||0)<1&&(state.restarts||0)<2;
 return {
  status:retry?'interrupted':'failed',
  runtimeLimitRetries:(state.runtimeLimitRetries||0)+1,
  message:'Превышено время выполнения ('+seconds+' сек.). Последний шаг: '+phase+
   (retry?' · будет одна попытка восстановления':' · попытка восстановления исчерпана')
 };
}
