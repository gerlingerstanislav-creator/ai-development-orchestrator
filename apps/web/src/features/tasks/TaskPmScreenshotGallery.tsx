import React,{useEffect,useState} from 'react';
import {authTokenKey,renewAccessToken} from '../../api/client.js';

export type PmBrowserArtifact={
 id:string;capture_id:string;source_sha:string;sha256:string;
 name:string;url:string;viewport:{width:number;height:number};
 created_at:string;
};
function SecureScreenshot({artifact}:{artifact:PmBrowserArtifact}){
 const [blobUrl,setBlobUrl]=useState('');
 const [error,setError]=useState('');
 useEffect(()=>{
  let alive=true,objectUrl='';
  const load=async()=>{
   const send=(token:string|null)=>fetch(artifact.url,{credentials:'same-origin',headers:{
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
    if(!alive)return;
    if(bytes.type!=='image/jpeg')throw Error('Получен неподтверждённый формат изображения');
    objectUrl=URL.createObjectURL(bytes);
    setBlobUrl(objectUrl);
   }catch(err){if(alive)setError('Не удалось загрузить изображение: '+String(err instanceof Error?err.message:err));}
  };
  void load();
  return()=>{alive=false;if(objectUrl)URL.revokeObjectURL(objectUrl);};
 },[artifact.id,artifact.url]);
 const label=artifact.viewport.width+'×'+artifact.viewport.height;
 return <div className="task-pm-shot">
  {blobUrl?<a href={blobUrl} target="_blank" rel="noreferrer" title={'Открыть скриншот '+label}>
   <img src={blobUrl} alt={'Скриншот '+label+' на SHA '+artifact.source_sha.slice(0,12)}/>
  </a>:<span className="muted">{error||'Загрузка изображения…'}</span>}
  <small>{label}</small>
 </div>;
}
/** A task has no visual placeholder until real authenticated images exist. */
export function TaskPmScreenshotGallery({artifacts}:{artifacts?:PmBrowserArtifact[]}){
 if(!artifacts?.length)return null;
 const latest=artifacts[0].capture_id;
 const images=artifacts.filter(x=>x.capture_id===latest).slice(0,2);
 return <details className="task-pm-screenshots">
  <summary>Скриншоты ПМ · {images.length} · SHA {String(images[0]?.source_sha||'').slice(0,12)}</summary>
  <div className="task-pm-screenshots-grid">
   {images.map(artifact=><SecureScreenshot key={artifact.id} artifact={artifact}/>)}
  </div>
 </details>;
}
