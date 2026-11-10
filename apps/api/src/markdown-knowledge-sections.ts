import {createHash} from 'node:crypto';

type Section={section_id:string;line:number;level:number;title:string;end:number};
/**
 * Deterministic structural addresses: adding paragraphs before a heading does not
 * break references. Moving/renaming a heading deliberately changes its identity.
 * Duplicates in the same hierarchy are disambiguated by occurrence count.
 */
export function markdownSections(documentId:string,body:string):Section[]{
 const lines=body.replace(/\r\n/g,'\n').split('\n');
 const sections:Section[]=[];
 const ancestors:string[]=[];
 const counts=new Map<string,number>();
 let fenced=false;
 lines.forEach((line,index)=>{
  if(/^\s*`{3,}/.test(line)){fenced=!fenced;return;}
  if(fenced)return;
  const match=/^(#{1,6})\s+(.+?)\s*$/.exec(line);
  if(!match)return;
  const level=match[1].length,title=match[2];
  ancestors.length=level-1;
  ancestors[level-1]=title.trim().toLowerCase();
  const path=ancestors.filter(Boolean).join('/');
  const occurrence=(counts.get(path)||0)+1;
  counts.set(path,occurrence);
  const hash=createHash('sha256').update(documentId+'|'+path+'|'+occurrence).digest('hex');
  const hex=hash.slice(0,12)+'5'+hash.slice(13,16)+'a'+hash.slice(17,32);
  const id=[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20,32)].join('-');
  sections.push({section_id:id,line:index,level,title,end:lines.length});
 });
 for(let i=0;i<sections.length;i++){
  for(let j=i+1;j<sections.length;j++){
   if(sections[j].level<=sections[i].level){sections[i].end=sections[j].line;break;}
  }
 }
 return sections;
}
export function sectionBody(body:string,section:Section){
 return body.replace(/\r\n/g,'\n').split('\n').slice(section.line,section.end).join('\n');
}
