import {createHash,randomUUID} from 'node:crypto';
import {TextDecoder} from 'node:util';
import type {FastifyInstance} from 'fastify';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';

/** Conversation documents are immutable private blobs, not public URLs.
 * Uploaded content is never executed, unpacked or served as active HTML.
 */
export const MAX_CHAT_FILES=5;
export const MAX_CHAT_FILE_BYTES=2*1024*1024;
export const MAX_CHAT_FILES_TOTAL_BYTES=6*1024*1024;
export const CHAT_FILE_TYPES:Record<string,string>={
 txt:'text/plain',md:'text/markdown',csv:'text/csv',json:'application/json',
 yaml:'text/yaml',yml:'text/yaml',pdf:'application/pdf',
 docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
 xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
 pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
 zip:'application/zip'
};
const textExtensions=new Set(['txt','md','csv','json','yaml','yml']);
const zipExtensions=new Set(['docx','xlsx','pptx','zip']);
const utf8=new TextDecoder('utf-8',{fatal:true});
const base64Pattern=/^[A-Za-z0-9+/]+={0,2}$/;
const filenamePattern=/^[^/\\\x00-\x1f\x7f]{1,180}$/;
export const chatFileSchema=z.object({
 name:z.string().trim().min(1).max(180),
 mimeType:z.string().max(140),
 data:z.string().min(16).max(Math.ceil(MAX_CHAT_FILE_BYTES*4/3)+16)
}).strict();
export const chatFilesSchema=z.array(chatFileSchema).max(MAX_CHAT_FILES).default([]);
export type ChatFileInput=z.infer<typeof chatFileSchema>;
export type SavedChatFile={name:string;mimeType:string;bytes:Buffer;sha256:string;size:number};
const invalid=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
function extension(name:string){return name.split('.').at(-1)?.toLowerCase()||'';}
export function validateChatFiles(files:ChatFileInput[]):SavedChatFile[]{
 if(files.length>MAX_CHAT_FILES)throw invalid('Не более пяти файлов в одном сообщении');
 let total=0;
 return files.map(file=>{
  const ext=extension(file.name),mime=CHAT_FILE_TYPES[ext];
  if(!filenamePattern.test(file.name)||file.name==='.'||file.name==='..'||!mime)
   throw invalid('Разрешены файлы TXT, MD, CSV, JSON, YAML, PDF, DOCX, XLSX, PPTX, ZIP');
  if(!base64Pattern.test(file.data)||file.data.length%4!==0)
   throw invalid('Некорректные данные файла');
  const bytes=Buffer.from(file.data,'base64');
  total+=bytes.length;
  if(!bytes.length||bytes.length>MAX_CHAT_FILE_BYTES||total>MAX_CHAT_FILES_TOTAL_BYTES)
   throw invalid('Файлы: не более 2 МБ каждый и 6 МБ суммарно',413);
  const starts=(prefix:string)=>bytes.subarray(0,prefix.length).toString('latin1')===prefix;
  if(ext==='pdf'&&!starts('%PDF-'))throw invalid('Файл PDF имеет неверный формат');
  if(zipExtensions.has(ext)&&!starts('PK\x03\x04')&&!starts('PK\x05\x06'))
   throw invalid('Архив или Office-документ имеет неверный формат');
  if(textExtensions.has(ext)){
   try{utf8.decode(bytes);}catch{throw invalid('Текстовый файл должен быть в кодировке UTF-8');}
  }
  return {name:file.name,mimeType:mime,bytes,size:bytes.length,
   sha256:createHash('sha256').update(bytes).digest('hex')};
 });
}
export async function initChatFiles(db:Pick<Pool,'query'>){
 await db.query('CREATE TABLE IF NOT EXISTS chat_files('+
  'id uuid PRIMARY KEY,'+
  'project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,'+
  'assistant_message_id uuid NOT NULL REFERENCES assistant_messages(id) ON DELETE CASCADE,'+
  'actor_id uuid REFERENCES users(id) ON DELETE SET NULL,'+
  'name text NOT NULL,mime_type text NOT NULL,'+
  'size_bytes int NOT NULL CHECK(size_bytes>0 AND size_bytes<=2097152),'+
  'sha256 char(64) NOT NULL,file_data bytea NOT NULL,'+
  'created_at timestamptz NOT NULL DEFAULT now());'+
  'CREATE INDEX IF NOT EXISTS idx_chat_files_message ON chat_files(assistant_message_id,created_at,id);'+
  'CREATE INDEX IF NOT EXISTS idx_chat_files_project ON chat_files(project_id,id);');
}
export async function saveChatFiles(db:Pick<PoolClient,'query'>,input:{
 projectId:string;actorId:string;messageId:string;files:SavedChatFile[]
}){
 for(const file of input.files){
  await db.query('INSERT INTO chat_files '+
   '(id,project_id,assistant_message_id,actor_id,name,mime_type,size_bytes,sha256,file_data)'+
   ' VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[
   randomUUID(),input.projectId,input.messageId,input.actorId,
   file.name,file.mimeType,file.size,file.sha256,file.bytes
  ]);
 }
}
/** PM receives bounded readable data, not file paths or executable instructions.
 * Binary attachments remain safely downloadable and are not falsely parsed.
 */
export async function readPmChatFileContext(db:Pick<Pool,'query'>,projectId:string,messageId:string){
 const r=await db.query('SELECT name,mime_type,size_bytes,file_data FROM chat_files '+
  'WHERE project_id=$1 AND assistant_message_id=$2 ORDER BY created_at,id LIMIT $3',
  [projectId,messageId,MAX_CHAT_FILES]);
 return r.rows.map((row:any)=>{
  const name=String(row.name),bytes=row.file_data as Buffer;
  const ext=extension(name),readable=textExtensions.has(ext);
  const content=readable?utf8.decode(bytes.subarray(0,12000)):'';
  return {name,mimeType:String(row.mime_type),size:Number(row.size_bytes),readable,content};
 });
}
export function registerChatFileRoutes(app:FastifyInstance,deps:{
 pool:Pool;access:(req:any,reply:any,projectId:string)=>Promise<boolean>
}){
 app.get('/api/projects/:id/chat-files/:fileId',async(req:any,reply)=>{
  const {id,fileId}=z.object({id:z.string().uuid(),fileId:z.string().uuid()}).parse(req.params);
  if(!await deps.access(req,reply,id))return;
  const result=await deps.pool.query('SELECT name,mime_type,file_data FROM chat_files WHERE project_id=$1 AND id=$2',[id,fileId]);
  if(!result.rowCount)return reply.code(404).send({error:'Файл не найден'});
  const file=result.rows[0];
  const name=String(file.name).replace(/["\\\r\n]/g,'_');
  reply.header('Content-Type',String(file.mime_type));
  reply.header('Content-Disposition','attachment; filename="'+name.replace(/[^\x20-\x7e]/g,'_')+
   '"; filename*=UTF-8\'\''+encodeURIComponent(name));
  reply.header('Cache-Control','private, no-store');
  reply.header('X-Content-Type-Options','nosniff');
  reply.header('Content-Security-Policy','sandbox');
  return reply.send(file.file_data);
 });
}
