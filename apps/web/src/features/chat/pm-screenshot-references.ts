/** References to private screenshots already stored by the trusted PM Chromium bridge.
 * This parser does not trust the model's image bytes or external URLs. The
 * screenshot endpoint independently authenticates project access.
 */
export type PmScreenshotReference={
 artifactId:string;taskId:string;url:string;label:string;
};
const uuid='[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}';
const artifactPath='(/api/projects/('+uuid+')/tasks/('+uuid+')/pm-browser-artifacts/('+uuid+'))';
// Accept both Markdown images and links, including PM's historic escaped
// parenthesis form: ![Desktop]\(/api/...) and [Mobile]\( /api/... ).
const referencePattern=new RegExp('!?\\[([^\\]\\r\\n]{1,180})\\]\\s*\\\\?\\(\\s*'+artifactPath+'\\s*\\\\?\\)','gi');

export function parsePmScreenshotReferences(source:string,projectId:string){
 const images:PmScreenshotReference[]=[];
 const seen=new Set<string>();
 const markdown=source.replace(referencePattern,(full,label:string,url:string,project:string,taskId:string,artifactId:string)=>{
  if(project.toLowerCase()!==projectId.toLowerCase())return full;
  const id=artifactId.toLowerCase();
  if(!seen.has(id)&&images.length<8){
   seen.add(id);
   images.push({artifactId:id,taskId,url,label:label.trim()});
  }
  return '';
 }).replace(/^[ \t]*[-*+][ \t]*$/gm,'').replace(/\n[ \t]*\n[ \t]*\n/g,'\n\n');
 return {markdown,images};
}
