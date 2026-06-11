# Durable Confirmation Workflow Plan

## Goal

Rewrite confirmation processing around a Redis-backed durable work queue and state machine.

Redis is the source of truth for trade counts and confirmation state. Reddit flair text is not read during normal confirmation processing. The only permitted flair read is a controlled "pull in missing user" workflow for a user with no Redis count yet; after that read, Redis is updated and becomes authoritative for that user.

The Devvit app should be treated as short-lived event and scheduler invocations. It should never require a single invocation to run to completion for correctness.

## Core Properties

- `CommentSubmit` and rescan paths enqueue work; they do not directly mutate user counts or write flair.
- A scheduled worker polls Redis for due work and advances each item one durable step at a time.
- Count commits are atomic for both users and the confirmation claim.
- Reddit writes are at-least-once side effects guarded by persisted effect state and idempotency checks.
- Replies describe the immutable transition caused by that specific confirmation, even if Redis counts have since advanced.
- Flair writes use current Redis count as a guard so stale work never writes a lower flair over a newer count.

## Redis Keys

```text
work:ready
  Sorted set. member = workId, score = nextAttemptAt epoch millis.

work:item:<workId>
  JSON work item with event metadata, status, attempts, nextAttemptAt, and lastError.

work:poller:lease
  Short TTL global worker lease. Prevents overlapping pollers from doing substantial work.

work:lease:<workId>
  Short TTL item lease. Prevents concurrent processing of the same work item.

confirmed:<parentCommentId>
  Canonical confirmation claim and immutable count transition record.

confirmations:<usernameLower>
  Authoritative trade count for the user.

userFlairLock:<subredditLower>:<usernameLower>
  Existing per-user flair write lock.

userBootstrap:<subredditLower>:<usernameLower>
  Optional guard for the controlled missing-user pull-in workflow.
```

## Work Item Shape

```ts
interface ConfirmationWorkItem {
  workId: string
  kind: 'confirmation-comment'
  commentId: string
  postId: string
  subredditName: string
  enqueuedAt: string
  status: 'queued' | 'running' | 'complete' | 'failed'
  attempts: number
  nextAttemptAt: number
  lastError?: string
}
```

The work item stores immutable event facts only. It must not store pre-read user counts from enqueue time because queue latency could make them stale before processing.

## Confirmation Claim Shape

```ts
interface ConfirmationClaimRecord {
  commentId: string
  replyToCommentId: string
  parentCommentId: string
  subredditName: string
  parentAuthor: string
  confirmer: string
  modApproval: boolean

  parentPreviousCount: number
  parentCount: number
  confirmerPreviousCount: number
  confirmerCount: number

  effects: {
    parentFlair: EffectState
    confirmerFlair: EffectState
    reply: EffectState
  }

  createdAt: string
  updatedAt: string
}

type EffectState =
  | { status: 'pending' }
  | { status: 'applied'; at: string }
  | { status: 'posted'; at: string; replyId?: string }
  | { status: 'superseded'; at: string; currentCount: number }
  | { status: 'failed'; at: string; error: string; attempts: number }
```

`parentPreviousCount`, `parentCount`, `confirmerPreviousCount`, and `confirmerCount` are immutable after the Redis transaction commits. Reply rendering must use these values, not the current Redis count at recovery time.

## Sequence Diagram

```mermaid
sequenceDiagram
  autonumber
  participant Reddit
  participant Trigger as Devvit CommentSubmit
  participant Redis
  participant Scheduler as Devvit Scheduler
  participant Worker
  participant RedditAPI as Reddit API

  Reddit->>Trigger: CommentSubmit(commentId)
  Trigger->>Redis: SET work:item:<workId> NX
  Trigger->>Redis: ZADD work:ready now workId
  Trigger->>Scheduler: runJob(process-confirmation-work, runAt soon)
  Trigger-->>Reddit: Return quickly

  Scheduler->>Worker: process-confirmation-work
  Worker->>Redis: SET work:poller:lease NX EX
  alt poller lease denied
    Worker-->>Scheduler: Exit
  else poller lease acquired
    Worker->>Redis: ZRANGE work:ready due items
    Worker->>Redis: SET work:lease:<workId> NX EX
    alt item lease denied
      Worker->>Redis: Skip item
    else item lease acquired
      Worker->>Redis: GET work:item:<workId>
      Worker->>RedditAPI: Fetch comment, parent, post, bot user as needed
      Worker->>Worker: Validate confirmation
      opt user count missing and pull-in enabled
        Worker->>Redis: SET userBootstrap:<user> NX EX
        Worker->>RedditAPI: Read current user flair once
        Worker->>Redis: SET confirmations:<user> parsedCount NX
      end
      Worker->>Redis: WATCH confirmed:<parentCommentId>, confirmations:<parent>, confirmations:<confirmer>
      Worker->>Redis: MULTI claim confirmation and set both incremented counts
      Redis-->>Worker: EXEC success with immutable old/new counts

      Worker->>Redis: GET confirmed:<parentCommentId>
      Worker->>Redis: SET userFlairLock:<parent> NX EX
      Worker->>Redis: GET confirmations:<parent>
      alt current count equals committed parent count
        Worker->>RedditAPI: Write parent flair text
        Worker->>Redis: Mark parentFlair applied
      else current count is newer
        Worker->>Redis: Mark parentFlair superseded
      end

      Worker->>Redis: SET userFlairLock:<confirmer> NX EX
      Worker->>Redis: GET confirmations:<confirmer>
      alt current count equals committed confirmer count
        Worker->>RedditAPI: Write confirmer flair text
        Worker->>Redis: Mark confirmerFlair applied
      else current count is newer
        Worker->>Redis: Mark confirmerFlair superseded
      end

      Worker->>RedditAPI: Check bot replies for deterministic marker
      alt matching reply already exists
        Worker->>Redis: Mark reply posted
      else no matching reply
        Worker->>RedditAPI: Submit reply rendered from immutable old/new counts
        Worker->>Redis: Mark reply posted
      end

      Worker->>Redis: ZREM work:ready workId
      Worker->>Redis: SET work:item:<workId> complete
    end
  end
```

