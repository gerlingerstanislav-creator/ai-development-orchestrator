/**
 * Agent-driven MCP execution is the primary project chat mode.
 * There is no text-keyword fallback. Disabling this flag fails closed: the
 * product must not secretly reinterpret user commands through hardcoded regexes.
 */
export function agentRuntimeEnabled(value: string | undefined = process.env.AGENT_RUNTIME_ENABLED): boolean {
 return !['false','0','off','no'].includes(value?.trim().toLowerCase() ?? '');
}
