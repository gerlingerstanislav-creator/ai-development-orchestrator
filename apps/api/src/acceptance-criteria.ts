// Acceptance criteria belong to a task specification, not a separate gate.
// Preserve owner-written criteria when an analyst rewrites the description.
const heading=/^\s{0,3}(?:#{1,6}\s*)?(?:\*\*)?\s*(?:критерии\s+при[её]мки|acceptance\s+criteria)\s*(?:\*\*)?\s*:?\s*$/i;
const nextSection=/^\s{0,3}(?:#{1,6}\s+|(?:\*\*)?[А-ЯA-Z][^.!?]{1,70}:\s*$)/;
const bullet=/^\s*(?:[-*•]|\d+[.)])\s+/;
const normalized=(value:string)=>value.trim().toLowerCase().replace(/^\s*(?:[-*•]|\d+[.)])\s+/,'').replace(/\s+/g,' ').replace(/[.;]+$/,'');
export function acceptanceCriteria(description:string):string[]{
 const lines=description.split(/\r?\n/);
 const entries:string[]=[];
 let collecting=false;
 for(const line of lines){
  if(heading.test(line)){collecting=true;continue;}
  if(!collecting)continue;
  if(nextSection.test(line)&&!bullet.test(line)){collecting=false;continue;}
  if(!line.trim())continue;
  if(bullet.test(line))entries.push(line.trim().replace(bullet,''));
  else if(entries.length===0)entries.push(line.trim()); // unbulleted single criterion
 }
 return [...new Map(entries.filter(Boolean).map(item=>[normalized(item),item])).values()];
}
export function preserveAcceptanceCriteria(before:string,after:string):string{
 const existing=acceptanceCriteria(before);
 if(!existing.length)return after;
 const refined=acceptanceCriteria(after);
 const seen=new Set(refined.map(normalized));
 const omitted=existing.filter(x=>!seen.has(normalized(x)));
 if(!omitted.length)return after;
 if(refined.length){
  const lines=after.split(/\r?\n/);
  const headingIndex=lines.findIndex(line=>heading.test(line));
  let insertion=lines.length;
  for(let index=headingIndex+1;index<lines.length;index++){
   if(nextSection.test(lines[index])&&!bullet.test(lines[index])){insertion=index;break;}
  }
  lines.splice(insertion,0,...omitted.map(x=>'- '+x));
  return lines.join('\n');
 }
 return after.trimEnd()+'\n\n### Критерии приёмки\n'+omitted.map(x=>'- '+x).join('\n');
}
