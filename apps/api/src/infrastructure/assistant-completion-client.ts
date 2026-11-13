import type {AgentReaderScope} from '../agent-tools.js';
import type {RunnerImage} from '../chat-images.js';

/** Runner /assistant transport; authorization and retries stay in infrastructure. */
export type AssistantCompletionOptions={
 maxAttempts?:number;
 timeoutMs?:number;
 onRetry?:(attempt:number,maxAttempts:number,reason:string)=>Promise<void>;
 images?:RunnerImage[];
 context?:AgentReaderScope;
};
export function createAssistantCompletionClient({
 codexUrl,runnerKey,fetchImpl=fetch,sleep=(milliseconds:number)=>new Promise<void>(resolve=>setTimeout(resolve,milliseconds))
}:{
 codexUrl:string;runnerKey:string;fetchImpl?:typeof fetch;sleep?:(milliseconds:number)=>Promise<void>;
}){
 return async function completion(prompt:string,config:{model:string;reasoning:string},options?:AssistantCompletionOptions){
   const maxAttempts=options?.maxAttempts??1;
   for(let attempt=1;attempt<=maxAttempts;attempt++){
    try{
     const response=await fetchImpl(codexUrl+'/assistant',{method:'POST',
      headers:{'X-Runner-Secret':runnerKey,'Content-Type':'application/json'},
      body:JSON.stringify({model:config.model,reasoning:config.reasoning,prompt,images:options?.images??[],context:options?.context}),
      signal:AbortSignal.timeout(options?.timeoutMs??(maxAttempts>1?255000:115000))});
     const data=await response.json().catch(()=>({})) as any;
     if(!response.ok){
      const error=Object.assign(new Error(String(data.error||'Codex недоступен').slice(0,700)),{statusCode:response.status});
      throw error;
     }
     if(typeof data.message!=='string'||!data.message.trim())throw new Error('Codex вернул пустой ответ');
     if(data.message.length>120000)throw new Error('Ответ Codex превысил безопасный объём. Нужно уменьшить размер итоговых разделов документации.');
     return {text:data.message.trim(),usage:data.usage as {input_tokens:number;cached_input_tokens:number;output_tokens:number}|undefined};
    }catch(error){
     const reason=error instanceof Error?error.message:String(error);
     const code=(error as {statusCode?:number})?.statusCode;
     const retryable=code===429||code===503&&/timeout|времени|связи|перегруз|busy|несколько/i.test(reason)
      ||/timed?\s*out|timeout|aborted|AbortError|превысил ограничение времени|превышено время|несколько AI-диалогов|fetch failed|ECONNRESET|ETIMEDOUT/i.test(reason);
     if(!retryable||attempt>=maxAttempts)throw error;
     await options?.onRetry?.(attempt,maxAttempts,reason);
     await sleep(Math.min(10000,attempt*3000));
    }
   }
   throw Error('Codex не завершил запрос');
  }


}
