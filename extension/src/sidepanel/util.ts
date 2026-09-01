import type { SidebarRequest, SidebarState } from '@sitecraft/shared';
import type { Bridge } from '../lib/bridge';

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(0, max - 3))}...` : s;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Requests whose reply is the full SidebarState. */
export type StateMutation = Extract<
  SidebarRequest,
  {
    type:
      | 'keepScript'
      | 'undoScript'
      | 'toggleScript'
      | 'setPriority'
      | 'updateCode'
      | 'updateScript'
      | 'deleteScript'
      | 'clearError'
      | 'setOnboardingDone';
  }
>;

/** Send a mutating request and hand the returned state to the app. */
export async function mutate(bridge: Bridge, req: StateMutation, onState: (state: SidebarState) => void): Promise<void> {
  const state: SidebarState = await bridge.request(req);
  onState(state);
}
