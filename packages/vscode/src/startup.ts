export const ACTIVATION_IDLE_MS = 150;

export function afterActivation(task: () => void): void {
  setTimeout(task, 0);
}

export function idleAfterActivation(elapsedMs: number, budget = ACTIVATION_IDLE_MS): boolean {
  return elapsedMs >= 0 && elapsedMs <= budget;
}
