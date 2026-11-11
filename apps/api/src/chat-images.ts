import type {FastifyInstance} from 'fastify';
import type {Pool,PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';

export const MAX_CHAT_IMAGES=4;
export const MAX_CHAT_IMAGE_BYTES=2*1024*1024;
export const MAX_CHAT_IMAGES_TOTAL_BYTES=6*1024*1024;
const allowedMimeTypes=['image/png','image/jpeg','image/webp'] as const;
export const chatImageSchema=z.object({
 name:z.string().trim().min(1).max(180),
 mimeType:z.enum(allowedMimeTypes),
 data:z.string().min(16).max(Math.ceil(MAX_CHAT_IMAGE_BYTES*4/3)+16)
}).strict();
export const chatImagesSchema=z.array(chatImageSchema).max(MAX_CHAT_IMAGES).default([]);
export type ChatImageInput=z.infer<typeof chatImageSchema>;
type SavedImage={name:string;mimeType:string;data:Buffer};
export type RunnerImage={name:string;mimeType:string;data:string};
type ChatImageParent={projectId:string;taskId?:string|null;actorId:string;messageId:string;scope:'assistant'|'manager'};

function matchesMagic(mimeType:string,buffer:Buffer){
 if(mimeType==='image/png')return buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 if(mimeType==='image/jpeg')return buffer.length>=4&&buffer[0]===255&&buffer[1]===216&&buffer[buffer.length-2]===255&&buffer[buffer.length-1]===217;
 if(mimeType==='image/webp')return buffer.length>=12&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP';
 return false;
}
export function validateChatImages(images:ChatImageInput[]):SavedImage[]{
 let total=0;
 return images.map(image=>{
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)||image.data.length%4!==0)
   throw Object.assign(new Error('Изображение повреждено или содержит некорректные данные'),{statusCode:400});
  const buffer=Buffer.from(image.data,'base64');
  total+=buffer.length;
  if(!buffer.length||buffer.length>MAX_CHAT_IMAGE_BYTES||total>MAX_CHAT_IMAGES_TOTAL_BYTES)
   throw Object.assign(new Error('Не более 4 изображений по 2 МБ, суммарно до 6 МБ'),{statusCode:413});
  if(!matchesMagic(image.mimeType,buffer))
   throw Object.assign(new Error('Поддерживаются только PNG, JPEG и WebP с корректным содержимым'),{statusCode:400});
  return {name:image.name,mimeType:image.mimeType,data:buffer};
 });
}
export async function initChatImages(pool:Pick<Pool,'query'>){
 await pool.query(`
  CREATE TABLE IF NOT EXISTS chat_images (
   id uuid PRIMARY KEY,
   project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
   task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
   assistant_message_id uuid REFERENCES assistant_messages(id) ON DELETE CASCADE,
   manager_message_id uuid REFERENCES manager_messages(id) ON DELETE CASCADE,
   actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
   name text NOT NULL,
   mime_type text NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/webp')),
   image_data bytea NOT NULL,
   created_at timestamptz NOT NULL DEFAULT now(),
   CONSTRAINT exactly_one_chat_message CHECK ((assistant_message_id IS NULL) <> (manager_message_id IS NULL))
  );
  CREATE INDEX IF NOT EXISTS idx_chat_images_assistant ON chat_images(assistant_message_id);
  CREATE INDEX IF NOT EXISTS idx_chat_images_manager ON chat_images(manager_message_id);
 `);
}
export async function saveChatImages(client:Pick<PoolClient,'query'>,parent:ChatImageParent,images:SavedImage[]){
 for(const image of images){
  await client.query(`INSERT INTO chat_images
   (id,project_id,task_id,assistant_message_id,manager_message_id,actor_id,name,mime_type,image_data)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[
    randomUUID(),parent.projectId,parent.taskId??null,
    parent.scope==='assistant'?parent.messageId:null,
    parent.scope==='manager'?parent.messageId:null,
    parent.actorId,image.name,image.mimeType,image.data
   ]);
 }
}
export async function readChatImages(pool:Pick<Pool,'query'>,projectId:string,messageId:string,scope:'assistant'|'manager'):Promise<RunnerImage[]>{
 const column=scope==='assistant'?'assistant_message_id':'manager_message_id';
 const rows=await pool.query(`SELECT name,mime_type,image_data FROM chat_images
  WHERE project_id=$1 AND ${column}=$2 ORDER BY created_at,id LIMIT $3`,[projectId,messageId,MAX_CHAT_IMAGES]);
 return rows.rows.map((row:{name:string;mime_type:string;image_data:Buffer})=>({
  name:row.name,mimeType:row.mime_type,data:row.image_data.toString('base64')
 }));
}
export function registerChatImageRoutes(app:FastifyInstance,deps:{
 pool:Pool;access:(req:any,reply:any,projectId:string)=>Promise<boolean>;
}){
 const {pool,access}=deps;
 app.get('/api/projects/:id/chat-images/:imageId',async(req:any,reply)=>{
  const {id,imageId}=z.object({id:z.string().uuid(),imageId:z.string().uuid()}).parse(req.params);
  if(!await access(req,reply,id))return;
  const image=await pool.query('SELECT name,mime_type,image_data FROM chat_images WHERE id=$1 AND project_id=$2',[imageId,id]);
  if(!image.rowCount)return reply.code(404).send({error:'Изображение не найдено'});
  const row=image.rows[0];
  return {name:row.name,mimeType:row.mime_type,data:(row.image_data as Buffer).toString('base64')};
 });
}
