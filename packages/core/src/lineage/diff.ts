export interface DiffEdit {
  op: "equal" | "delete" | "insert";
  line: string;
}

export function myersDiff(before: string[], after: string[]): DiffEdit[] {
  const max = before.length + after.length;
  const trace: Array<Map<number, number>> = [];
  const scores = new Map<number, number>([[1, 0]]);
  for (let depth = 0; depth <= max; depth += 1) {
    trace.push(new Map(scores));
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const down = (scores.get(diagonal + 1) ?? -1) > (scores.get(diagonal - 1) ?? -1);
      let x = diagonal === -depth || (diagonal !== depth && down) ? scores.get(diagonal + 1) ?? 0 : (scores.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      scores.set(diagonal, x);
      if (x >= before.length && y >= after.length) return backtrack(before, after, trace, depth);
    }
  }
  return [];
}

function backtrack(before: string[], after: string[], trace: Array<Map<number, number>>, depth: number): DiffEdit[] {
  const edits: DiffEdit[] = [];
  let x = before.length;
  let y = after.length;
  for (let d = depth; d > 0; d -= 1) {
    const scores = trace[d];
    const diagonal = x - y;
    const down = diagonal === -d || (diagonal !== d && (scores.get(diagonal - 1) ?? -1) < (scores.get(diagonal + 1) ?? -1));
    const previous = down ? diagonal + 1 : diagonal - 1;
    const previousX = scores.get(previous) ?? 0;
    const previousY = previousX - previous;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      edits.push({ op: "equal", line: before[x] });
    }
    if (down) {
      y -= 1;
      edits.push({ op: "insert", line: after[y] });
    } else {
      x -= 1;
      edits.push({ op: "delete", line: before[x] });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    edits.push({ op: "equal", line: before[x] });
  }
  while (x > 0) {
    x -= 1;
    edits.push({ op: "delete", line: before[x] });
  }
  while (y > 0) {
    y -= 1;
    edits.push({ op: "insert", line: after[y] });
  }
  return edits.reverse();
}
