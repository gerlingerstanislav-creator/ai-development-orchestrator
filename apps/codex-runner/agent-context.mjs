const server='mcp_servers.orchestrator';
const tokenPattern=/^[0-9a-f]{64}$/;

export const readerPrompt=[
 'Документация проекта доступна через инструменты orchestrator.',
 'Когда для текущего задания не хватает контекста, найди документ через knowledge.search, выбери заголовок через knowledge.sections и прочитай нужный раздел через knowledge.section.',
 'Если нужно обсуждать черновики, используй documents.search и documents.read. Статус страницы показывает, утверждена ли она.',
 'Перед выполнением работы по назначенной задаче обязательно сначала прочитай её актуальное состояние через tasks.read. Затем самостоятельно решай, нужны ли processes.list, дополнительные документы, результаты других агентов или требования. Не заменяй актуальное состояние старым описанием из промпта.'
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
   if(scope.taskId){
    // Verify the task really is readable before starting Codex; do not dump
    // the task response into the prompt or let stale context mask API failure.
    const check=await fetch(base+'/call',{method:'POST',headers:{'X-Agent-Token':secret,'Content-Type':'application/json'},
     body:JSON.stringify({name:'tasks.read',arguments:{task_id:scope.taskId}}),signal:AbortSignal.timeout(10000)});
    if(!check.ok)throw Error('tasks.read HTTP '+check.status);
    const payload=await check.json();
    if(payload?.result?.task?.id!==scope.taskId)throw Error('tasks.read returned no matching task');
    context.prefix='Назначенная задача: '+scope.taskId+'. СНАЧАЛА вызови orchestrator.tasks.read с task_id='+scope.taskId+
     ', чтобы самостоятельно получить актуальное состояние, существующий PR, вопросы и последние замечания. '+context.prefix;
   }
  }catch(error){
   const reason=error instanceof Error?error.message:'неизвестная ошибка';
   process.stderr.write('Контекст проекта недоступен исполнителю: '+reason+'\n');
   if(scope.taskId){
    // A read-only session may have been created before the preflight failed.
    if(context.env.ADO_AGENT_SESSION_TOKEN)
     await fetch(url,{method:'DELETE',headers:{...headers,'X-Agent-Token':context.env.ADO_AGENT_SESSION_TOKEN},
      signal:AbortSignal.timeout(2000)}).catch(()=>{});
    throw new Error('Нельзя безопасно выполнять задачу без её актуального состояния через MCP: '+reason);
   }
   context.prefix='Хранилище документации сейчас недоступно. Используй приложенный контекст и сообщи, если нужные сведения не удалось подтвердить.\n\n';
  }
 }
 try{return await run(context);}
 finally{
  if(context.env.ADO_AGENT_SESSION_TOKEN)
   await fetch(url,{method:'DELETE',headers:{...headers,'X-Agent-Token':context.env.ADO_AGENT_SESSION_TOKEN},signal:AbortSignal.timeout(2000)}).catch(()=>{});
 }
}
