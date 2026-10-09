import type { PostSubmit } from '@devvit/protos'
import type { TriggerContext } from '@devvit/public-api'
import { getLanguageSettings } from './language.js'
import { redditApiCall } from './redditApi.js'
import { parseTradeCount } from './rules.js'
import { errorText } from './utils.js'

export const MOD_NEW_POST_DISCORD_WEBHOOK_SETTING = 'mod_new_post_discord_webhook'
export const MOD_NEW_POST_DISCORD_INCLUDE_JSON_SETTING = 'mod_new_post_discord_include_json'

/** Marker bots can grep for when monitoring Discord. */
export const REDDIT_NEW_POST_EVENT = 'reddit.new_post'

/** Filename automation should look for among the message attachments. */
export const REDDIT_NEW_POST_ATTACHMENT = 'reddit_new_post.json'

const BODY_PREVIEW_LIMIT = 900
const MAX_GALLERY_IMAGES = 4
const REDDIT_ORANGE = 0xff4500

const IS_COMPONENTS_V2 = 1 << 15
const COMPONENT_ACTION_ROW = 1
const COMPONENT_BUTTON = 2
const COMPONENT_TEXT_DISPLAY = 10
const COMPONENT_MEDIA_GALLERY = 12
const COMPONENT_FILE = 13
const COMPONENT_SEPARATOR = 14
const COMPONENT_CONTAINER = 17
const BUTTON_STYLE_LINK = 5

export interface RedditNewPostPayload {
  event: typeof REDDIT_NEW_POST_EVENT
  postId: string
  title: string
  author: string
  authorId: string
  subreddit: string
  subredditId: string
  permalink: string
  url: string
  body: string
  isSelf: boolean
  nsfw: boolean
  spoiler: boolean
  linkFlair: string | null
  imageUrls: string[]
  createdAt: string
  authorTradeCount: number | null
  authorFlair: string | null
  authorAccountCreatedAt: string | null
  authorPostKarma: number | null
  authorCommentKarma: number | null
}

export interface AuthorProfile {
  tradeCount: number | null
  flair: string | null
  accountCreatedAt: string | null
  postKarma: number | null
  commentKarma: number | null
}

export const EMPTY_AUTHOR_PROFILE: AuthorProfile = {
  tradeCount: null,
  flair: null,
  accountCreatedAt: null,
  postKarma: null,
  commentKarma: null,
}

export function isDiscordWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:') return false
    if (url.hostname !== 'discord.com' && url.hostname !== 'discordapp.com') return false
    return /^\/api\/webhooks\/\d+\/[\w-]+\/?$/.test(url.pathname)
  } catch {
    return false
  }
}

export function normalizeDiscordWebhookUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.hostname === 'discordapp.com') url.hostname = 'discord.com'
  url.hash = ''
  url.search = ''
  return url.toString().replace(/\/$/, '')
}

export function validateDiscordWebhookSetting(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !isDiscordWebhookUrl(value)) {
    return 'Enter a Discord webhook URL (https://discord.com/api/webhooks/…), or leave blank to disable.'
  }
  return undefined
}

export function absoluteRedditUrl(pathOrUrl: string): string {
  const value = pathOrUrl.trim()
  if (!value) return ''
  if (value.startsWith('http://') || value.startsWith('https://')) return value
  return `https://www.reddit.com${value.startsWith('/') ? value : `/${value}`}`
}

export function truncateText(text: string, maxLength: number): { text: string; truncated: boolean } {
  if (text.length <= maxLength) return { text, truncated: false }
  const ellipsis = '…'
  return { text: text.slice(0, Math.max(0, maxLength - ellipsis.length)) + ellipsis, truncated: true }
}

function createdAtIso(createdAt: number | undefined): string {
  if (!createdAt || !Number.isFinite(createdAt)) return new Date().toISOString()
  const ms = createdAt > 1e12 ? createdAt : createdAt * 1000
  return new Date(ms).toISOString()
}

const IMAGE_URL_PATTERN = /\.(jpe?g|png|gif|webp)(\?|$)/i

