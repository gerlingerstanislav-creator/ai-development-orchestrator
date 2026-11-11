const runnerAssistantLimit=24000;

/** The caller orders sections by priority so supporting material cannot push out the assignment. */
export function runnerAssistantPrompt(...sections:string[]){
 return sections.filter(Boolean).join('\n\n').slice(0,runnerAssistantLimit);
}
