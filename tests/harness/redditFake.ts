/**
 * One small stateful fake of the Reddit API surface this app uses, shared by every scenario test.
 *
 * `@devvit/test` ships a Reddit plugin mock, but it only implements users, subreddit-about and
 * posts: comments, flair, moderators and modmail throw "not mocked". This fake covers exactly the
 * `ctx.reddit` calls made by src/ and keeps state (users, posts, comments, flair templates, user
 * flair, moderators, modmail) so a scenario can seed it, run a handler, and assert on what the bot
 * did. Tests never hand-mock individual methods.
 */

export interface FakeUser {
  id: string
  name: string
  createdAt: Date
  linkKarma: number
  commentKarma: number
}

export interface PostRecord {
  id: string
  title: string
  body: string
  authorName: string
  authorId: string
  subredditName: string
  createdAt: Date
  locked: boolean
  stickied: boolean
  removed: boolean
  spam: boolean
  archived: boolean
  removedByCategory?: string
  suggestedSort?: string
  flairId?: string
}

export interface CommentRecord {
  id: string
  parentId: string
  postId: string
  authorName: string
  body: string
  removed: boolean
  subredditName: string
  createdAt: Date
}

export interface FlairTemplateRecord {
  id: string
  text: string
  modOnly: boolean
  backgroundColor?: string
  textColor?: string
}

export interface UserFlairRecord {
  text: string
  flairTemplateId?: string
}

export interface ModmailRecord {
  subredditName: string
  subject: string
  body: string
  to: string | null
}

export interface FakeRedditOptions {
  subredditName: string
  subredditId?: string
  /** The app account the handlers act as; becomes the author of everything the bot posts. */
  appUsername?: string
  /** Clock used for createdAt of everything created through the API. */
  now?: () => Date
}

type ApiMethod =
  | 'getPostById'
  | 'getCommentById'
  | 'getComments'
  | 'submitComment'
  | 'submitPost'
  | 'getPostsByUser'
  | 'getSubredditByName'
  | 'getModerators'
  | 'getUserFlairTemplates'
  | 'getUserFlair'
  | 'setUserFlair'
  | 'setUserFlairBatch'
  | 'getUserByUsername'
  | 'createUserFlairTemplate'
  | 'createModmail'

interface Listing<T> {
  all: () => Promise<T[]>
}

function listing<T>(items: T[]): Listing<T> {
  return { all: async () => items }
}

function statusError(status: number, message: string): Error {
  return new Error(`${status} ${message}`)
}

export class FakeReddit {
  readonly subredditName: string
  readonly subredditId: string
  readonly appUser: FakeUser

  readonly users = new Map<string, FakeUser>()
  readonly posts = new Map<string, PostRecord>()
  readonly comments = new Map<string, CommentRecord>()
  readonly flairTemplates: FlairTemplateRecord[] = []
  readonly userFlair = new Map<string, UserFlairRecord>()
  readonly moderators = new Set<string>()
  readonly modmail: ModmailRecord[] = []
  /** Every API call made, in order, for assertions on call patterns. */
  readonly calls: Array<{ method: ApiMethod; args: unknown[] }> = []

  private readonly now: () => Date
  private nextId = 1
  private readonly failures = new Map<ApiMethod, Error[]>()

  constructor(options: FakeRedditOptions) {
    this.subredditName = options.subredditName
    this.subredditId = options.subredditId ?? 't5_fakesub'
    this.now = options.now ?? (() => new Date())
    this.appUser = this.addUser(options.appUsername ?? 'swapbot')
  }

  // ---- seeding -------------------------------------------------------------------------------

  addUser(name: string, extra: Partial<Omit<FakeUser, 'name'>> = {}): FakeUser {
    const user: FakeUser = {
      id: `t2_${name.toLowerCase()}`,
      name,
      createdAt: new Date('2020-01-01T00:00:00Z'),
      linkKarma: 0,
      commentKarma: 0,
      ...extra,
    }
    this.users.set(name.toLowerCase(), user)
    return user
  }

  addModerator(name: string): void {
    if (!this.users.has(name.toLowerCase())) this.addUser(name)
    this.moderators.add(name)
  }

  removeModerator(name: string): void {
    this.moderators.delete(name)
  }

  addFlairTemplate(text: string, options: { modOnly?: boolean; id?: string } = {}): FlairTemplateRecord {
    const template: FlairTemplateRecord = {
      id: options.id ?? `tpl-${this.flairTemplates.length + 1}`,
      text,
      modOnly: options.modOnly ?? false,
    }
    this.flairTemplates.push(template)
    return template
  }

