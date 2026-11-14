import type {extractGitHubDocumentLocation} from '../../../github-document-import.js';
/** Persisted analyzer request payload, independent of HTTP input validation. */
export type AnalystInput={
 mode:'project'|'documentation';
 attachments:Array<{name:string;body:string}>;
 documentId:string|null;
 location:ReturnType<typeof extractGitHubDocumentLocation>;
 questionId?:string;
 structureOnly?:boolean;
 rebuildSpec?:boolean;
 autonomous?:boolean;
 previousJobId?:string;
 requireChanges?:boolean;
 readProjectSource?:boolean;
};
