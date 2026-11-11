/**
 * Codex Runner accepts at most 24,000 prompt characters.
 * Budget individual context sections instead of blindly truncating the
 * assembled prompt: recent owner decisions, approved scope and requirements
 * must stay visible even when historic conversations or documents are huge.
 */
export const ITERATION_PROMPT_LIMIT=23000;
const truncationMarker='\n[Фрагмент контекста сокращён из-за лимита AI-запроса]';

export function boundedIterationPrompt(sections:readonly string[],budgets:readonly number[]):string{
 if(sections.length!==budgets.length)throw Error('У секций подготовки итерации отсутствуют ограничения размера');
 const parts=sections.map((section,index)=>{
  const limit=budgets[index];
  if(!Number.isSafeInteger(limit)||limit<truncationMarker.length)
   throw Error('Некорректный лимит секции AI-запроса');
  return section.length<=limit?section:section.slice(0,limit-truncationMarker.length)+truncationMarker;
 });
 const prompt=parts.join('\n\n');
 if(prompt.length>ITERATION_PROMPT_LIMIT)
  throw Error('Контекст подготовки итерации превышает безопасный лимит: '+prompt.length+'/'+ITERATION_PROMPT_LIMIT);
 return prompt;
}
