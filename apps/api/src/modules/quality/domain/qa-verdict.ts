import {z} from 'zod';
import {checkedWithActualCapabilities} from '../../../qa-evidence.js';

/** Pure assessment of QA evidence for a specific, reviewed specification.
 *
 * No database access, Temporal APIs or external Runner calls. A browser
 * claim alone cannot make a visual acceptance criterion pass.
 */
type Snapshot={
 singlePass?:boolean;
 adHoc?:boolean;
 simplified?:boolean;
 cases?:Array<{id:string;title?:string;description?:string;area?:string;execution_mode?:string;steps?:Array<{action?:string;expected?:string}>}>;
};
type CurrentSpecification={
 rowCount:number|null;
 rows:Array<{spec_version:number;spec_review_status:string;spec_reviewed_version:number;spec_reviewed_commit:string|null}>;
};
type RemoteQaResult={
 cases?:unknown;
 caseResults?:unknown;
 capabilities?:string;
 verdict?:string;
 checks?:Array<{result?:string}>|unknown;
 findings?:unknown;
 executionVerified?:boolean;
 testedCommit?:string|null;
 screenshots?:unknown;
 summary?:string;
};
type EvaluateQaRunInput={
 snapshot:Snapshot|null|undefined;
 remote:RemoteQaResult;
 status:string;
 message:string;
 qaSpecVersion:number;
 currentSpec:CurrentSpecification;
};

export function evaluateQaRun({snapshot,remote,status,message,qaSpecVersion,currentSpec}:EvaluateQaRunInput){
 const singlePass=snapshot?.singlePass===true;
 const adHoc=singlePass&&snapshot?.adHoc===true;
 const expected=adHoc?z.array(z.object({id:z.string().regex(/^qa-[1-9][0-9]?$/),title:z.string().trim().min(3).max(240)})).max(30).safeParse(remote.cases??[]):null;
 const cases:Array<{id:string;title?:string}>=adHoc
  ?[...new Map((expected?.success?expected.data:[]).map(item=>[item.id,item])).values()]
  :Array.isArray(snapshot?.cases)?snapshot.cases:[];
 const provided=Array.isArray(remote.caseResults)?remote.caseResults:[];
 const providedMap=new Map<string,{result:string;evidence:string;reason:string;browserVerified:boolean}>();
 for(const item of provided){
  if(typeof item?.case_id==='string'&&typeof item?.result==='string'&&['passed','failed','blocked','not_run'].includes(item.result)){
   const evidence=String(item.evidence||'').slice(0,3000).trim();
   const reason=String(item.reason||'unknown').slice(0,60);
   providedMap.set(item.case_id,{result:item.result==='passed'&&evidence.length<10?'blocked':item.result,evidence,reason,browserVerified:item.browserVerified===true});
  }
 }
 const supplied=cases.map(c=>{
  const candidate=providedMap.get(c.id);
  return {case_id:c.id,result:candidate?.result||'not_run',reason:candidate?.reason||'unknown',
   evidence:candidate?.evidence||'Нет подтверждённого результата',browserVerified:candidate?.browserVerified===true};
 });
 const {cases:checked,visualToolGap}=checkedWithActualCapabilities(cases,supplied,String(remote.capabilities||''));
 let verdict=status==='failed'?'blocked':String(remote.verdict||'blocked');
 const spec=currentSpec.rows[0];
 const staleSpecification=!currentSpec.rowCount||spec.spec_version!==qaSpecVersion||
  spec.spec_review_status!=='current'||spec.spec_reviewed_version!==spec.spec_version||
  (snapshot?.simplified===true&&remote.testedCommit!==spec.spec_reviewed_commit);
 if(!cases.length||!remote.testedCommit||!Array.isArray(remote.checks))verdict='blocked';
 if(checked.some(c=>c.result==='failed')||(Array.isArray(remote.checks)&&remote.checks.some(c=>c?.result==='failed'))||
    (Array.isArray(remote.findings)&&remote.findings.length>0))verdict='failed';
 else if((checked.some(c=>c.result!=='passed')||visualToolGap||singlePass&&!remote.executionVerified)&&verdict==='passed')
  verdict='blocked';
 // A changed specification invalidates the entire run, including old failures.
 if(staleSpecification)verdict='blocked';
 const ran=checked.filter(c=>c.result==='passed'||c.result==='failed').length;
 const outcome=singlePass&&status==='completed'?'Проверено '+ran+' из '+cases.length+'.':message;
 const screenshots=Array.isArray(remote.screenshots)?remote.screenshots.filter((s:any)=>s?.mime==='image/jpeg'&&
   typeof s.data==='string'&&s.data.length<=450000&&/^[A-Za-z0-9+/=]+$/.test(s.data)).slice(0,3):[];
 const report={
  screenshots,summary:remote.summary||outcome,executionVerified:remote.executionVerified===true,
  findings:remote.findings||[],checks:remote.checks||[],caseResults:checked,
  capabilities:String(remote.capabilities||'').slice(0,1500),commit:remote.testedCommit||null,
  spec_version:qaSpecVersion,staleSpecification
 };
 return {adHoc,cases,checked,verdict,outcome,report};
}
