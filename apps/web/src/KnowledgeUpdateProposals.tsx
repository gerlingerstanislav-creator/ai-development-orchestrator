import React,{useEffect,useState} from 'react';
type Request=(path:string,options?:RequestInit)=>Promise<any>;
type Proposal={id:string;document_id:string;document_title:string;task_ids:string[];proposed_body:string;reason:string;base_version:string;created_at:string};
export function KnowledgeUpdateProposals({projectId,documentId,request,onApplied}:{projectId:string;documentId:string;request:Request;onApplied:()=>Promise<void>}){
 const [items,setItems]=useState<Proposal[]>([]);
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);
 useEffect(()=>{let live=true;
  request('/projects/'+projectId+'/knowledge/update-proposals?document_id='+documentId)
   .then(v=>{if(live)setItems(v.proposals||[]);})
   .catch(e=>{if(live)setError(e instanceof Error?e.message:String(e));});
  return()=>{live=false;};
 },[projectId,documentId,request]);
 async function decide(id:string,decision:'approve'|'reject'){
  setBusy(true);setError('');
  try{
   await request('/projects/'+projectId+'/knowledge/update-proposals/'+id+'/decision',
    {method:'POST',body:JSON.stringify({decision})});
   const latest=await request('/projects/'+projectId+'/knowledge/update-proposals?document_id='+documentId);
   setItems(latest.proposals||[]);
   if(decision==='approve')await onApplied();
  }catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{setBusy(false);}
 }
 if(!items.length&&!error)return null;
 return <div className="knowledge-proposals">
  <strong>Предложения по обновлению документации ({items.length})</strong>
  {items.map(p=><details key={p.id}>
   <summary>{p.reason} · {new Date(p.created_at).toLocaleString('ru-RU')}</summary>
   <p className="muted">Сформировано после слияния PR. Проверь изменения на соответствие требованиям до применения.</p>
   <pre>{p.proposed_body}</pre>
   <div className="docs-actions">
    <button type="button" className="primary" disabled={busy} onClick={()=>void decide(p.id,'approve')}>Принять</button>
    <button type="button" className="secondary" disabled={busy} onClick={()=>void decide(p.id,'reject')}>Отклонить</button>
   </div>
  </details>)}
  {error&&<p role="alert" className="error">{error}</p>}
 </div>;
}
