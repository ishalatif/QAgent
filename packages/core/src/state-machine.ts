import type { RunStatus } from "#contracts";
import { TERMINAL_RUN_STATUSES } from "#contracts";

const RUN_STATUS_RANK: Record<RunStatus, number> = {
  CREATED: 0,
  VALIDATING: 1,
  RUNNING: 2,
  COMPLETED: 3,
  FAILED: 3,
  CANCELLED: 3
};

export class InvalidRunTransitionError extends Error {
  constructor(from: RunStatus, to: RunStatus) {
    super(`Invalid run status transition: ${from} -> ${to}`);
    this.name = "InvalidRunTransitionError";
  }
}

export function assertValidRunTransition(from: RunStatus, to: RunStatus): void {
  if (from === to) {
    return;
  }

  if (TERMINAL_RUN_STATUSES.has(from)) {
    throw new InvalidRunTransitionError(from, to);
  }

  if (RUN_STATUS_RANK[to] < RUN_STATUS_RANK[from]) {
    throw new InvalidRunTransitionError(from, to);
  }
}
