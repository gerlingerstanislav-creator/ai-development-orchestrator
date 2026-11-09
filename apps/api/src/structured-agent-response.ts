import {z} from 'zod';

/**
 * Reads exactly one complete JSON object, without guessing where the first/last
 * braces belong. In particular two concatenated JSON responses are NOT one
 * response: accepting only the first would silently lose requirements/questions.
 */
export function parseAgentObject(raw:string):unknown{
 let text=raw.trim().replace(/^\uFEFF/,'');
 const fenced=/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
 if(fenced)text=fenced[1].trim();
 try{
  const parsed=JSON.parse(text);
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('Ожидался JSON-объект');
  return parsed;
 }catch{/* Responses may have explanatory text before a single JSON object. */}
 const start=text.indexOf('{');
 if(start<0)throw Error('AI не вернул JSON-объект');
 let depth=0,inString=false,escaped=false,end=-1;
 for(let i=start;i<text.length;i++){
  const c=text[i];
  if(inString){
   if(escaped){escaped=false;continue;}
   if(c==='\\'){escaped=true;continue;}
   if(c==='"'){inString=false;}
  }else if(c==='"'){inString=true;}
  else if(c==='{')depth++;
  else if(c==='}'){
   depth--;
   if(depth===0){end=i+1;break;}
  }
 }
 if(end<0)throw Error('JSON-ответ AI обрывается до закрывающей скобки');
 const rest=text.slice(end).trim();
 if(rest)throw Error('После JSON обнаружено дополнительное содержимое: возможен второй объект или продолжение ответа');
 const parsed=JSON.parse(text.slice(start,end));
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('Ожидался JSON-объект');
 return parsed;
}

type AgentReply={text:string;usage?:{input_tokens:number;cached_input_tokens:number;output_tokens:number}};
type StructuredCall<T>={
 prompt:string;
 schema:z.ZodType<T>;
 label:string;
 formatExample:string;
 complete:(prompt:string)=>Promise<AgentReply>;
 recordUsage:(usage:AgentReply['usage'])=>Promise<void>;
 progress:(stage:string,message:string)=>Promise<void>;
};

/**
 * Malformed JSON is an agent output problem, not a user task failure.
 * Ask the same agent to repair its own complete output; do not advance the
 * document cursor or silently discard a second JSON object. Exhaustion leaves
 * the current topic pending so the job can be resumed from its last checkpoint.
 */
export async function completeStructured<T>(args:StructuredCall<T>):Promise<T>{
 const {prompt,schema,label,formatExample,complete,recordUsage,progress}=args;
 let initialText='',lastError='';
 for(let attempt=1;attempt<=3;attempt++){
  const request=attempt===1?prompt:[
   'Ты исправляешь структуру своего ответа аналитика. Это исправление формата, не новая аналитическая задача.',
   'Верни ровно ОДИН валидный JSON-объект без Markdown, пояснений или дополнительных JSON-объектов.',
   'Обязательно сохрани ВСЕ факты, требования, части Markdown и вопросы из первоначального ответа.',
   'Если в исходном ответе несколько JSON-объектов, объедини содержимое полей body/notes и все вопросы, ничего не удаляя.',
   'Не добавляй новых фактов. Не меняй согласованные формулировки требований ради сокращения.',
   'Требуемый формат: '+formatExample,
   'Причина отклонения: '+lastError,
   'Полный первоначальный ответ:\n'+initialText
  ].join('\n\n');
  const response=await complete(request);
  await recordUsage(response.usage);
  try{
   return schema.parse(parseAgentObject(response.text));
  }catch(error){
   if(attempt===1)initialText=response.text;
   const reason=error instanceof z.ZodError
    ?error.issues.map(issue=>(issue.path.join('.')||'ответ')+': '+issue.message).slice(0,5).join('; ')
    :error instanceof Error?error.message:String(error);
   lastError=reason.slice(0,650);
   if(attempt===3)throw Error('Аналитик не смог подготовить корректный JSON для «'+label+'» после 3 попыток: '+lastError);
   // A shortened repair context could silently lose content. A failed topic can
   // safely be regenerated in the same import, but must never be truncated.
   if(initialText.length>32000)throw Error('Ответ аналитика для «'+label+'» слишком велик для безопасного восстановления формата. Уже сохранённые части не затронуты.');
   await progress('format_retry','Исправление формата ответа · '+label+' · попытка '+(attempt+1)+'/3');
  }
 }
 throw Error('Не удалось восстановить ответ аналитика «'+label+'»');
}
