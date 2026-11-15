import React,{useEffect,useState} from 'react';
import {X} from 'lucide-react';
import {authTokenKey,renewAccessToken} from '../../api/client.js';

export type PmBrowserArtifact={
 id:string;capture_id:string;source_sha:string;sha256:string;
 name:string;url:string;viewport:{width:number;height:number};
 created_at:string;
};
/** Secure, browser-verified JPEG thumbnail shared by task evidence and PM chat.
 * Blob URLs are scoped to this component; protected API URLs are never used as
 * raw <img src> because bearer auth is required.
 */
export function SecurePmScreenshot({url,label,alt,fullPage=false}:{url:string;label:string;alt:string;fullPage?:boolean}){
 const [blobUrl,setBlobUrl]=useState('');
 const [error,setError]=useState('');
 const [open,setOpen]=useState(false);
 const [nativeSize,setNativeSize]=useState(false);
 useEffect(()=>{
  let alive=true,objectUrl='';
  const controller=new AbortController();
  setBlobUrl('');setError('');
  const load=async()=>{
   const send=(token:string|null)=>fetch(url,{credentials:'same-origin',signal:controller.signal,headers:{
    ...(token?{Authorization:'Bearer '+token}:{})
   }});
   try{
    let response=await send(sessionStorage.getItem(authTokenKey));
    if(response.status===401){
     const fresh=await renewAccessToken();
     if(!fresh)throw Error('Сессия завершена');
     response=await send(fresh);
    }
    if(!response.ok)throw Error('HTTP '+response.status);
    const bytes=await response.blob();
    if(bytes.type!=='image/jpeg')throw Error('Получен неподтверждённый формат изображения');
    if(!alive)return;
    objectUrl=URL.createObjectURL(bytes);
    setBlobUrl(objectUrl);
   }catch(err){
    if(alive&&!controller.signal.aborted)
     setError('Не удалось загрузить скриншот: '+String(err instanceof Error?err.message:err));
   }
  };
  void load();
  return()=>{alive=false;controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
 },[url]);
 useEffect(()=>{
  if(!open)return;
  const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')setOpen(false);};
  window.addEventListener('keydown',onKey);
  return()=>window.removeEventListener('keydown',onKey);
 },[open]);
 return <div className="task-pm-shot">
  {blobUrl?<button className="pm-screenshot-preview" type="button" onClick={()=>{setNativeSize(false);setOpen(true);}} title={'Посмотреть '+label} aria-label={'Посмотреть '+label}>
   <img src={blobUrl} alt={alt}/>
  </button>:<span className="muted">{error||'Загрузка изображения…'}</span>}
  <small>{label}</small>
  {open&&blobUrl&&<div className={'chat-image-lightbox'+(fullPage?' pm-full-page-lightbox':'')}
    role="dialog" aria-modal="true" aria-label={'Просмотр '+label} onMouseDown={()=>setOpen(false)}>
   <button type="button" className="chat-image-lightbox-close" aria-label="Закрыть изображение" onClick={()=>setOpen(false)}><X size={22}/></button>
   {fullPage?<><div className="pm-full-page-toolbar" onMouseDown={event=>event.stopPropagation()}>
    <span>{label}</span>
    <button type="button" onClick={()=>setNativeSize(size=>!size)}>
     {nativeSize?'Уместить изображение':'Оригинальный размер · 100%'}</button>
   </div>
   <div className="pm-full-page-scroll" onMouseDown={event=>event.stopPropagation()}>
    <img src={blobUrl} alt={alt} className={nativeSize?'native-resolution':''}/>
   </div></>:<img src={blobUrl} alt={alt} onMouseDown={event=>event.stopPropagation()}/>}
  </div>}
 </div>;
}
/** A task has no visual placeholder until real authenticated images exist. */
export function TaskPmScreenshotGallery({artifacts}:{artifacts?:PmBrowserArtifact[]}){
 if(!artifacts?.length)return null;
 const latest=artifacts[0].capture_id;
 const images=artifacts.filter(x=>x.capture_id===latest).slice(0,2);
 return <details className="task-pm-screenshots">
  <summary>Локальный preview · Скриншоты ПМ · {images.length} · SHA {String(images[0]?.source_sha||'').slice(0,12)}</summary>
  <div className="task-pm-screenshots-grid">
   {images.map(artifact=><SecurePmScreenshot key={artifact.id} url={artifact.url}
    label={artifact.viewport.width+'×'+artifact.viewport.height}
    alt={'Скриншот '+artifact.viewport.width+'×'+artifact.viewport.height+' на SHA '+artifact.source_sha.slice(0,12)}/>)}
  </div>
 </details>;
}
