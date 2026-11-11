import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const MAX_IMAGE_BYTES=2*1024*1024;
const MAX_TOTAL_BYTES=6*1024*1024;
const extensions={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp'};
export function validateRunnerImages(images){
 if(images===undefined)return [];
 if(!Array.isArray(images)||images.length>4)throw Error('Слишком много изображений в AI-запросе');
 let total=0;
 return images.map(image=>{
  const extension=extensions[image?.mimeType];
  if(!extension||typeof image.data!=='string'||image.data.length>Math.ceil(MAX_IMAGE_BYTES*4/3)+16||
     !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)||image.data.length%4!==0)
   throw Error('Некорректное изображение в AI-запросе');
  const bytes=Buffer.from(image.data,'base64');
  total+=bytes.length;
  if(!bytes.length||bytes.length>MAX_IMAGE_BYTES||total>MAX_TOTAL_BYTES)
   throw Error('Слишком большой размер изображений в AI-запросе');
  const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg=bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[bytes.length-2]===255&&bytes[bytes.length-1]===217;
  const webp=bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
  if(!(image.mimeType==='image/png'&&png||image.mimeType==='image/jpeg'&&jpeg||image.mimeType==='image/webp'&&webp))
   throw Error('Содержимое изображения не соответствует его формату');
  return {extension,bytes};
 });
}
export async function withRunnerImages(images,run){
 const validated=validateRunnerImages(images);
 if(!validated.length)return run([]);
 const directory=await mkdtemp(join(tmpdir(),'ado-chat-images-'));
 try{
  const args=[];
  for(let i=0;i<validated.length;i++){
   const filepath=join(directory,'image-'+i+validated[i].extension);
   await writeFile(filepath,validated[i].bytes,{mode:0o600});
   args.push('--image',filepath);
  }
  return await run(args);
 }finally{await rm(directory,{recursive:true,force:true});}
}