export function collectImageUrls(post: NonNullable<PostSubmit['post']>): string[] {
  const candidates = [
    ...(post.galleryImages ?? []),
    ...(post.mediaUrls ?? []),
    ...(post.isImage || IMAGE_URL_PATTERN.test(post.url ?? '') ? [post.url] : []),
  ]
  const urls = candidates
    .map(url => (url ?? '').replace(/&amp;/g, '&').trim())
    .filter(url => url.startsWith('https://'))
  return [...new Set(urls)]
}

export function buildRedditNewPostPayload(
  event: PostSubmit,
  profile: AuthorProfile = EMPTY_AUTHOR_PROFILE,
): RedditNewPostPayload | null {
  const post = event.post
  if (!post?.id) return null

  const permalink = absoluteRedditUrl(post.permalink || post.url || '')
  const url = absoluteRedditUrl(post.url || post.permalink || '')

  return {
    event: REDDIT_NEW_POST_EVENT,
    postId: post.id,
    title: post.title ?? '',
    author: event.author?.name ?? '',
    authorId: event.author?.id || post.authorId || '',
    subreddit: event.subreddit?.name ?? '',
    subredditId: event.subreddit?.id || post.subredditId || '',
    permalink,
    url,
    body: post.selftext ?? '',
    isSelf: Boolean(post.isSelf),
    nsfw: Boolean(post.nsfw),
    spoiler: Boolean(post.isSpoiler),
    linkFlair: post.linkFlair?.text?.trim() || null,
    imageUrls: collectImageUrls(post),
    createdAt: createdAtIso(post.createdAt),
    authorTradeCount: profile.tradeCount,
    authorFlair: profile.flair,
    authorAccountCreatedAt: profile.accountCreatedAt,
    authorPostKarma: profile.postKarma,
    authorCommentKarma: profile.commentKarma,
  }
}

/** Each lookup is best-effort so a Reddit API hiccup never blocks the notification. */
export async function loadAuthorProfile(
  ctx: TriggerContext,
  subredditName: string,
  username: string,
): Promise<AuthorProfile> {
  const profile: AuthorProfile = { ...EMPTY_AUTHOR_PROFILE }
  if (!username) return profile

  try {
    const stored = await ctx.redis.get(`confirmations:${username.toLowerCase()}`)
    const parsed = stored === undefined ? NaN : parseInt(stored, 10)
    if (Number.isFinite(parsed)) profile.tradeCount = parsed
  } catch (error) {
    console.debug(`Could not read stored trade count for u/${username}: ${errorText(error)}`)
  }

  try {
    const user = await redditApiCall(ctx, () => ctx.reddit.getUserByUsername(username), `get user u/${username}`)
    if (user) {
      profile.accountCreatedAt = user.createdAt.toISOString()
      profile.postKarma = user.linkKarma
      profile.commentKarma = user.commentKarma
      if (subredditName) {
        const flair = await redditApiCall(ctx, () => user.getUserFlairBySubreddit(subredditName),
          `get flair for u/${username} in r/${subredditName}`)
        profile.flair = flair?.flairText?.trim() || null
        if (profile.tradeCount === null) {
          const { flairCountLabel } = await getLanguageSettings(ctx)
          profile.tradeCount = parseTradeCount(profile.flair, flairCountLabel)
        }
      }
    }
  } catch (error) {
    console.debug(`Could not load Reddit profile for u/${username}: ${errorText(error)}`)
  }

  return profile
}

export function formatAccountAge(createdAtIso: string, now: Date = new Date()): string {
  const created = new Date(createdAtIso)
  let months = (now.getUTCFullYear() - created.getUTCFullYear()) * 12 + (now.getUTCMonth() - created.getUTCMonth())
  if (now.getUTCDate() < created.getUTCDate()) months--
  if (months >= 12) {
    const years = Math.floor(months / 12)
    const rest = months % 12
    return rest > 0 ? `${years}y ${rest}mo` : `${years}y`
  }
  if (months >= 1) return `${months}mo`
  const days = Math.max(0, Math.floor((now.getTime() - created.getTime()) / 86_400_000))
  return `${days}d`
}

export type DiscordComponent = Record<string, unknown>

export interface DiscordWebhookBody {
  flags: number
  components: DiscordComponent[]
  attachments?: Array<{ id: number; filename: string; description: string }>
  allowed_mentions: { parse: [] }
}

