/**
 * Agent-driven MCP execution is the primary project chat mode.
 * The legacy regex dispatcher is an explicit emergency rollback only.
 */
export function agentRuntimeEnabled(value: string | undefined = process.env.AGENT_RUNTIME_ENABLED): boolean {
 return !['false','0','off','no'].includes(value?.trim().toLowerCase() ?? '');
}
