# Trade Confirmation Bot

A Reddit Devvit app that tracks completed trades for swap subreddits. When two users confirm a trade in the monthly thread, the bot replies and bumps each user's trade count via flair.

## How it works

- **Monthly thread.** On the 1st of each month at 00:00 UTC the bot creates a stickied submission, unstickies the previous month's, and modmails the sub.
- **Confirmations.** When someone replies `confirmed` (case-insensitive substring) to a top-level comment in the current monthly thread, the bot validates it (the parent must tag the confirmer's username, the parent author must not be the confirmer, etc.), bumps trade counts for both users, applies updated flair, and replies.
- **Mod approvals.** A moderator can post `approved` as a reply to a confirmation comment to count it manually.
- **Lock-down.** On the 5th of each month at 00:00 UTC, all old (non-stickied) bot-authored threads in the sub get locked.

## Installation

You must moderate the target subreddit. From this directory:

```bash
npm install
npx devvit upload
npx devvit install <subreddit>
```

To deploy a new version later: `npx devvit upload && npx devvit install <subreddit> --update`.

## First-time setup

After install, complete these steps in order.

### 1. Create user-flair templates

Trade counts are stored in Redis but displayed via Reddit user flair. The bot looks for flair templates whose text contains the marker `Trades: N-M` (where `N` and `M` are integers); when a user's count falls in `[N, M]`, the bot assigns that template and substitutes the count for `N-M` in the displayed flair.

**Easiest path** — let the bot create defaults:

1. Open the subreddit page as a moderator.
2. Click the three-dot menu and pick **Set up default user flairs**.
3. The bot creates eleven templates: ten count-range templates (`Trades: 0-99`, `Trades: 100-199`, …, `Trades: 800-899`, `Trades: 900-99999`) plus a mod-only template (`Moderator | Trades: 0-99999`). Each count-range template is assigned a random background color with the text color (light or dark) chosen automatically for contrast. The mod template uses Reddit's standard mod-green background. This is one-time only — running it again is a no-op.

You can then edit the templates' colors, emoji, and surrounding text in Reddit's flair settings as long as you keep the `Trades: N-M` marker intact.

**Custom flair text** — the marker can sit anywhere in the template, so all of these work:

- `Trades: 0-99`
- `:trade-emoji: Trades: 0-99 :verified:`
- `Verified Swapper · Trades: 0-99`

When applied, the bot replaces the `0-99` part with the actual count, e.g. `Verified Swapper · Trades: 7`.

**Moderator flair (gotcha).** Templates also have a `modOnly` flag. The bot only assigns a `modOnly` template to moderators and only assigns a non-mod template to non-moderators. The default seeding includes a single `Moderator | Trades: 0-99999` mod-only template so every mod gets the same flair regardless of count; if you want count-based flair for mods too, create additional mod-only templates with the `Trades: N-M` marker.

### 2. Customize app settings

Open the app's settings page in mod tools. Every field is pre-populated with a working default — change only what you want to override.

| Setting | Purpose |
| --- | --- |
| **Monthly post title** | strftime-style template for the title (see placeholders below). |
| **Monthly post body** | Body of the stickied monthly thread. |
| **Trade confirmation reply** | What the bot replies after a successful confirmation. |
| **Already-confirmed reply** | Reply when a confirmation is attempted on a comment that's already been confirmed. |
| **Can't-confirm-username reply** | Reply when the parent comment doesn't tag the confirmer with `u/`. |
| **Old-thread reply** | Reply when someone tries to confirm in a previous month's locked thread. |
| **Optional submission flair ID** | Link-flair template ID to apply to the monthly post. Leave blank to skip. |

#### Title placeholders

The title accepts strftime-style tokens:

| Token | Example (September 14, 2026) |
| --- | --- |
| `%B` | `September` |
| `%b` | `Sep` |
| `%Y` | `2026` |
| `%y` | `26` |
| `%m` | `09` |
| `%d` | `14` |

Default: `%B %Y Confirmed Trade Thread` → `September 2026 Confirmed Trade Thread`.

#### Body placeholders

Body and reply templates use `{name}` substitution (and `{name.subname}` for nested fields). Anything that doesn't match a known variable is left as literal text.

**Monthly post body** has access to:

- `{bot_name}` — the bot account's username
- `{subreddit_name}`
- `{previous_month_submission.title}`
- `{previous_month_submission.permalink}`

**Trade confirmation reply** has access to:

- `{comment_id}` — id of the confirmer's comment
- `{confirmer}` — username of the confirmer
- `{parent_author}` — username of the user being confirmed
- `{old_comment_flair}`, `{new_comment_flair}` — confirmer's flair before and after
- `{old_parent_flair}`, `{new_parent_flair}` — parent author's flair before and after

**Already-confirmed / can't-confirm-username / old-thread replies** have access to:

- `{author_name}` — the confirmer's username
- `{id}` — the confirmer's comment id
- `{permalink}` — link to the confirmer's comment
- `{body}` — the confirmer's comment body
- `{parent_author}` — username of the parent comment's author
- `{parent_comment_id}` — id of the parent comment

### 3. (Optional) Trigger the first monthly post

The cron creates the next monthly post automatically on the 1st. If you want a thread up immediately, use **Trigger monthly post now** (see below).

## Moderator menu items

All accessible from the subreddit's three-dot menu. Mods only.

| Item | Effect |
| --- | --- |
| **Trigger monthly post now** | Runs the monthly-post job immediately (creates a new post, or re-stickies an existing one for this month). |
| **Lock old threads now** | Runs the lock-old-threads job immediately. Locks all non-stickied bot-authored posts. |
| **Re-scan monthly post comments** | Walks all comments in the current monthly post and processes any that the bot's `CommentSubmit` trigger missed. Idempotent — already-processed comments are skipped via a Redis dedup flag. |
| **Set up default user flairs** | One-time creation of the ten default `Trades: N-M` flair templates (see step 1). |

## Local development

```bash
npm install
npm test                                # rules + templates unit tests
npx devvit playtest <test-subreddit>    # hot-reload against a real sub
```