## Worker Cadence

Target cadence: 30 checks per minute, using a two-second poll interval if Devvit production scheduler supports that safely.

The worker must still be bounded:

```ts
const WORKER_BUDGET_MS = 20_000
const WORKER_POLL_INTERVAL_MS = 2_000
const POLLER_LEASE_TTL_MS = 30_000
const ITEM_LEASE_TTL_MS = 45_000
const MAX_ITEMS_PER_RUN = 5
```

If a worker fails before explicitly requeueing, the item remains in `work:ready`; once `work:lease:<workId>` expires, a later poller can resume it. Explicit requeue is an optimization, not the recovery guarantee.

## Step Wrapper

Use a small durability helper for pure-ish workflow steps:

```ts
async function runStep<T>(
  ctx: WorkflowContext,
  claimKey: string,
  stepName: string,
  run: () => Promise<T>,
): Promise<T>
```

Behavior:

- If the step is already recorded complete, return the recorded result.
- If not complete, run it.
- Persist the output or effect status before moving to the next step.
- For external Reddit writes, the step must include an idempotency check before writing.

This is not deterministic Temporal replay. It is persisted step completion plus idempotent side effects.

## Processing Rules

### Enqueue

- `CommentSubmit` creates `workId = confirmation-comment:<commentId>`.
- Enqueue uses `SET work:item:<workId> ... NX` so duplicate events collapse.
- Rescan can enqueue the same workId without duplicating work.
- Manual approval should likely enqueue a different kind, for example `manual-confirmation:<commentId>`.

### Validation

- The worker fetches current Reddit objects needed to validate the event.
- Invalid confirmations are marked complete with a rejection reply effect if needed.
- Old-thread, self-confirmation, and already-confirmed replies should use the same durable reply effect pattern.

### Count Commit

- Count commit uses Redis `WATCH` over:
  - `confirmed:<parentCommentId>`
  - `confirmations:<parentAuthorLower>`
  - `confirmations:<confirmerLower>`
- If `confirmed:<parentCommentId>` exists for the same triggering comment, replay the stored transition.
- If it exists for another triggering comment, this work is complete with already-confirmed behavior.
- Missing Redis counts are handled by policy:
  - If pull-in is enabled, run the controlled bootstrap workflow once.
  - Otherwise use `0`.
- Commit both users' new counts and the confirmation claim in one transaction.

### Flair Effects

- Flair text is only written.
- Before writing a committed flair, read current Redis count.
- If current Redis count is greater than the committed count, mark the effect `superseded` and do not write.
- If current Redis count equals the committed count, write the exact committed flair text.
- If current Redis count is lower, treat that as inconsistent state and fail/retry or dead-letter.

### Reply Effect

- Reply text is rendered from immutable committed transition fields.
- The reply must include or derive a deterministic marker tied to `confirmed:<parentCommentId>` or `workId`.
- Before submitting, fetch replies to the target comment and check for the bot marker.
- If found, mark posted.
- If not found, submit and mark posted.

## Missing User Pull-In

This is the only permitted Reddit flair read.

Open policy to confirm:

- Automatic: if a confirmation participant has no `confirmations:<user>` key, the worker reads that user's current flair once, writes the parsed count into Redis with `NX`, and then commits the confirmation from that count.
- Manual/import only: normal confirmation processing treats missing Redis as `0`; mods can run import or a user-specific pull-in action separately.

In either policy, Reddit flair text is never used after the Redis count exists.

## Implementation Phases

1. Add plan and agree on open questions.
2. Add Redis queue primitives and tests:
   - enqueue
   - due item listing
   - global poller lease
   - item lease
   - backoff
3. Add scheduler job:
   - `process-confirmation-work`
   - optional event-side nudge with a Redis guard so only one near-term worker is scheduled
4. Convert `CommentSubmit` and rescan to enqueue-only paths.
5. Move confirmation validation and count commit into the worker.
6. Add durable effect tracking for flair writes and replies.
7. Add reply dedupe by deterministic marker.
8. Add missing-user pull-in workflow according to the chosen policy.
9. Convert manual approval into queued work.
10. Add admin visibility:
    - list pending work
    - retry failed work
    - dead-letter after repeated failure
11. Remove old direct-processing paths once tests cover the new workflow.

## Open Questions

1. Should missing-user pull-in happen automatically during confirmation processing, or only via manual/import action?
2. What reply marker is acceptable? A visible `Confirmation ID: ...` line is reliable; hidden HTML comments may be stripped by Reddit.
3. Is a two-second cron acceptable in production for this app, or should we combine a slower cron sweeper with one-off `runAt` nudges?
4. After repeated failure, should work dead-letter silently, notify mods by modmail, or expose only a moderator menu action?
5. Should manual trade-count adjustments also go through the queue, or can they remain direct because they are explicitly moderator initiated?
6. Should already-confirmed rejection replies also be durable/deduped, or is that only required for successful confirmation replies?
