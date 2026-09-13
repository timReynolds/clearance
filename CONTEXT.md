# Clearance

Clearance determines who must review a pull request and tracks whether the required approvals are current.

## Language

**Review requirement**:
An approval obligation derived from the ownership rules for the files changed by a pull request.

**Review transition**:
A change to a pull request's Clearance state together with the comments, statuses, reviewer requests,
and notifications that must follow that change. Acceptance means that all of this work is retained
for execution; it does not mean GitHub has completed it.

**Escalation**:
A warning, additional reviewer request, or fallback notification triggered by a review requirement
remaining pending beyond its configured time.
