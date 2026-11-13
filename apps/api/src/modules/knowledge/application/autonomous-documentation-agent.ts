import {advanceDocumentationAgent,type DocumentationAgentEvent,type DocumentationAgentState} from '../../../autonomous-documentation-execution.js';

export type AutonomousDocumentationPorts={
 projectId:string;processId:string;message:string;
 agentInstructions:()=>Promise<string>;
 createSession:()=>Promise<{id:string;secret:string}|null>;
 finishSession:(sessionId:string)=>Promise<void>;
 readState:()=>Promise<DocumentationAgentState>;
 readEvents:()=>Promise<DocumentationAgentEvent[]>;
 readLiveInstructions:()=>Promise<Array<{body:string}>>;
 assertRunning:()=>Promise<void>;
 recordPrompt:(prompt:string)=>Promise<void>;
 onWorkStart:(step:number)=>Promise<void>;
 performRound:(prompt:string,sessionSecret:string)=>Promise<string>;
 onProgress:(stage:string,detail:string)=>Promise<void>;
};

/** Autonomous analyst owns task strategy and MCP tool choice. This service
 * keeps durable execution anchored to confirmed MCP effects and session state,
 * with bounded prompts and fresh owner instructions on every round. */
export async function runAutonomousDocumentationAgent(ports:AutonomousDocumentationPorts):Promise<void>{
 const agent=await ports.createSession();
 if(!agent)throw Error('Не удалось выдать аналитику доступ к собственному поручению');
 try{
  const instructions=await ports.agentInstructions();
  const identity=[
   'Ты автономный аналитик проекта. Цель: '+ports.message.slice(0,5000),
   'Используй каталог MCP orchestrator, выбирая необходимые инструменты и документы самостоятельно.',
   'Исследуй доступные факты (project.context, project.source, documents.*), сохраняй результаты по мере исследования. Выбирай структуру самостоятельно: единое ТЗ на системной странице или тематические дочерние документы, исходя из объёма и удобства сопровождения.',
   'Для изменения структуры используй documents.list/read/create/update/changeset. Переноси страницы через documents.update(parent_id); безопасно удаляй пустые лишние страницы через documents.delete с revision. Системные корни не удаляй. Не оставляй бессодержательные дубли и не теряй подтверждённые сведения.',
   'Для большого проекта разделяй работу на короткие действия с MCP. Не откладывай запись всех документов до конца длительного анализа.',
   'После прерывания Codex опирайся на сохранённую историю MCP; не повторяй уже выполненные изменения. Для повторяемых записей используй idempotency_key.',
   'Когда цель достигнута, вызови documentation.complete с ID реально проверенных страниц и итогом. Если подтверждённых сведений недостаточно, вызови documentation.request_input с конкретным вопросом ПМ. Не объявляй успех без documentation.complete.',
   'Не выдумывай содержание источников, не создавай фиктивный документ ради прохождения проверки, не подменяй исследование пересказом задания.',
   'Дополнительные инструкции команды: '+instructions.slice(0,2600)
  ].join('\n\n');
  await advanceDocumentationAgent({
   readState:ports.readState,
   readEvents:ports.readEvents,
   runRound:async(step,history)=>{
    await ports.assertRunning();
    const latest=await ports.readLiveInstructions();
    const extra=latest.length?'\nУточнения владельца:\n'+latest.slice(-10).map(x=>x.body).join('\n').slice(-3500):'';
    const prompt=(identity+extra+(history?'\n\nСохранённая история действий, продолжай без повторной записи:\n'+history:'')).slice(0,22500);
    await ports.recordPrompt(prompt);
    await ports.onWorkStart(step);
    return ports.performRound(prompt,agent.secret);
   },
   onProgress:ports.onProgress
  });
 }finally{await ports.finishSession(agent.id).catch(()=>{});}
}
