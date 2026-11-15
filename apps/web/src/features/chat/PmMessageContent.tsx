import React from 'react';
import {DocumentMarkdown,pmDisplayText} from '../documentation/Markdown.js';
import {SecurePmScreenshot} from '../tasks/TaskPmScreenshotGallery.js';
import {parsePmScreenshotReferences} from './pm-screenshot-references.js';

/** Historical and new PM replies can reference an already stored Chromium
 * artifact. Render the existing protected image inline instead of expecting
 * a new capture in the same Codex turn or trusting the model's Markdown image.
 */
export function PmMessageContent({source,projectId,hasAttachments=false}:{
 source:string;projectId:string;hasAttachments?:boolean;
}){
 const {markdown,images}=parsePmScreenshotReferences(pmDisplayText(source),projectId);
 return <>
  <DocumentMarkdown source={markdown}/>
  {!hasAttachments&&images.length>0&&<div className="pm-inline-screenshots" aria-label="Скриншоты ПМ">
   {images.map(image=><SecurePmScreenshot key={image.artifactId}
    url={image.url} label={image.label} alt={image.label}/>)}
  </div>}
 </>;
}
