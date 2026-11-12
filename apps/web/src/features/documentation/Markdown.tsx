import React from 'react';

function markdownInline(source:string):React.ReactNode[]{
 const pattern=/(\[([^\]]+)\]\((https?:\/\/[^ )]+)\)|\*\*([^*]+)\*\*|\x60([^\x60]+)\x60)/g;
 const nodes:React.ReactNode[]=[];
 let last=0,match:RegExpExecArray|null;
 while((match=pattern.exec(source))!==null){
  if(match.index>last)nodes.push(source.slice(last,match.index));
  if(match[2]&&match[3])nodes.push(<a key={match.index} href={match[3]} target="_blank" rel="noopener noreferrer">{match[2]}</a>);
  else if(match[4])nodes.push(<strong key={match.index}>{match[4]}</strong>);
  else if(match[5])nodes.push(<code key={match.index}>{match[5]}</code>);
  last=pattern.lastIndex;
 }
 if(last<source.length)nodes.push(source.slice(last));
 return nodes;
}
export function pmDisplayText(source:string){
 // Historic PM responses may contain obsolete, unsupported pseudo-links.
 // Keep their labels, not misleading paths that have no application route.
 return source.replace(/\[([^\]]+)\]\(orchestrator:\/\/[^)]+\)/gi,'$1');
}
export function DocumentMarkdown({source}:{source:string}){
 const rows=source.replace(/\r\n/g,'\n').split('\n');
 const result:React.ReactNode[]=[];
 let index=0;
 while(index<rows.length){
  const line=rows[index];
  if(!line.trim()){index++;continue;}
  if(/^\s*\x60{3}/.test(line)){
   const language=line.trim().slice(3);
   const code:string[]=[];
   index++;
   while(index<rows.length&&!/^\s*\x60{3}/.test(rows[index]))code.push(rows[index++]);
   if(index<rows.length)index++;
   result.push(<pre key={'block-'+index} className="docs-code"><code data-language={language}>{code.join('\n')}</code></pre>);
   continue;
  }
  const heading=/^(#{1,6})\s+(.+)$/.exec(line);
  if(heading){
   const level=heading[1].length;
   const contents=markdownInline(heading[2]);
   const props={key:'heading-'+index,className:'docs-heading docs-h'+level};
   result.push(level===1?<h1 {...props}>{contents}</h1>:level===2?<h2 {...props}>{contents}</h2>:level===3?<h3 {...props}>{contents}</h3>:<h4 {...props}>{contents}</h4>);
   index++;continue;
  }
  if(line.trim().startsWith('|')&&index+1<rows.length&&
     /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(rows[index+1])){
   const cells=(value:string)=>value.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(x=>x.trim());
   const headings=cells(line);
   index+=2;
   const content:React.ReactNode[]=[];
   while(index<rows.length&&rows[index].trim().startsWith('|')){
    const values=cells(rows[index]);
    content.push(<tr key={'row-'+index}>{headings.map((_,col)=><td key={col}>{markdownInline(values[col]||'')}</td>)}</tr>);
    index++;
   }
   result.push(<div key={'table-'+index} className="docs-table-wrap"><table><thead><tr>{headings.map((h,col)=><th key={col}>{markdownInline(h)}</th>)}</tr></thead><tbody>{content}</tbody></table></div>);
   continue;
  }
  if(/^\s*([-*+] |\d+\. )/.test(line)){
   const ordered=/^\s*\d+\. /.test(line);
   const items:React.ReactNode[]=[];
   while(index<rows.length&&/^\s*([-*+] |\d+\. )/.test(rows[index])){
    items.push(<li key={'li-'+index}>{markdownInline(rows[index].replace(/^\s*(?:[-*+] |\d+\. )/,''))}</li>);
    index++;
   }
   result.push(ordered?<ol key={'list-'+index}>{items}</ol>:<ul key={'list-'+index}>{items}</ul>);
   continue;
  }
  if(/^\s*>\s?/.test(line)){
   const text:string[]=[];
   while(index<rows.length&&/^\s*>\s?/.test(rows[index]))text.push(rows[index++].replace(/^\s*>\s?/,''));
   result.push(<blockquote key={'quote-'+index}>{text.map((x,i)=><React.Fragment key={i}>{i>0&&' '}{markdownInline(x)}</React.Fragment>)}</blockquote>);
   continue;
  }
  if(/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)){result.push(<hr key={'hr-'+index}/>);index++;continue;}
  const paragraphs:string[]=[];
  while(index<rows.length&&rows[index].trim()&&!/^(#{1,6})\s+/.test(rows[index])&&!/^\s*\x60{3}/.test(rows[index])&&!/^\s*([-*+] |\d+\. )/.test(rows[index])&&!/^\s*>\s?/.test(rows[index])){
   paragraphs.push(rows[index++]);
  }
  if(paragraphs.length)result.push(<p key={'p-'+index}>{paragraphs.map((text,i)=><React.Fragment key={i}>{i>0&&' '}{markdownInline(text)}</React.Fragment>)}</p>);
 }
 return <article className="docs-markdown">{result}</article>;
}

