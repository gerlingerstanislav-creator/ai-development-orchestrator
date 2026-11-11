import {useEffect,useRef,useState} from 'react';
import {ImagePlus,X} from 'lucide-react';
import type {ClipboardEvent,DragEvent,ReactNode} from 'react';

export type ChatImageDraft={id:string;name:string;mimeType:'image/png'|'image/jpeg'|'image/webp';data:string};
export type ChatImageMeta={id:string;name:string;mimeType:string;data?:string};
export const MAX_IMAGES=4;
const MAX_BYTES=2*1024*1024;
const MAX_TOTAL_BYTES=6*1024*1024;
const imageFormats=['image/png','image/jpeg','image/webp'];
export function imageFiles(files:FileList|File[]|null):File[]{
 return Array.from(files||[]).filter(file=>file instanceof File);
}
export function pastedImages(event:ClipboardEvent):File[]{
 return Array.from(event.clipboardData.items).filter(item=>item.kind==='file'&&imageFormats.includes(item.type))
  .map(item=>item.getAsFile()).filter((file):file is File=>!!file);
}
export function droppedImages(event:DragEvent):File[]{
 return imageFiles(event.dataTransfer.files);
}
export async function prepareChatImages(files:File[],current:ChatImageDraft[]):Promise<ChatImageDraft[]>{
 if(current.length+files.length>MAX_IMAGES)throw Error('Максимум 4 изображения в одном сообщении.');
 const total=current.reduce((sum,image)=>sum+Math.floor(image.data.length*3/4),0)+files.reduce((sum,file)=>sum+file.size,0);
 if(total>MAX_TOTAL_BYTES)throw Error('Суммарный размер изображений не должен превышать 6 МБ.');
 for(const file of files){
  if(!imageFormats.includes(file.type))throw Error('Поддерживаются только PNG, JPEG и WebP.');
  if(!file.size||file.size>MAX_BYTES)throw Error('Каждое изображение должно быть не больше 2 МБ.');
 }
 const pending=await Promise.all(files.map(async file=>{
  const src=await new Promise<string>((resolve,reject)=>{
   const reader=new FileReader();
   reader.onload=()=>resolve(String(reader.result||''));
   reader.onerror=()=>reject(Error('Не удалось прочитать изображение'));
   reader.readAsDataURL(file);
  });
  const encoded=src.split(',')[1];
  if(!encoded)throw Error('Не удалось прочитать изображение');
  return {id:crypto.randomUUID(),name:file.name||'image.png',mimeType:file.type as ChatImageDraft['mimeType'],data:encoded};
 }));
 return [...current,...pending];
}
export function ChatImagePicker({disabled,onFiles}:{disabled:boolean;onFiles:(files:File[])=>void}){
 const input=useRef<HTMLInputElement>(null);
 return <>
  <input hidden type="file" ref={input} multiple accept="image/png,image/jpeg,image/webp" onChange={event=>{
   onFiles(imageFiles(event.currentTarget.files));event.currentTarget.value='';
  }}/>
  <button type="button" className="secondary chat-image-picker" aria-label="Прикрепить изображения" title="Изображения: выбор файла, Ctrl+V или перетаскивание" disabled={disabled} onClick={()=>input.current?.click()}>
   <ImagePlus size={17}/>
  </button>
 </>;
}
function ChatImage({image,projectId,read}:{image:ChatImageMeta;projectId:string;read:(path:string)=>Promise<{mimeType:string;data:string}>}){
 const [src,setSrc]=useState(image.data?'data:'+image.mimeType+';base64,'+image.data:'');
 const [open,setOpen]=useState(false);
 useEffect(()=>{
  if(image.data){setSrc('data:'+image.mimeType+';base64,'+image.data);return;}
  let active=true;
  setSrc('');
  void read('/projects/'+projectId+'/chat-images/'+image.id).then(data=>{
   if(active)setSrc('data:'+data.mimeType+';base64,'+data.data);
  }).catch(()=>{if(active)setSrc('');});
  return()=>{active=false;};
 },[projectId,image.id,image.mimeType,image.data,read]);
 useEffect(()=>{
  if(!open)return;
  const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')setOpen(false);};
  window.addEventListener('keydown',onKey);
  return()=>window.removeEventListener('keydown',onKey);
 },[open]);
 return <>
  <button className="chat-image-thumb" type="button" disabled={!src} onClick={()=>setOpen(true)} title={'Посмотреть '+image.name}
   aria-label={'Посмотреть '+image.name}>
   {src?<img src={src} alt={image.name} loading="lazy"/>:<span>Изображение</span>}
  </button>
  {open&&src&&<div className="chat-image-lightbox" role="dialog" aria-modal="true" aria-label={'Просмотр '+image.name}
   onMouseDown={()=>setOpen(false)}>
   <button type="button" className="chat-image-lightbox-close" aria-label="Закрыть изображение" onClick={()=>setOpen(false)}><X size={22}/></button>
   <img src={src} alt={image.name} onMouseDown={event=>event.stopPropagation()}/>
  </div>}
 </>;
}
export function ChatImageGallery({images,projectId,read,onRemove}:{images:ChatImageMeta[];projectId:string;read:(path:string)=>Promise<{mimeType:string;data:string}>;onRemove?:(id:string)=>void}){
 if(!images.length)return null;
 return <div className={'chat-image-gallery'+(onRemove?' draft':'')} aria-label="Изображения сообщения">
  {images.map(image=><div className="chat-image-item" key={image.id}>
   <ChatImage image={image} projectId={projectId} read={read}/>
   {onRemove&&<button type="button" className="chat-image-remove" aria-label={'Убрать '+image.name} title="Убрать изображение" onClick={()=>onRemove(image.id)}><X size={13}/></button>}
  </div>)}
 </div>;
}
export function ChatImageDropZone({children,onImages,onError,className=''}:{
 children:ReactNode;onImages:(files:File[])=>void;onError:(message:string)=>void;className?:string
}){
 const [dragging,setDragging]=useState(false);
 return <div className={'chat-image-dropzone '+className+(dragging?' dragging':'')}
  onDragOver={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();setDragging(true);}}}
  onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setDragging(false);}}
  onDrop={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();setDragging(false);const files=droppedImages(event);if(files.length)onImages(files);else onError('Перетащи изображение PNG, JPEG или WebP.');}}}
  onPaste={event=>{const files=pastedImages(event);if(files.length){event.preventDefault();onImages(files);}}}>
  {children}
  {dragging&&<div className="chat-image-drop-overlay">Отпусти, чтобы прикрепить изображение</div>}
 </div>;
}
