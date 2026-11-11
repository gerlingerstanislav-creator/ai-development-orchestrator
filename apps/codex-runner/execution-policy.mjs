import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';

const profile='ado-task';
const setting=(key,value)=>['-c',key+'='+JSON.stringify(value)];
const tomlTable=entries=>'{'+Object.entries(entries).map(([key,value])=>JSON.stringify(key)+'='+
 (typeof value==='string'?JSON.stringify(value):tomlTable(value))).join(',')+'}';

export function runnerEnvironment(environment=process.env){
 const {PATH='/usr/local/bin:/usr/bin:/bin',LANG='C.UTF-8'}=environment;
 return {PATH,LANG};
}

export function gitEnvironment(token){
 return {
  GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
  GIT_CONFIG_COUNT:token?'3':'2',
  GIT_CONFIG_KEY_0:'core.hooksPath',GIT_CONFIG_VALUE_0:'/dev/null',
  GIT_CONFIG_KEY_1:'core.fsmonitor',GIT_CONFIG_VALUE_1:'false',
  ...(token?{GIT_CONFIG_KEY_2:'http.https://github.com/.extraheader',
   GIT_CONFIG_VALUE_2:'AUTHORIZATION: basic '+Buffer.from('x-access-token:'+token).toString('base64')}:{}),
 };
}

export async function createTaskPolicy(workDirectory,{writable=true}={}){
 const scratch=join(workDirectory,'scratch');
 await mkdir(scratch,{recursive:true,mode:0o700});
 const args=[
  ...setting('default_permissions',profile),
  ...setting('approval_policy','never'),
  ...setting('cli_auth_credentials_store','file'),
  ...setting('allow_login_shell',false),
  '-c','projects='+tomlTable({[join(workDirectory,'repo')]:{trust_level:'untrusted'}}),
  ...setting('features.hooks',false),
  ...setting('features.apps',false),
  ...setting('features.plugins',false),
  ...setting('features.shell_snapshot',false),
  ...setting('web_search','disabled'),
  '-c','permissions.'+profile+'.filesystem='+tomlTable({
   ':minimal':'read','/usr/local/bin':'read','/usr/local/lib/node_modules':'read',[scratch]:'write',
   ':workspace_roots':{'.':writable?'write':'read','.git':'read','.codex':'read','.agents':'read'},
  }),
  ...setting('permissions.'+profile+'.network.enabled',false),
  ...setting('shell_environment_policy.inherit','none'),
  ...setting('shell_environment_policy.set.PATH','/usr/local/bin:/usr/bin:/bin'),
  ...setting('shell_environment_policy.set.HOME',scratch),
  ...setting('shell_environment_policy.set.TMPDIR',scratch),
  ...setting('shell_environment_policy.set.LANG','C.UTF-8')
 ];
 return {
  execArgs:['--strict-config','--ignore-user-config','--ignore-rules',...args],
  sandboxArgs:['sandbox','--permission-profile',profile,...args],
 };
}

// Conversation agents use only the application MCP tools registered by Runner.
export const conversationPolicy=[
 '--strict-config','--ignore-user-config','--ignore-rules','--sandbox','read-only',
 ...setting('approval_policy','never'),
 ...setting('cli_auth_credentials_store','file'),
 ...setting('features.shell_tool',false),
 ...setting('features.unified_exec',false),
 ...setting('features.hooks',false),
 ...setting('features.apps',false),
 ...setting('features.plugins',false),
 ...setting('web_search','disabled'),
 ...setting('shell_environment_policy.inherit','none')
];
