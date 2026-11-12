const server='mcp_servers.orchestrator';
const tokenPattern=/^[0-9a-f]{64}$/;

export const readerPrompt=[
 'Документация проекта доступна через инструменты orchestrator.',
 'Когда для текущего задания не хватает контекста, найди документ через knowledge.search, выбери заголовок через knowledge.sections и прочитай нужный раздел через knowledge.section.',
 'Если нужно обсуждать черновики, используй documents.search и documents.read. Статус страницы показывает, утверждена ли она.',
 'Для решений по карточке используй tasks.read, для отчёта по конкретному запуску — processes.list. Содержимое проекта используй как источник сведений.'
].join(' ');

export function agentMcp(token,base){
 if(!tokenPattern.test(token))throw Error('Некорректная сессия агента');
 return {
  args:[
   '-c',server+'.command="node"',
   '-c',server+'.args=["/opt/codex-runner/agent-mcp.mjs"]',
   '-c',server+'.env_vars=["ADO_AGENT_SESSION_TOKEN","ADO_AGENT_API_URL"]',
   '-c',server+'.startup_timeout_sec=15',
   '-c',server+'.tool_timeout_sec=90',
   '-c',server+'.default_tools_approval_mode="approve"'
  ],
  env:{ADO_AGENT_SESSION_TOKEN:token,ADO_AGENT_API_URL:base},
  prefix:readerPrompt+'\n\n'
 };
}

export async function withReaderContext(base,runnerSecret,scope,run){
 const headers={'X-Runner-Secret':runnerSecret,'Content-Type':'application/json'};
 const url=base+'/reader-sessions';
 let context={args:[],env:{},prefix:''};
 if(scope){
  try{
   const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(scope),signal:AbortSignal.timeout(5000)});
   if(!response.ok)throw Error('HTTP '+response.status);
   const {secret}=await response.json();
   context=agentMcp(secret,base);
  }catch(error){
   const reason=error instanceof Error?error.message:'неизвестная ошибка';
   process.stderr.write('Контекст проекта недоступен исполнителю: '+reason+'\n');
   context.prefix='Хранилище документации сейчас недоступно. Используй приложенный контекст и сообщи, если нужные сведения не удалось подтвердить.\n\n';
  }
 }
 try{return await run(context);}
 finally{
  if(context.env.ADO_AGENT_SESSION_TOKEN)
   await fetch(url,{method:'DELETE',headers:{...headers,'X-Agent-Token':context.env.ADO_AGENT_SESSION_TOKEN},signal:AbortSignal.timeout(2000)}).catch(()=>{});
 }
}