  setFlair(username: string, text: string): void {
    this.userFlair.set(username.toLowerCase(), { text })
  }

  addPost(input: Partial<PostRecord> & { title: string }): PostRecord {
    const authorName = input.authorName ?? this.appUser.name
    const post: PostRecord = {
      id: input.id ?? `t3_${this.nextId++}`,
      body: '',
      authorName,
      authorId: this.userFor(authorName).id,
      subredditName: this.subredditName,
      createdAt: this.now(),
      locked: false,
      stickied: false,
      removed: false,
      spam: false,
      archived: false,
      ...input,
    }
    this.posts.set(post.id, post)
    return post
  }

  addComment(input: Partial<CommentRecord> & { parentId: string; postId: string; authorName: string; body: string }): CommentRecord {
    this.userFor(input.authorName)
    const comment: CommentRecord = {
      id: input.id ?? `t1_${this.nextId++}`,
      removed: false,
      subredditName: this.subredditName,
      createdAt: this.now(),
      ...input,
    }
    this.comments.set(comment.id, comment)
    return comment
  }

  /** Make the next `times` calls of `method` reject with `error` (e.g. a rate limit or a 404). */
  failNext(method: ApiMethod, error: Error | string, times = 1): void {
    const queue = this.failures.get(method) ?? []
    for (let i = 0; i < times; i++) queue.push(typeof error === 'string' ? new Error(error) : error)
    this.failures.set(method, queue)
  }

  // ---- inspection ----------------------------------------------------------------------------

  /** Direct replies to a comment or post, oldest first. */
  repliesTo(id: string): CommentRecord[] {
    return [...this.comments.values()].filter(c => c.parentId === id)
  }

  commentsBy(username: string): CommentRecord[] {
    return [...this.comments.values()].filter(c => c.authorName.toLowerCase() === username.toLowerCase())
  }

  flairOf(username: string): UserFlairRecord | undefined {
    return this.userFlair.get(username.toLowerCase())
  }

  // ---- the ctx.reddit surface ----------------------------------------------------------------

  /** Pass this as `ctx.reddit`. Arrow functions keep it usable when methods are detached. */
  readonly client = {
    getCurrentSubreddit: async () => ({ id: this.subredditId, name: this.subredditName }),
    getAppUser: async () => ({ id: this.appUser.id, username: this.appUser.name }),

    getPostById: async (id: string) => {
      this.enter('getPostById', [id])
      return this.postObject(this.requirePost(id))
    },

    getCommentById: async (id: string) => {
      this.enter('getCommentById', [id])
      return this.commentObject(this.requireComment(id))
    },

    getComments: (options: { postId: string }) => {
      this.enter('getComments', [options])
      const top = [...this.comments.values()].filter(c => c.parentId === options.postId)
      return listing(top.map(c => this.commentObject(c)))
    },

    submitComment: async (options: { id: string; text: string }) => {
      this.enter('submitComment', [options])
      const parent = options.id.startsWith('t1_') ? this.requireComment(options.id) : this.requirePost(options.id)
      const postId = 'postId' in parent ? parent.postId : parent.id
      const comment = this.addComment({
        parentId: options.id,
        postId,
        authorName: this.appUser.name,
        body: options.text,
      })
      return this.commentObject(comment)
    },

    submitPost: async (options: { subredditName: string; title: string; text?: string; flairId?: string }) => {
      this.enter('submitPost', [options])
      const post = this.addPost({
        title: options.title,
        body: options.text ?? '',
        subredditName: options.subredditName,
        flairId: options.flairId,
      })
      return this.postObject(post)
    },

    getPostsByUser: (options: { username: string }) => {
      this.enter('getPostsByUser', [options])
      const posts = [...this.posts.values()]
        .filter(p => p.authorName.toLowerCase() === options.username.toLowerCase())
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      return listing(posts.map(p => this.postObject(p)))
    },

    getSubredditByName: async (name: string) => {
      this.enter('getSubredditByName', [name])
      return {
        id: this.subredditId,
        name,
        getModerators: () => {
          this.enter('getModerators', [name])
          return listing([...this.moderators].map(username => ({ username })))
        },
        getUserFlairTemplates: async () => {
          this.enter('getUserFlairTemplates', [name])
          return this.flairTemplates.map(t => ({ ...t }))
        },
        getUserFlair: async (options: { usernames: string[] }) => {
          this.enter('getUserFlair', [name, options])
          return {
            users: options.usernames
              .filter(u => this.userFlair.has(u.toLowerCase()))
              .map(u => ({ user: u, flairText: this.userFlair.get(u.toLowerCase())!.text })),
          }
        },
      }
    },

    createUserFlairTemplate: async (options: {
      subredditName: string
      text: string
      modOnly?: boolean
      backgroundColor?: string
      textColor?: string
    }) => {
      this.enter('createUserFlairTemplate', [options])
      const template = this.addFlairTemplate(options.text, { modOnly: options.modOnly })
      template.backgroundColor = options.backgroundColor
      template.textColor = options.textColor
      return { ...template }
    },

    setUserFlair: async (options: { subredditName: string; username: string; text?: string; flairTemplateId?: string }) => {
      this.enter('setUserFlair', [options])
      this.userFlair.set(options.username.toLowerCase(), {
        text: options.text ?? '',
        flairTemplateId: options.flairTemplateId,
      })
    },

    setUserFlairBatch: async (subredditName: string, rows: Array<{ username: string; text?: string }>) => {
      this.enter('setUserFlairBatch', [subredditName, rows])
      for (const row of rows) this.userFlair.set(row.username.toLowerCase(), { text: row.text ?? '' })
      return rows.map(() => ({ ok: true, status: 'ok' }))
    },

    getUserByUsername: async (username: string) => {
      this.enter('getUserByUsername', [username])
      const user = this.users.get(username.toLowerCase())
      if (!user) return undefined
      return {
        ...user,
        username: user.name,
        getUserFlairBySubreddit: async (_subreddit: string) => {
          const flair = this.userFlair.get(user.name.toLowerCase())
          return flair ? { flairText: flair.text } : undefined
        },
      }
    },

    modMail: {
      createConversation: async (options: { subredditName: string; subject: string; body: string; to: string | null }) => {
        this.enter('createModmail', [options])
        this.modmail.push({ ...options })
        return { conversation: { id: `modmail-${this.modmail.length}` } }
      },
    },
  }

