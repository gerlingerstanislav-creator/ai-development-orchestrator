/**
 * A developer may satisfy a task by proving its acceptance criteria are
 * already implemented at the current target SHA. This never means QA passed:
 * the API must pin the SHA and send it through independent verification.
 */
const sha=/^[a-f0-9]{40}$/i;
const sourcePath=/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*(?:^|\/)\.git(?:\/|$))[\w@ .\/+()-]{1,240}$/;
export function parseExistingImplementation(text,{baseSha,headSha,trackedFiles}){
 if(!/^RESULT:\s*already_implemented\s*$/im.test(text))return null;
 const match=text.match(/^IMPLEMENTATION_EVIDENCE:\s*(\{[^\r\n]*\})\s*$/im);
 if(!match)throw Error('Не представлено структурированное подтверждение существующей реализации');
 let data;
 try{data=JSON.parse(match[1]);}
 catch{throw Error('Некорректный IMPLEMENTATION_EVIDENCE JSON');}
 if(!sha.test(baseSha||'')||baseSha!==headSha)
  throw Error('Подтверждение реализации без PR допустимо только для текущего коммита базовой ветки');
 if(!data||typeof data.summary!=='string'||data.summary.trim().length<40||
  !Array.isArray(data.files)||data.files.length<1||data.files.length>20||
  !Array.isArray(data.criteria)||data.criteria.length<1||data.criteria.length>25)
  throw Error('Укажи итог, изменённые ранее файлы и сопоставление с критериями приёмки');
 const tracked=new Set(trackedFiles);
 for(const file of data.files){
  if(typeof file!=='string'||!sourcePath.test(file)||!tracked.has(file))
   throw Error('Ссылка на файл не подтверждена репозиторием: '+String(file).slice(0,100));
 }
 for(const criterion of data.criteria){
  if(typeof criterion!=='string'||criterion.trim().length<12||criterion.length>1000)
   throw Error('Каждый критерий должен иметь конкретное обоснование');
 }
 return {summary:data.summary.trim().slice(0,1400),files:data.files,criteria:data.criteria,commit:baseSha};
}
