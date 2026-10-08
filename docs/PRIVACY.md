# Privacy Policy

**App:** Trade Confirmation Bot (`swap-bot`)
**Effective date:** October 8, 2026

This Privacy Policy explains how the Trade Confirmation Bot Reddit Devvit app (the “App”) collects, uses, stores, and shares information. It applies to moderators who install the App and to redditors whose public subreddit activity is processed by the App.

This policy describes the App developer’s practices for this App. It is not Reddit’s Privacy Policy and is not Discord’s Privacy Policy.

## 1. Information the App processes

### 1.1 Reddit content and account identifiers (public community data)

When installed in a subreddit, the App processes information available through Reddit/Devvit APIs that is needed to operate trade confirmation and moderation features, including:

- Subreddit name / id
- Post ids, titles, bodies (selftext), permalinks / URLs, flair, NSFW/spoiler flags, and timestamps
- Comment ids, bodies, permalinks, parent relationships, and authors
- Reddit usernames and user ids of authors and participants in confirmation flows
- User flair text and flair template metadata used to display trade counts
- Moderator usernames (cached) for moderator-only flair / approval behavior
- App configuration values set by moderators (message templates, keywords, locale, optional Discord webhook URL, optional monthly-post flair id)

The App does not ask end users to create a separate account with the developer, and it does not intentionally collect private messages, passwords, or payment information.

### 1.2 Installation settings

Moderators may store settings for their install, including an optional Discord webhook URL used only to send new-post notifications for that subreddit. Webhook URLs should be treated as secrets; anyone with the URL can post to the linked Discord channel.

### 1.3 Operational / technical data

Devvit may provide runtime logs and platform telemetry to the developer through Reddit’s developer tools (for example, install logs used for debugging). The App also uses Devvit Redis-backed storage for operational state such as:

- Trade / confirmation counts and processed-comment markers
- Current monthly post id and related scheduling state
- Cached flair templates and moderator lists

## 2. How the App uses information

The App uses the information above to:

- Create and maintain the monthly confirmation thread
- Validate and record trade confirmations and update flair
- Support moderator tools (rescan, manual count adjustment, cache refresh)
- Optionally notify a moderator-configured Discord channel about new posts
- Debug and maintain reliable App behavior

## 3. Sharing and third parties

### 3.1 Reddit

The App runs on Reddit’s Devvit platform. Reddit hosts App code execution and Redis data for installs. Reddit’s handling of platform data is governed by Reddit’s own policies.

### 3.2 Discord (optional, moderator-configured)

If a moderator configures **Mod new post Discord webhook**, then when a new post is submitted in that subreddit the App sends an HTTPS request to `discord.com` containing post metadata such as:

- Title, author username / id, subreddit, post id
- Post body (possibly truncated) or link URL
- Permalink, flair, NSFW/spoiler flags, and timestamps
- A structured JSON payload intended for automation listeners

That data is delivered to the Discord webhook / channel chosen by the installing moderators. The App developer does not receive a copy of Discord channel contents through this integration, and does not control Discord’s retention or access controls for that channel.

If the webhook setting is blank, the App does not call Discord.

### 3.3 No sale of personal data

The developer does not sell redditor personal information and does not use App data for advertising.

## 4. Retention

- Trade counts, confirmation markers, and related Redis state persist for the life of the App installation (or until cleared/overwritten by App logic, uninstallation, or platform deletion).
- Cached moderator / flair data is refreshed periodically and may expire according to App TTLs.
- Discord receives notification payloads only at send time; retention afterward is controlled by Discord and the server/channel owners.
- Platform logs retained in Reddit developer tooling follow Reddit’s retention for that tooling.

## 5. Access, correction, and deletion

Because the App primarily processes public subreddit content and install-scoped Redis state:

- Users can edit or delete their own Reddit posts/comments through Reddit.
- Moderators can uninstall the App, clear or change settings (including removing the Discord webhook), and use App menu actions to adjust stored trade counts.
- To request deletion or review of App-stored install data that you believe remains after uninstall, contact **mjones@kotrs.com** with the subreddit name and details. Some data may only be removable via Reddit platform processes outside the developer’s direct control.

## 6. Children

The App is intended for Reddit communities and is not directed at children under 13. Do not use the App to knowingly collect personal information from children.

## 7. International users

App processing occurs on infrastructure provided by Reddit (and, when enabled, Discord). If you use the App, information may be processed in the United States or other regions where those providers operate.

## 8. Changes to this policy

This policy may be updated by revising this document and changing the effective date. Material changes affecting Discord or other outbound sharing will be reflected here before or when the corresponding App version is published.

## 9. Contact

Message u/thisisreallytricky on Reddit

Related document: [Terms and Conditions](./TERMS.md)