  // ---- internals -----------------------------------------------------------------------------

  private enter(method: ApiMethod, args: unknown[]): void {
    this.calls.push({ method, args })
    const queue = this.failures.get(method)
    const error = queue?.shift()
    if (error) throw error
  }

  private userFor(name: string): FakeUser {
    return this.users.get(name.toLowerCase()) ?? this.addUser(name)
  }

  private requirePost(id: string): PostRecord {
    const post = this.posts.get(id)
    if (!post) throw statusError(404, `post ${id} not found`)
    return post
  }

  private requireComment(id: string): CommentRecord {
    const comment = this.comments.get(id)
    if (!comment) throw statusError(404, `comment ${id} not found`)
    return comment
  }

  private permalink(kind: 'comments', id: string): string {
    return `/r/${this.subredditName}/${kind}/${id.replace(/^t\d_/, '')}/`
  }

  private postObject(post: PostRecord) {
    const self = this
    return {
      get id() { return post.id },
      get title() { return post.title },
      get body() { return post.body },
      get authorId() { return post.authorId },
      get authorName() { return post.authorName },
      get subredditName() { return post.subredditName },
      get createdAt() { return post.createdAt },
      get locked() { return post.locked },
      get stickied() { return post.stickied },
      get removed() { return post.removed },
      get spam() { return post.spam },
      get archived() { return post.archived },
      get removedByCategory() { return post.removedByCategory },
      get permalink() { return self.permalink('comments', post.id) },
      lock: async () => { post.locked = true },
      unlock: async () => { post.locked = false },
      sticky: async () => { post.stickied = true },
      unsticky: async () => { post.stickied = false },
      setSuggestedCommentSort: async (sort: string) => { post.suggestedSort = sort },
    }
  }

  private commentObject(comment: CommentRecord) {
    const self = this
    return {
      get id() { return comment.id },
      get parentId() { return comment.parentId },
      get postId() { return comment.postId },
      get authorName() { return comment.authorName },
      get body() { return comment.body },
      get removed() { return comment.removed },
      get subredditName() { return comment.subredditName },
      get createdAt() { return comment.createdAt },
      get permalink() { return self.permalink('comments', comment.id) },
      replies: {
        all: async () => self.repliesTo(comment.id).map(c => self.commentObject(c)),
      },
    }
  }
}
