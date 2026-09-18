import type { CheckDecision } from "../checks/index.js";
import type { NotificationRecord } from "../resolution/index.js";
import type { ClearanceState } from "../state/index.js";

/** GitHub work accepted with a review-policy state change, executed asynchronously. */
export type ReviewTransitionEffect =
  | { type: "upsert-comment"; body: string }
  | { type: "post-comment"; body: string }
  | { type: "request-reviewers"; reviewers: string[] }
  | { type: "set-statuses"; decisions: CheckDecision[] }
  | { type: "send-notifications"; notifications: NotificationRecord[] };

export type ReviewTransition = {
  state: ClearanceState;
  effects: ReviewTransitionEffect[];
};
