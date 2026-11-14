/** Bounded, factual context for a reusable Codex PM thread.
 * Conversation prose isn't authoritative for task/process state; persistent
 * goals and owner decisions are. Never infer any task is done from text.
 */
type Goal={
 id:string;objective:string;criteria:unknown;status:string;order_id?:string|null
};
type Decision={question:string;answer:string};
const summary=(value:unknown,max:number)=>String(value??'').replace(/\s+/g,' ').trim().slice(0,max);
export function buildPmConversationContext(goals:readonly Goal[],decisions:readonly Decision[],limit=2300){
 if(!goals.length&&!decisions.length)return '';
 const entries:string[]=[];
 for(const g of goals.slice(0,6)){
  const criteria=Array.isArray(g.criteria)?g.criteria.filter(x=>typeof x==='string').slice(0,3)
   .map(x=>summary(x,140)):[];
  entries.push('Цель '+summary(g.id,36)+' ('+summary(g.status,30)+'): '+summary(g.objective,220)+
   (criteria.length?'; критерии: '+criteria.join('; '):'')+
   (g.order_id?'; исходное поручение '+summary(g.order_id,36):''));
 }
 for(const d of decisions.slice(0,4)){
  entries.push('Решение владельца: '+summary(d.question,120)+' → '+summary(d.answer,200));
 }
 const result=entries.join('\n').slice(0,Math.max(500,Math.min(limit,4000)));
 return 'Подтверждённые долговременные цели и решения (полное состояние через goals.read, pm.decisions.list):\n'+result;
}
