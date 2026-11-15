import React,{useState} from 'react';
import {FileArchive,FileDown,FileText,X} from 'lucide-react';
import {authTokenKey,renewAccessToken} from './api/client.js';

export type ChatFileDraft={id:string;name:string;mimeType:string;data:string;size:number};
export type ChatFileMeta={id:string;name:string;mimeType:string;size:number;sha256?:string;data?:string};
export const MAX_FILES=5;
const MAX_FILE_BYTES=2*1024*1024,MAX_TOTAL=6*1024*1024;
const mimeByExt:Record<string,string>={
 txt:'text/plain',md:'text/markdown',csv:'text/csv',json:'application/json',
 yaml:'text/yaml',yml:'text/yaml',pdf:'application/pdf',
 docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
 xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
 pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
 zip:'application/zip'
};
export const supportedChatFile=(name:string)=>Boolean(mimeByExt[name.split('.').at(-1)?.toLowerCase()||'']);

export async function prepareChatFiles(files:File[],current:ChatFileDraft[]):Promise<ChatFileDraft[]>{
 if(current.length+files.length>MAX_FILES)throw Error('Максимум 5 файлов в одном сообщении.');
 if(files.some(f=>!supportedChatFile(f.name)||/[/\\\x00-\x1f]/.test(f.name)||f.name.length>180))
  throw Error('Файлы: TXT, MD, CSV, JSON, YAML, PDF, DOCX, XLSX, PPTX, ZIP.');
 if(files.some(f=>!f.size||f.size>MAX_FILE_BYTES)||
  files.reduce((sum,f)=>sum+f.size,0)+current.reduce((sum,f)=>sum+f.size,0)>MAX_TOTAL)
  throw Error('Размер: до 2 МБ на файл и 6 МБ на сообщение.');
 const out=await Promise.all(files.map(async file=>{
  const data=await new Promise<string>((resolve,reject)=>{
   const reader=new FileReader();
   reader.onload=()=>resolve(String(reader.result||'').split(',')[1]||'');
   reader.onerror=()=>reject(Error('Не удалось прочитать '+file.name));
   reader.readAsDataURL(file);
  });
  if(!data)throw Error('Не удалось прочитать '+file.name);
  return {id:crypto.randomUUID(),name:file.name,mimeType:mimeByExt[file.name.split('.').at(-1)!.toLowerCase()],
   size:file.size,data};
 }));
 return [...current,...out];
}
function readableBytes(size:number){
 return size>=1024*1024?(size/(1024*1024)).toFixed(1)+' МБ':Math.max(1,Math.ceil(size/1024))+' КБ';
}

function ChatFileItem({file,projectId,onRemove}:{file:ChatFileMeta;projectId:string;onRemove?:(id:string)=>void}){
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState('');
 const download=async()=>{
  if(onRemove||loading)return;
  setLoading(true);setError('');
  try{
   const send=(token:string|null)=>fetch('/api/projects/'+encodeURIComponent(projectId)+
    '/chat-files/'+encodeURIComponent(file.id),{
    credentials:'same-origin',headers:{...(token?{Authorization:'Bearer '+token}:{})}
   });
   let response=await send(sessionStorage.getItem(authTokenKey));
   if(response.status===401){
    const token=await renewAccessToken();
    if(!token)throw Error('Сессия завершена');
    response=await send(token);
   }
   if(!response.ok)throw Error('HTTP '+response.status);
   const blob=await response.blob();
   const url=URL.createObjectURL(blob);
   try{
    const a=document.createElement('a');
    a.href=url;a.download=file.name;document.body.appendChild(a);
    a.click();a.remove();
   }finally{window.setTimeout(()=>URL.revokeObjectURL(url),1000);}
  }catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{setLoading(false);}
 };
 const archive=/zip|officedocument/.test(file.mimeType);
 return <div className="chat-file-item" title={file.name}>
  {archive?<FileArchive size={16}/>:<FileText size={16}/>}
  <span className="chat-file-label"><strong>{file.name}</strong><small>{readableBytes(file.size)}</small></span>
  {onRemove?<button type="button" className="chat-file-action" aria-label={'Убрать '+file.name}
   onClick={()=>onRemove(file.id)}><X size={14}/></button>
   :<button type="button" className="chat-file-action" aria-label={'Скачать '+file.name}
    title={'Скачать '+file.name} disabled={loading} onClick={()=>void download()}><FileDown size={15}/></button>}
  {error&&<small className="chat-file-error" role="alert">{error}</small>}
 </div>;
}
export function ChatFileGallery({files,projectId,onRemove}:{
 files:ChatFileMeta[];projectId:string;onRemove?:(id:string)=>void
}){
 if(!files.length)return null;
 return <div className={'chat-file-gallery'+(onRemove?' draft':'')} aria-label="Вложения файлов">
  {files.map(file=><ChatFileItem key={file.id} file={file} projectId={projectId} onRemove={onRemove}/>)}
 </div>;
}
