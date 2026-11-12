/**
 * Transport boundary between Temporal activities and the Codex Runner.
 * This module owns request serialization, authentication, timeouts and HTTP
 * errors. Domain-specific job state and retry decisions stay in the caller.
 */
export type RunnerHttpMethod = 'GET' | 'POST';

export type RunnerHttpClientOptions = {
 baseUrl: string;
 secret: string;
 timeoutMs?: number;
 fetchImpl?: typeof fetch;
};

export class RunnerHttpError extends Error {
 readonly statusCode: number;
 constructor(message: string, statusCode: number) {
  super(message);
  this.name = 'RunnerHttpError';
  this.statusCode = statusCode;
 }
}

export function createRunnerHttpClient({
 baseUrl,
 secret,
 timeoutMs = 25_000,
 fetchImpl = fetch
}: RunnerHttpClientOptions) {
 return async function request<T = unknown>(
  path: string,
  method: RunnerHttpMethod = 'GET',
  body?: unknown
 ): Promise<T> {
  const response = await fetchImpl(baseUrl + path, {
   method,
   headers: {'X-Runner-Secret': secret, 'Content-Type': 'application/json'},
   body: body === undefined ? undefined : JSON.stringify(body),
   signal: AbortSignal.timeout(timeoutMs)
  });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
   const error = data !== null && typeof data === 'object' && 'error' in data
    ? (data as {error: unknown}).error
    : undefined;
   throw new RunnerHttpError(String(error || 'Codex runner error'), response.status);
  }
  return data as T;
 };
}
