export type StageLog = (stage: string, direction: "in" | "out", data: unknown) => void;

let sink: StageLog = () => {};

export function setLogger(fn: StageLog): void {
  sink = fn;
}

export function logStage(stage: string, direction: "in" | "out", data: unknown): void {
  sink(stage, direction, data);
}
