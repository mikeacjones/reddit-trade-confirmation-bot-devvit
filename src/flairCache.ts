import { type FlairTemplate } from './rules.js'
import { redditApiCall, type RedditApiContext } from './redditApi.js'
import { expirationFromNow } from './utils.js'

const FLAIR_TEMPLATE_CACHE_TTL_MS = 12 * 60 * 60 * 1000

type FlairTemplateContext = RedditApiContext

interface CachedFlairTemplate extends FlairTemplate {
  min: number
  max: number
}

export async function loadFlairTemplates(
  ctx: FlairTemplateContext,
  subredditName: string,
): Promise<Map<[number, number], FlairTemplate>> {
  const cached = await ctx.redis.get(flairTemplateCacheKey(subredditName))
  if (cached) {
    const parsed = parseCachedFlairTemplates(cached)
    if (parsed) {
      console.debug(`Flair template cache hit for r/${subredditName} (${parsed.size} templates)`)
      return parsed
    }
  }

  console.debug(`Flair template cache miss for r/${subredditName}`)
  return refreshFlairTemplateCache(ctx, subredditName)
}

export async function refreshFlairTemplateCache(
  ctx: FlairTemplateContext,
  subredditName: string,
): Promise<Map<[number, number], FlairTemplate>> {
  const sub = await redditApiCall(ctx, () => ctx.reddit.getSubredditByName(subredditName), `get subreddit ${subredditName}`)
  const templates = await redditApiCall(ctx, () => sub.getUserFlairTemplates(), `get flair templates for r/${subredditName}`)
  const cached: CachedFlairTemplate[] = []
  const RANGE = /Trades: (\d+)-(\d+)/
  for (const t of templates) {
    const m = t.text.match(RANGE)
    if (!m) continue
    cached.push({
      min: parseInt(m[1], 10),
      max: parseInt(m[2], 10),
      id: t.id,
      template: t.text,
      modOnly: t.modOnly ?? false,
    })
  }
  await ctx.redis.set(flairTemplateCacheKey(subredditName), JSON.stringify(cached), {
    expiration: expirationFromNow(FLAIR_TEMPLATE_CACHE_TTL_MS),
  })
  console.debug(`Flair template cache refreshed for r/${subredditName} (${cached.length} templates)`)
  return flairTemplateMap(cached)
}

function parseCachedFlairTemplates(value: string): Map<[number, number], FlairTemplate> | null {
  try {
    const parsed = JSON.parse(value) as CachedFlairTemplate[]
    if (!Array.isArray(parsed)) return null
    if (!parsed.every(isCachedFlairTemplate)) return null
    return flairTemplateMap(parsed)
  } catch {
    return null
  }
}

function isCachedFlairTemplate(value: unknown): value is CachedFlairTemplate {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.min === 'number' &&
    typeof candidate.max === 'number' &&
    typeof candidate.id === 'string' &&
    typeof candidate.template === 'string' &&
    typeof candidate.modOnly === 'boolean'
}

function flairTemplateMap(templates: CachedFlairTemplate[]): Map<[number, number], FlairTemplate> {
  const result = new Map<[number, number], FlairTemplate>()
  for (const t of templates) {
    result.set([t.min, t.max], {
      id: t.id,
      template: t.template,
      modOnly: t.modOnly,
    })
  }
  return result
}

function flairTemplateCacheKey(subredditName: string): string {
  return `flairTemplates:${subredditName.toLowerCase()}`
}
