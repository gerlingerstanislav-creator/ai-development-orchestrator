import type {Pool} from 'pg';

export type PullRequestEvidence={commitSha:string;patch:string;summary:string};

/** Project-scoped, bounded GitHub PR evidence reader for analysis and QA.
 * It intentionally never stores token plaintext or changes task/process state.
 * HTTP transport is injectable so response and timeout policies are testable.
 */
export function createPrEvidenceReader(
 db:Pick<Pool,'query'>,
 decrypt:(encrypted:string)=>string,
 http:typeof fetch=fetch
){
async function prEvidence(projectId:string,taskId:string):Promise<{commitSha:string;patch:string;summary:string}>{
 const task=await db.query('SELECT pr_number,git_branch FROM tasks WHERE id=$1 AND project_id=$2',[taskId,projectId]);
 if(!task.rowCount)throw Error('Задача не найдена');
 if(!task.rows[0].pr_number)return {commitSha:'',patch:'PR ещё не создан',summary:''};
 const gh=await db.query("SELECT g.repository,c.secret_encrypted FROM project_git_repositories g JOIN connections c ON c.id=g.connection_id WHERE g.project_id=$1 AND c.provider='github_token'",[projectId]);
 if(!gh.rowCount)throw Error('GitHub-подключение для анализа PR не найдено');
 const repository=gh.rows[0].repository,token=decrypt(gh.rows[0].secret_encrypted);
 const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator'};
 const base='https://api.github.com/repos/'+repository+'/pulls/'+task.rows[0].pr_number;
 const [prResponse,filesResponse]=await Promise.all([
  http(base,{headers,signal:AbortSignal.timeout(20000)}),
  http(base+'/files?per_page=65',{headers,signal:AbortSignal.timeout(20000)})
 ]);
 if(!prResponse.ok||!filesResponse.ok)throw Error('Не удалось прочитать актуальные изменения PR в GitHub для сверки требований');
 const pr=await prResponse.json() as any,files=await filesResponse.json() as any[];
 if(!Array.isArray(files))throw Error('Некорректный ответ GitHub о файлах PR');
 const patch=files.map(file=>file.filename+' ('+file.status+')\n'+String(file.patch||'[diff недоступен]').slice(0,3800)).join('\n\n').slice(0,16500);
 return {commitSha:String(pr.head?.sha||''),patch:patch||'Нет текстовых изменений',summary:String(pr.body||'').slice(0,2000)};
}
 return prEvidence;
}
