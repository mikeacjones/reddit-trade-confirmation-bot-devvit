/**
 * Drives the real Devvit Blocks app (src/main.ts) from a test.
 *
 * Importing src/main.ts registers every trigger, scheduler job, menu item and form on the
 * `Devvit` registry from @devvit/public-api. The harness reads that registry and calls the
 * registered handlers exactly as the Devvit runtime would, with a context built from the real
 * public-api clients. Where that context's capabilities come from:
 *
 *   redis, settings, scheduler -> the real public-api clients, backed by @devvit/test's mocks
 *   ui                         -> the real public-api UIClient (toasts and forms are recorded)
 *   reddit                     -> FakeReddit (tests/harness/redditFake.ts); the Reddit mock in
 *                                 @devvit/test does not implement comments, flair or moderators
 *
 * Use inside a test created with `createDevvitTest` (see tests/harness/scenario.ts); it provides
 * the per-test Devvit global and the capability mocks passed in as `mocks`.
 */
import { Devvit, type TriggerContext } from '@devvit/public-api'
import { makeAPIClients } from '@devvit/public-api/apis/makeAPIClients.js'
import type { DevvitFixtures } from '@devvit/test/server/vitest'
import { FakeReddit } from './redditFake.js'
// Registers triggers, jobs, menu items and forms on the Devvit registry.
import '../../src/main.js'

// The registry getters are internal to public-api, so they are not in its public types.
interface Registry {
  triggerOnEventHandlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<void>>>
  scheduledJobHandlers: Map<string, (event: unknown, ctx: unknown) => Promise<void>>
  menuItems: Array<{
    label: string
    location: string | string[]
    forUserType?: string
    onPress: (event: unknown, ctx: unknown) => Promise<void>
  }>
  formDefinitions: Map<string, {
    form: unknown
    onSubmit: (event: { values: Record<string, unknown> }, ctx: unknown) => Promise<void>
  }>
}

const registry = Devvit as unknown as Registry

export interface UiEffects {
  toasts: string[]
  forms: Array<{ id: string; title: string; fields: Array<{ name: string; defaultValue?: unknown }> }>
}

export interface AppHarness {
  /** The context handed to every handler. */
  ctx: TriggerContext
  reddit: FakeReddit
  mocks: DevvitFixtures['mocks']
  /** Fire a trigger such as 'CommentSubmit'; every handler registered for it runs, as in Devvit. */
  fireTrigger: (event: string, payload: Record<string, unknown>) => Promise<void>
  /** Run a scheduler job by name, as the scheduler would when it fires. */
  runJob: (name: string, data?: Record<string, unknown>) => Promise<void>
  /** Press a menu item by label. Returns the UI effects it produced. */
  pressMenuItem: (label: string, event?: { location?: string; targetId?: string }) => Promise<UiEffects>
  /** Submit a form that a menu item opened (see the `forms` of the effects from pressMenuItem). */
  submitForm: (formId: string, values: Record<string, unknown>) => Promise<UiEffects>
  /** All UI effects since the harness was created. */
  effects: () => UiEffects
  /** Names of the jobs registered in src/main.ts, for assertions on what is wired up. */
  registered: () => { triggers: string[]; jobs: string[]; menuItems: string[] }
  /**
   * Where a menu item shows and who sees it, as registered. Reddit enforces `forUserType` before
   * a press ever reaches the handler, so the harness cannot press as a non-moderator; a scenario
   * asserts the registration instead.
   */
  menuItemInfo: (label: string) => { location: string | string[]; forUserType?: string }
}

export interface StartAppOptions {
  mocks: DevvitFixtures['mocks']
  subredditName: string
  /** Moderators, trade-count flair templates etc. are seeded on `reddit` by the test. */
  reddit?: FakeReddit
}

export function startApp(options: StartAppOptions): AppHarness {
  const reddit = options.reddit ?? new FakeReddit({ subredditName: options.subredditName })
  const clients = makeAPIClients({ ui: true })
  const ui = clients.ui
  const ctx = {
    redis: clients.redis,
    settings: clients.settings,
    scheduler: clients.scheduler,
    media: clients.media,
    cache: clients.cache,
    assets: clients.assets,
    ui,
    reddit: reddit.client,
    subredditName: options.subredditName,
    subredditId: reddit.subredditId,
    appAccountId: reddit.appUser.id,
    userId: undefined,
    debug: {},
  } as unknown as TriggerContext

  const effectsOf = (): UiEffects => {
    // __effects is internal to UIClient; each entry is a protobuf-shaped effect.
    const raw = (ui as unknown as { __effects: Array<Record<string, any>> }).__effects
    const out: UiEffects = { toasts: [], forms: [] }
    for (const effect of raw) {
      if (effect.showToast) out.toasts.push(effect.showToast.toast.text)
      if (effect.showForm) {
        const form = effect.showForm.form
        out.forms.push({
          id: form.id,
          title: form.title,
          fields: form.fields.map((f: any) => ({
            name: f.fieldId,
            defaultValue: f.defaultValue?.stringValue ?? f.defaultValue?.numberValue ?? f.defaultValue?.boolValue,
          })),
        })
      }
    }
    return out
  }

  const since = (before: UiEffects): UiEffects => ({
    toasts: effectsOf().toasts.slice(before.toasts.length),
    forms: effectsOf().forms.slice(before.forms.length),
  })

  return {
    ctx,
    reddit,
    mocks: options.mocks,

    async fireTrigger(event, payload) {
      const handlers = registry.triggerOnEventHandlers.get(event)
      if (!handlers) throw new Error(`No trigger registered for ${event}`)
      const results = await Promise.allSettled(handlers.map(fn => fn({ ...payload, type: event }, ctx)))
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (failed) throw failed.reason
    },

    async runJob(name, data) {
      const handler = registry.scheduledJobHandlers.get(name)
      if (!handler) throw new Error(`No scheduler job registered named ${name}`)
      await handler({ name, data }, ctx)
    },

    async pressMenuItem(label, event = {}) {
      const item = registry.menuItems.find(m => m.label === label)
      if (!item) throw new Error(`No menu item labelled "${label}"`)
      const before = effectsOf()
      await item.onPress({ location: event.location ?? item.location, targetId: event.targetId ?? '' }, ctx)
      return since(before)
    },

    async submitForm(formId, values) {
      const definition = registry.formDefinitions.get(formId)
      if (!definition) throw new Error(`No form registered with id ${formId}`)
      const before = effectsOf()
      await definition.onSubmit({ values }, ctx)
      return since(before)
    },

    effects: effectsOf,

    registered: () => ({
      triggers: [...registry.triggerOnEventHandlers.keys()],
      jobs: [...registry.scheduledJobHandlers.keys()],
      menuItems: registry.menuItems.map(m => m.label),
    }),

    menuItemInfo(label) {
      const item = registry.menuItems.find(m => m.label === label)
      if (!item) throw new Error(`No menu item labelled "${label}"`)
      return { location: item.location, forUserType: item.forUserType }
    },
  }
}