const text = (content: string): DiscordComponent => ({ type: COMPONENT_TEXT_DISPLAY, content })
const separator = (): DiscordComponent => ({ type: COMPONENT_SEPARATOR, divider: true, spacing: 1 })
const linkButton = (label: string, url: string): DiscordComponent => ({ type: COMPONENT_BUTTON, style: BUTTON_STYLE_LINK, label, url })

export function oldRedditUrl(permalink: string): string | null {
  try {
    const url = new URL(permalink)
    if (!/(^|\.)reddit\.com$/.test(url.hostname)) return null
    url.hostname = 'old.reddit.com'
    return url.toString()
  } catch {
    return null
  }
}

export function escapeDiscordMarkdown(value: string): string {
  return value.replace(/([\\`*_~|[\]<>])/g, '\\$1')
}

export function buildDiscordWebhookBody(
  payload: RedditNewPostPayload,
  options: { includeJson?: boolean } = {},
): DiscordWebhookBody {
  const subreddit = payload.subreddit || 'unknown'
  const profileUrl = payload.author ? `https://www.reddit.com/user/${payload.author}/` : ''
  const postedAt = Math.floor(new Date(payload.createdAt).getTime() / 1000)

  const flair = payload.linkFlair ? `\`${payload.linkFlair.replace(/`/g, "'")}\` ` : ''
  const authorLink = payload.author ? `[u/${escapeDiscordMarkdown(payload.author)}](${profileUrl})` : 'unknown author'
  const badges = [payload.nsfw && '**NSFW**', payload.spoiler && '**Spoiler**'].filter(Boolean)
  const titleBlock = [
    `-# New post in r/${escapeDiscordMarkdown(subreddit)} · \`${payload.event}\``,
    `## [${escapeDiscordMarkdown(truncateText(payload.title || '(no title)', 200).text)}](${payload.permalink || payload.url})`,
    [`${flair}${authorLink}`, `<t:${postedAt}:R>`, ...badges].join(' · '),
  ].join('\n')

  const tradeLine = payload.authorTradeCount === null
    ? 'Confirmed trades: **unknown**'
    : `**${payload.authorTradeCount}** confirmed ${payload.authorTradeCount === 1 ? 'trade' : 'trades'}`
  const flairLine = payload.authorFlair ? ` · flair \`${payload.authorFlair.replace(/`/g, "'")}\`` : ''
  const accountParts: string[] = []
  if (payload.authorAccountCreatedAt) accountParts.push(`Account **${formatAccountAge(payload.authorAccountCreatedAt)}** old`)
  if (payload.authorPostKarma !== null && payload.authorCommentKarma !== null) {
    accountParts.push(
      `**${formatNumber(payload.authorPostKarma + payload.authorCommentKarma)}** karma ` +
      `(${formatNumber(payload.authorPostKarma)} post · ${formatNumber(payload.authorCommentKarma)} comment)`,
    )
  }
  const traderBlock = [`${tradeLine}${flairLine}`, accountParts.join(' · ')].filter(Boolean).join('\n')

  const card: DiscordComponent[] = [text(titleBlock), separator(), text(traderBlock)]

  const preview = payload.body
    ? truncateText(payload.body, BODY_PREVIEW_LIMIT)
    : { text: payload.isSelf ? '' : payload.url, truncated: false }
  if (preview.text) {
    card.push(separator(), text(`${preview.text}${preview.truncated ? '\n-# Preview truncated — open the post for the full text.' : ''}`))
  }

  if (payload.imageUrls.length > 0) {
    card.push({
      type: COMPONENT_MEDIA_GALLERY,
      items: payload.imageUrls.slice(0, MAX_GALLERY_IMAGES).map(url => ({ media: { url }, spoiler: payload.nsfw || payload.spoiler })),
    })
  }

  const buttons = [linkButton('Open post', payload.permalink || payload.url)]
  if (payload.author) {
    buttons.push(
      linkButton('Author profile', profileUrl),
      linkButton('Message author', `https://www.reddit.com/message/compose/?to=${encodeURIComponent(payload.author)}`),
    )
  }
  card.push({ type: COMPONENT_ACTION_ROW, components: buttons })

  // Webhook buttons can only open URLs; old Reddit shows inline remove/spam/approve controls to moderators.
  const modButtons = []
  const oldRedditPost = oldRedditUrl(payload.permalink)
  if (oldRedditPost) modButtons.push(linkButton('Remove (old Reddit)', oldRedditPost))
  if (payload.subreddit) {
    modButtons.push(linkButton('Mod queue', `https://www.reddit.com/r/${encodeURIComponent(payload.subreddit)}/about/modqueue/`))
  }
  if (modButtons.length > 0) card.push({ type: COMPONENT_ACTION_ROW, components: modButtons })

  // Components V2 discards attachments that no component references, so the JSON file must be shown.
  if (options.includeJson) {
    card.push({ type: COMPONENT_FILE, file: { url: `attachment://${REDDIT_NEW_POST_ATTACHMENT}` } })
  }

  const body: DiscordWebhookBody = {
    flags: IS_COMPONENTS_V2,
    components: [{ type: COMPONENT_CONTAINER, accent_color: REDDIT_ORANGE, components: card }],
    allowed_mentions: { parse: [] },
  }
  if (options.includeJson) {
    body.attachments = [{ id: 0, filename: REDDIT_NEW_POST_ATTACHMENT, description: payload.event }]
  }
  return body
}

