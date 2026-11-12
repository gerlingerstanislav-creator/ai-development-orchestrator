import {isVisualAcceptanceCase as sharedVisualCase} from './qa-visual-case.mjs';
/**
 * The test agent's natural-language claim is not evidence of having run a
 * browser. A static CSS/code inspection cannot satisfy a visual acceptance
 * case if there is no browser/visual test tool in the actual runner.
 */
export type VisualCase={id:string;title?:string;description?:string;area?:string;execution_mode?:string;steps?:Array<{action?:string;expected?:string}>};
export type ReportedCase={case_id:string;result:string;reason:string;evidence:string;browserVerified?:boolean};
export function isVisualAcceptanceCase(test:VisualCase):boolean{return sharedVisualCase(test);}

export function browserPresent(capabilities:string):boolean{
 return /(?:^|\n)(?:(?:chromium|chromium-browser|google-chrome): available|qa_browser: playwright chromium available)(?:\n|$)/.test(capabilities);
}
export function checkedWithActualCapabilities(
 expected:VisualCase[],reported:ReportedCase[],capabilities:string
):{cases:ReportedCase[];visualToolGap:boolean}{
 const byId=new Map(reported.map(r=>[r.case_id,r]));
 let visualToolGap=false;
 const cases=expected.map(test=>{
  const current=byId.get(test.id)||{case_id:test.id,result:'not_run',reason:'unknown',evidence:'Нет подтверждённого результата'};
  if(current.result==='passed'&&isVisualAcceptanceCase(test)&&browserPresent(capabilities)
    &&!(current.reason==='executed'&&current.browserVerified===true)){
   visualToolGap=true;
   return {case_id:test.id,result:'blocked',reason:'unverified',
    evidence:'Chromium доступен, но для визуального критерия «'+String(test.title||test.id).slice(0,130)+'» нет подтверждённой выполненной browser-client assert-команды. Нужна повторная браузерная проверка.'};
  }
  if(current.result==='passed'&&isVisualAcceptanceCase(test)&&!browserPresent(capabilities)){
   visualToolGap=true;
   return {
    case_id:test.id,result:'blocked',reason:'tool_unavailable',
    evidence:'В среде QA нет Chromium/Chrome и рабочего браузерного стенда. Проверка реального отображения «'+String(test.title||test.id).slice(0,130)+'» не запускалась; просмотр исходного кода не равен визуальному тесту.'
   };
  }
  if(isVisualAcceptanceCase(test)&&['blocked','not_run'].includes(current.result)&&!browserPresent(capabilities)){
   visualToolGap=true;
   if(['tool_unavailable','environment_unavailable','manual_only'].includes(current.reason)&&current.evidence.length>=15)
    return current;
   return {case_id:test.id,result:'blocked',reason:'tool_unavailable',
    evidence:'В контейнере отсутствует браузерный тестовый стенд Chromium/Chrome. Сценарий «'+String(test.title||test.id).slice(0,130)+'» не проверен визуально.'};
  }
  return current;
 });
 return {cases,visualToolGap};
}
