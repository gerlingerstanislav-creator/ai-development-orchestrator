/**
 * GitHub repository preflight: validate the selected token can push.
 * Keeps original error/status conventions used by project binding.
 */
export async function inspectGithubRepository(token:string,name:string) {
 const controller=new AbortController();
 const timeout=setTimeout(()=>controller.abort(),12000);
 try {
  const response=await fetch('https://api.github.com/repos/'+name,{
   headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator'},
   signal:controller.signal
  });
  if(response.status===401)throw Object.assign(new Error('Токен GitHub недействителен'),{statusCode:400});
  if(response.status===403)throw Object.assign(new Error('GitHub запретил доступ: проверь разрешения токена и лимиты'),{statusCode:400});
  if(response.status===404)throw Object.assign(new Error('Репозиторий не найден или токен не имеет к нему доступа'),{statusCode:400});
  if(!response.ok)throw Object.assign(new Error('GitHub вернул HTTP '+response.status),{statusCode:502});
  const data=await response.json() as any;
  if(data.full_name?.toLowerCase()!==name.toLowerCase() || data.archived || data.disabled)throw Object.assign(new Error('Репозиторий недоступен для работы'),{statusCode:400});
  if(data.permissions?.push!==true)throw Object.assign(new Error('Токен не имеет права записи в репозиторий. Выдай Contents: Read and write и Metadata: Read'),{statusCode:400});
  return {name:data.full_name as string,branch:data.default_branch as string,canPush:data.permissions?.push===true,private:data.private===true};
 }finally{clearTimeout(timeout);}
}
