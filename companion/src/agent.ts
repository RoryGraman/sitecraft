/**
 * Agent runner. Wraps the Claude Agent SDK.
 * STUB: the real implementation replaces the bodies below (see plan Task 5).
 */
import type { AgentRequest, AgentScriptOutput } from '@sitecraft/shared';
import type { Logger } from './log.js';

export interface AgentHooks {
  onProgress(status: string): void;
  /** Resolves the live outer HTML for a selector (already capped) or rejects. */
  inspectPage(selector: string): Promise<string>;
  signal?: AbortSignal;
}

export interface AgentRunOptions {
  model?: string;
  maxTurns?: number;
  cwd?: string;
  logger?: Logger;
}

export type RunAgentFn = (payload: AgentRequest, hooks: AgentHooks, opts?: AgentRunOptions) => Promise<AgentScriptOutput>;

export const runAgent: RunAgentFn = async (payload, hooks, opts) => {
  void payload;
  void hooks;
  void opts;
  throw new Error('not implemented');
};

/**
 * One-turn login check. Resolves { ok: true } when the model answers, or
 * { ok: false, detail } with the error text. Used by `checkAuth` and `doctor`.
 */
export async function checkClaudeLogin(opts: { timeoutMs?: number; model?: string; logger?: Logger } = {}): Promise<{ ok: boolean; detail: string }> {
  void opts;
  throw new Error('not implemented');
}
