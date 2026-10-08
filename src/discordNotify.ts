import type { PostSubmit } from '@devvit/protos'
import type { TriggerContext } from '@devvit/public-api'

export const MOD_NEW_POST_DISCORD_WEBHOOK_SETTING = 'mod_new_post_discord_webhook'

/** Marker bots can grep for when monitoring Discord. */
export const REDDIT_NEW_POST_EVENT = 'reddit.new_post'

const DISCORD_CONTENT_LIMIT = 2000
const EMBED_DESCRIPTION_LIMIT = 1500
const BODY_JSON_LIMIT = 1200

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
  bodyTruncated: boolean
  isSelf: boolean
  nsfw: boolean
  spoiler: boolean
  linkFlair: string | null
  createdAt: string
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

export function buildRedditNewPostPayload(event: PostSubmit): RedditNewPostPayload | null {
  const post = event.post
  if (!post?.id) return null

  const bodySource = post.selftext ?? ''
  const { text: body, truncated: bodyTruncated } = truncateText(bodySource, BODY_JSON_LIMIT)
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
    body,
    bodyTruncated: bodyTruncated || bodySource.length > BODY_JSON_LIMIT,
    isSelf: Boolean(post.isSelf),
    nsfw: Boolean(post.nsfw),
    spoiler: Boolean(post.isSpoiler),
    linkFlair: post.linkFlair?.text?.trim() || null,
    createdAt: createdAtIso(post.createdAt),
  }
}

export function buildDiscordWebhookBody(payload: RedditNewPostPayload): {
  content: string
  embeds: Array<Record<string, unknown>>
  allowed_mentions: { parse: [] }
} {
  const jsonBlock = ['```json', JSON.stringify(payload, null, 2), '```'].join('\n')
  const header = `**New post in r/${payload.subreddit || 'unknown'}** · \`${payload.event}\``
  let content = `${header}\n${jsonBlock}`
  if (content.length > DISCORD_CONTENT_LIMIT) {
    const overhead = header.length + '\n```json\n\n```'.length
    const maxJson = Math.max(200, DISCORD_CONTENT_LIMIT - overhead)
    const compact = JSON.stringify(payload)
    const { text } = truncateText(compact, maxJson)
    content = `${header}\n\`\`\`json\n${text}\n\`\`\``
  }

  const bodyForEmbed = truncateText(payload.body || (payload.isSelf ? '' : payload.url), EMBED_DESCRIPTION_LIMIT).text
  const authorName = payload.author ? `u/${payload.author}` : 'unknown'
  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: 'Author', value: authorName, inline: true },
    { name: 'Post ID', value: payload.postId || 'unknown', inline: true },
    { name: 'Type', value: payload.isSelf ? 'text' : 'link', inline: true },
  ]
  if (payload.linkFlair) {
    fields.push({ name: 'Flair', value: payload.linkFlair, inline: true })
  }
  if (payload.bodyTruncated) {
    fields.push({ name: 'Body', value: 'Truncated for Discord limits — open the post for full text.', inline: false })
  }

  return {
    content,
    embeds: [
      {
        title: truncateText(payload.title || '(no title)', 256).text,
        url: payload.permalink || payload.url || undefined,
        description: bodyForEmbed || undefined,
        author: {
          name: authorName,
          url: payload.author ? `https://www.reddit.com/user/${payload.author}/` : undefined,
        },
        fields,
        footer: { text: `${payload.event} · r/${payload.subreddit || 'unknown'}` },
        timestamp: payload.createdAt,
        color: 0xff4500,
      },
    ],
    allowed_mentions: { parse: [] },
  }
}

export async function onPostSubmit(event: PostSubmit, ctx: TriggerContext): Promise<void> {
  const configured = (await ctx.settings.get<string>(MOD_NEW_POST_DISCORD_WEBHOOK_SETTING))?.trim()
  if (!configured) return

  if (!isDiscordWebhookUrl(configured)) {
    console.warn('Mod new post Discord webhook setting is set but is not a valid Discord webhook URL')
    return
  }

  const payload = buildRedditNewPostPayload(event)
  if (!payload) {
    console.warn('PostSubmit missing post data; skipping Discord notification')
    return
  }

  const webhookUrl = normalizeDiscordWebhookUrl(configured)
  const body = buildDiscordWebhookBody(payload)

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const responseText = await response.text().catch(() => '')
      console.warn(
        `Discord webhook failed for ${payload.postId}: ${response.status} ${response.statusText}${responseText ? ` — ${responseText.slice(0, 200)}` : ''}`,
      )
    }
  } catch (error) {
    console.warn(
      `Discord webhook request failed for ${payload.postId}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
