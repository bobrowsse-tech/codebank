export const ACTIVATION_IDLE_MS = 150;
export const WALKTHROUGH_ACCEPTS = 3;

export function afterActivation(task: () => void): void {
  setTimeout(task, 0);
}

export function idleAfterActivation(elapsedMs: number, budget = ACTIVATION_IDLE_MS): boolean {
  return elapsedMs >= 0 && elapsedMs <= budget;
}

export function nextAcceptedCount(current: number): number {
  return current + 1;
}

export function walkthroughAcceptsComplete(count: number): boolean {
  return count >= WALKTHROUGH_ACCEPTS;
}
