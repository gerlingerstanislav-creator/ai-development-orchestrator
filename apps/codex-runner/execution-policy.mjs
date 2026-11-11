import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';

const defaultProfile='ado-task';
const qaProfile='ado-qa';
// These hosts are deliberately fixed in the Runner, never supplied by
// untrusted project instructions or a PM/QA model.
export const qaAllowedDomains=Object.freeze([
 'registry.npmjs.org','pypi.org','files.pythonhosted.org',
 'localhost','127.0.0.1'
]);
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

export async function createTaskPolicy(workDirectory,{writable=true,qa=false}={}){
 const profile=qa?qaProfile:defaultProfile;
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
  ...(qa?[
   // Both controls are required: network.enabled alone would grant unrestricted
   // egress. The proxy enforces this narrow public-registry + loopback allowlist.
   ...setting('features.network_proxy',true),
   ...setting('permissions.'+profile+'.network.enabled',true),
   ...setting('permissions.'+profile+'.network.allow_local_binding',false),
   ...setting('permissions.'+profile+'.network.allow_upstream_proxy',false),
   '-c','permissions.'+profile+'.network.domains='+tomlTable(Object.fromEntries(qaAllowedDomains.map(host=>[host,'allow'])))
  ]:[...setting('permissions.'+profile+'.network.enabled',false)]),
  ...setting('shell_environment_policy.inherit','none'),
  ...setting('shell_environment_policy.set.PATH','/usr/local/bin:/usr/bin:/bin'),
  ...setting('shell_environment_policy.set.HOME',scratch),
  ...setting('shell_environment_policy.set.TMPDIR',scratch),
  ...setting('shell_environment_policy.set.LANG','C.UTF-8'),
  ...(qa?[
   ...setting('shell_environment_policy.set.NODE_PATH','/usr/local/lib/node_modules'),
   ...setting('shell_environment_policy.set.CHROMIUM_BIN','/usr/bin/chromium'),
   ...setting('shell_environment_policy.set.npm_config_registry','https://registry.npmjs.org/'),
   ...setting('shell_environment_policy.set.PIP_INDEX_URL','https://pypi.org/simple'),
   // Loopback test clients must never send local HTTP/WebSocket requests to the
   // outbound dependency proxy. Keep the outbound domain allowlist intact.
   ...setting('shell_environment_policy.set.NO_PROXY','localhost,127.0.0.1,::1'),
   ...setting('shell_environment_policy.set.no_proxy','localhost,127.0.0.1,::1'),
   ...setting('shell_environment_policy.set.XDG_CACHE_HOME',scratch),
   ...setting('shell_environment_policy.set.XDG_CONFIG_HOME',scratch)
  ]:[])
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

export function codexFailureDetail(output,stderr){
 const events=[];
 for(const line of output.split('\n')){
  try{
   const entry=JSON.parse(line);
   const message=entry.type==='turn.failed'?entry.error?.message:entry.type==='error'?entry.message:undefined;
   if(typeof message==='string'&&message.trim())events.push(message.trim());
  }catch{/* Codex may emit ordinary text alongside JSON events. */}
 }
 const diagnostics=stderr.split('\n').filter(line=>!/^reading (additional )?input from stdin/i.test(line.trim())).join('\n').trim();
 return [...new Set(events)].slice(-2).join(' · ').slice(-1200)||diagnostics.slice(-1200);
}