/** Builds the multipart/form-data request Discord expects when a webhook message carries a file. */
export function buildDiscordMultipartRequest(
  body: DiscordWebhookBody,
  payload: RedditNewPostPayload,
  boundary = `----swapbot${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`,
): { contentType: string; body: string } {
  const parts = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="payload_json"',
    'Content-Type: application/json',
    '',
    JSON.stringify(body),
    `--${boundary}`,
    `Content-Disposition: form-data; name="files[0]"; filename="${REDDIT_NEW_POST_ATTACHMENT}"`,
    'Content-Type: application/json',
    '',
    JSON.stringify(payload, null, 2),
    `--${boundary}--`,
    '',
  ]
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: parts.join('\r\n') }
}

/** Execute-webhook URL that enables Components V2 and makes Discord report rejected messages. */
export function discordExecuteUrl(webhookUrl: string): string {
  const url = new URL(webhookUrl)
  url.searchParams.set('with_components', 'true')
  url.searchParams.set('wait', 'true')
  return url.toString()
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}

export async function onPostSubmit(event: PostSubmit, ctx: TriggerContext): Promise<void> {
  const configured = (await ctx.settings.get<string>(MOD_NEW_POST_DISCORD_WEBHOOK_SETTING))?.trim()
  if (!configured) {
    console.debug('Mod new post Discord webhook not configured; skipping Discord notification')
    return
  }

  if (!isDiscordWebhookUrl(configured)) {
    console.warn('Mod new post Discord webhook setting is set but is not a valid Discord webhook URL')
    return
  }

  if (!event.post?.id) {
    console.warn('PostSubmit missing post data; skipping Discord notification')
    return
  }
  const profile = await loadAuthorProfile(ctx, event.subreddit?.name ?? '', event.author?.name ?? '')
  const payload = buildRedditNewPostPayload(event, profile)!

  const webhookUrl = discordExecuteUrl(normalizeDiscordWebhookUrl(configured))
  const includeJson = (await ctx.settings.get<boolean>(MOD_NEW_POST_DISCORD_INCLUDE_JSON_SETTING)) === true
  const body = buildDiscordWebhookBody(payload, { includeJson })
  const request = includeJson
    ? buildDiscordMultipartRequest(body, payload)
    : { contentType: 'application/json', body: JSON.stringify(body) }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': request.contentType },
      body: request.body,
    })
    if (!response.ok) {
      const responseText = await response.text().catch(() => '')
      console.warn(
        `Discord webhook failed for ${payload.postId}: ${response.status} ${response.statusText}${responseText ? ` — ${responseText.slice(0, 200)}` : ''}`,
      )
      return
    }
    const sent = (await response.json().catch(() => null)) as { attachments?: unknown[] } | null
    const stored = Array.isArray(sent?.attachments) ? sent.attachments.length : 'unknown'
    console.log(
      `Sent Discord new-post notification for ${payload.postId} (${response.status}, json ${includeJson ? 'on' : 'off'}, attachments stored: ${stored})`,
    )
  } catch (error) {
    console.warn(
      `Discord webhook request failed for ${payload.postId}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
