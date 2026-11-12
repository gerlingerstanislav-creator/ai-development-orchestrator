/** Pure display normalization shared by the process read model and legacy recovery. */
export function developmentProcessDetail(message:string){
 return message.replace('Codex изменяет код','Изменяет код').replace('Codex не создал файлы.','Файлы не изменились.');
}
