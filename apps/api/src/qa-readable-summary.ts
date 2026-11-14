/**
 * What the owner reads must be derived from adjudicated QA evidence, never
 * from the model's self-reported "all tests passed" narrative. Technical
 * commands, stderr and full JSON remain in the stored QA report for agents.
 */
export type QaEvidenceStatus='passed'|'failed'|'blocked'|'not_run';
export type QaReadableEvidence={
 verdict?:string|null;
 caseResults?:Array<{result?:string;reason?:string;evidence?:string}>;
 checks?:Array<{name?:string;result?:string;details?:string}>;
 findings?:Array<{description?:string}>;
 staleSpecification?:boolean;
 evidenceIssue?:string;
};
const clean=(v:unknown,max=240)=>String(v??'').replace(/[\r\n\t]+/g,' ').replace(/\s{2,}/g,' ').trim().slice(0,max);
const technical=(v:string)=>/\[(?:qa-exec|Chromium\/Playwright)\]|(?:node \/opt\/codex-runner|\bexit_code\b|\bcase qa-\d+\b|\/bin\/bash -c)/i.test(v);
export function qaReadableSummary(report:QaReadableEvidence,expectedCount?:number):string{
 const cases=Array.isArray(report.caseResults)?report.caseResults:[];
 const checks=Array.isArray(report.checks)?report.checks:[];
 const findings=Array.isArray(report.findings)?report.findings:[];
 const total=Math.max(Number.isInteger(expectedCount)?expectedCount!:0,cases.length);
 const passed=cases.filter(c=>c.result==='passed').length;
 const failed=cases.filter(c=>c.result==='failed').length;
 const blocked=Math.max(0,total-passed-failed);
 const checkFailures=checks.filter(c=>c.result==='failed').length;
 const verdict=report.verdict==='failed'||failed>0||checkFailures>0||findings.length>0?'failed':
  report.verdict==='passed'&&blocked===0&&total>0?'passed':'blocked';
 const counts=total?passed+' из '+total+' сценариев пройдено'+(failed?', '+failed+' с ошибкой':'')+
  (blocked?', '+blocked+' не проверено':'')+'.':'Нет подтверждённых результатов проверок.';
 if(report.staleSpecification)
  return 'Результаты QA устарели: во время проверки изменились требования или версия кода. '+counts+' Проверку нужно повторить на актуальной версии.';
 const issue=clean(report.evidenceIssue,240);
 const finding=clean(findings.find(f=>!!clean(f.description))?.description,240);
 const failedCheck=checks.find(c=>c.result==='failed');
 const checkName=clean(failedCheck?.name,100);
 const rawDetail=clean(failedCheck?.details,180);
 const checkDetail=rawDetail&&!technical(rawDetail)?': '+rawDetail:'';
 const firstFailure=cases.find(c=>c.result==='failed');
 const caseDetail=clean(firstFailure?.evidence,180);
 const reason=issue||finding||(failedCheck?'Не прошла проверка «'+checkName+'»'+checkDetail:
  caseDetail&&!technical(caseDetail)?caseDetail:'');
 if(verdict==='passed')
  return 'QA завершён успешно: '+counts;
 if(verdict==='failed')
  return 'QA обнаружил проблему: '+counts+(reason?' Причина: '+reason+'.':' Требуется исправление и повторная проверка.');
 return 'QA не смог полностью проверить результат: '+counts+
  (reason?' Причина: '+reason+'.':' Нужны доступная среда и подтверждённые результаты.') ;
}
