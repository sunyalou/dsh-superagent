/** Gitee Source kind definition, its events feed and Thread polling loops, and the Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { threadKey, type Trigger } from '../core/index.ts'
import { CliError, type GiteeTarget } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { classifyEvent, EventListSchema, eventsOf, giteeFind, giteeRef, issueTrigger, noteTrigger, pullTrigger, SOURCE, threadIdOf, type GiteeKind,
  type GiteeRef } from './gitee-trigger.ts'
import { giteeMe, giteeThreadContext, giteeTime, readNotes, readTopic } from './gitee-read.ts'
import { giteeAllowed, giteeLink, sendGitee } from './gitee-channel.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { pause, pollThreads as pollEach } from './poll.ts'

export const GiteeConfigSchema = z.object({
  /** `group/repo`, as the CLI's `-r` takes it; empty until a person saves one. */
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+)?$/).default(''),
  /** A command name on PATH or an absolute path to `klx-api.sh`; the CLI owns its credentials. */
  cli: z.string().trim().default('klx-api.sh'),
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false),
  observePulls: z.boolean().default(false),
  observeComments: z.boolean().default(false),
}).strict()
export type GiteeConfig = z.infer<typeof GiteeConfigSchema>
const OBSERVED = { issue: 'observeIssues', pull: 'observePulls', comment: 'observeComments' } as const
type Activity = keyof typeof OBSERVED

export const giteeKind: SourceKind<GiteeConfig> = {
  kind: SOURCE,
  title: { zh: 'Gitee', en: 'Gitee' },
  description: { zh: '智能体的 Gitee 账号；接收仓库里的 Issue、Pull Request 和评论。', en: 'The agent\'s Gitee account; receives Issues, pull requests and comments in the repository.' },
  schema: GiteeConfigSchema,
  fields: [
    { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-]+(/[A-Za-z0-9_.\\-]+)+', label: { zh: '监听的仓库', en: 'Repository' },
      hint: { zh: '写作 group/repo。这个来源接收这个仓库的事件和讨论；保存时只校验格式，不探测仓库，下一轮轮询就按新配置读取。', en: 'Written group/repo. This Source receives this repository\'s events and discussion; saving checks the format only and does not probe the repository, and the next poll reads the new configuration.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 Gitee CLI', en: 'Agent Gitee CLI' },
      hint: { zh: '命令名或绝对路径，通常是 klx-api.sh。凭据只来自 KLX_GITEE_TOKEN 或 ~/.klx-gitee/config.json，不保存在这里；执行器以它调用 Gitee。', en: 'A command name or absolute path, usually klx-api.sh. Credentials come only from KLX_GITEE_TOKEN or ~/.klx-gitee/config.json and are never stored here; the Executor calls Gitee through it.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
      hint: { zh: '两次轮询之间的等待。每轮最多读五页事件，积压留到下一轮，不会丢。', en: 'The wait between two polls. A round reads at most five pages of events and leaves any backlog for the next round, so nothing is lost.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' }, hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收仓库里的新 Issue', en: 'Receive new Issues in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选；@ 智能体的总会收到。从打开的时候开始，不读以前的。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates; one that mentions the agent is always received. Starts when switched on; earlier ones are not read.' } },
    { key: 'observePulls', type: 'switch', label: { zh: '接收仓库里的新 PR', en: 'Receive new pull requests in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的新 PR 也会收到，由策略的接收表决定是否成为候选；@ 智能体的总会收到。', en: 'New pull requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates; one that mentions the agent is always received.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收仓库里的评论', en: 'Receive comments in the repository' },
      hint: { zh: '打开后，Issue 和 PR 上没有 @ 智能体的评论也会收到，由策略的接收表决定是否成为候选；@ 智能体的总会收到。', en: 'Comments on Issues and pull requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates; one that mentions the agent is always received.' } },
  ],
  health: ['gitee'],
  // What the Source observes across the repository it receives in full; elsewhere, only what addresses the agent.
  scope: ({ meta }, config) => {
    const row = meta.kind
    if (row === 'issue' || row === 'pull' || row === 'comment') return { listened: true, observed: !!config[OBSERVED[row]], row }
    return { listened: true, observed: false }
  },
  channel: { allowed: giteeAllowed, send: sendGitee, link: giteeLink },
  threadContext: giteeThreadContext,
  find: (query, config) => giteeFind(query, config),
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/), name: z.string().trim().max(100).optional() }).strict())
      .refine(accounts => new Set(accounts.map(account => account.id.toLowerCase())).size === accounts.length, 'Duplicate accounts').default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Gitee 账号', en: 'Gitee accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9][A-Za-z0-9._-]*' }] }],
    explicit: { zh: '名单里的账号在 Issue、Pull Request 或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue, a pull request or a comment.' },
    rows(stored) {
      const config = GiteeConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Activity, label: { zh: string; en: string }) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issue', { zh: '新 Issue', en: 'New Issues' }), row('pull', { zh: '新 PR', en: 'New pull requests' }),
        row('comment', { zh: '评论', en: 'Comments' })]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITEE_REPOSITORY', description: { zh: '这个来源监听的仓库，group/repo；智能体对 Gitee 的读写都以它为界', en: 'The repository this Source watches, as group/repo; every Gitee read and write the agent makes is bounded by it' } },
      { key: 'DSH_SUPERAGENT_GITEE_KIND', description: { zh: '接下工单的是 issue 还是 pull；工单不是从 Gitee 来的时为空', en: 'Whether the ticket started on an issue or a pull request; empty when the ticket did not start on Gitee' } },
      { key: 'DSH_SUPERAGENT_GITEE_IID', description: { zh: '接下工单的 Issue 或 PR 编号；工单不是从 Gitee 来的时为空', en: 'Number of the Issue or PR that started the ticket; empty when the ticket did not start on Gitee' } },
    ],
    values: ({ config, trigger }) => ({ DSH_SUPERAGENT_GITEE_REPOSITORY: config.repository,
      DSH_SUPERAGENT_GITEE_KIND: trigger?.source === SOURCE ? String(trigger.meta.on ?? '') : '',
      DSH_SUPERAGENT_GITEE_IID: trigger?.source === SOURCE ? String(trigger.meta.iid ?? '') : '' }),
  },
}
export const name = 'dsh-superagent-gitee'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(giteeKind), 'gitee: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, giteeKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('gitee', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the deployment; until then nothing is polled.
  if (!ctx.configured()) { ctx.report('gitee', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GiteeConfig>(SOURCE)
    try {
      if (!config) ctx.report('gitee', health('paused', 'sourceOff'))
      else if (!config.repository || !config.cli) ctx.report('gitee', health('paused', 'giteeUnset'))
      else {
        const target: GiteeTarget = { cli: config.cli, repository: config.repository }
        const me = await giteeMe(ctx.commands.withSignal(signal), target)
        const { events, triggers, dropped, skipped } = await pollRound(ctx, target, me, signal)
        failures = 0
        ctx.report('gitee', { state: 'ready', at: new Date().toISOString(),
          detail: `${events} events, ${triggers} triggers${dropped ? `, ${dropped} dropped` : ''}${skipped ? `, ${skipped} skipped` : ''}` })
      }
    } catch (error) {
      failures += 1
      // A single network interruption is retried on the next poll; only a run of them is worth reporting.
      if (failures >= (config?.failuresBeforeError ?? 3)) {
        ctx.report('gitee', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
      }
    }
    await pause((config?.pollSeconds ?? 60) * 1000, signal)
  }
}
const MAX_PAGES = 5
const PAGE_SIZE = 100
/** One polling round: the event ids taken in so far (a shifted page must not deliver one twice) and the counts it reports. */
interface Round {
  signal?: AbortSignal | undefined
  seen: Set<number>
  events: number
  triggers: number
  dropped: number
  skipped: number
}
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
const threadLabel = (kind: GiteeKind, iid: number, title: string): string =>
  `${kind === 'issue' ? 'Issue' : 'Pull request'} ${kind === 'issue' ? '#' : '!'}${iid}${title ? ` ${title}` : ''}`

/** One polling round: the repository's events, then the subscribed Threads. A failed event feed throws and leaves the cursor, so the round is retried from the same place. */
export async function pollRound(ctx: SourceContext, target: GiteeTarget, me: string, signal?: AbortSignal):
Promise<{ events: number; triggers: number; dropped: number; skipped: number }> {
  const round: Round = { signal, seen: new Set(), events: 0, triggers: 0, dropped: 0, skipped: 0 }
  await pollEvents(ctx, target, me, round)
  await pollThreads(ctx, target, me, round)
  return { events: round.events, triggers: round.triggers, dropped: round.dropped, skipped: round.skipped }
}
/**
 * Reads the repository's events feed from its cursor, oldest first, and receives the Triggers they ask for. A detail
 * read that fails with anything but 404 fails the round, so the same event is retried instead of skipped.
 */
export async function pollEvents(ctx: SourceContext, target: GiteeTarget, me: string, round: Round): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const config = ctx.config<GiteeConfig>(SOURCE)
  if (!config) throw new Error('The Gitee Source stopped during the poll')
  const stored = ctx.state.get(KV.gitee.events)
  // The first poll of a repository records its newest event as every kind's floor and takes nothing in, so a new Source
  // never replays history. Pointing the Source at another repository starts its own window the same way, because a
  // cursor of one repository's feed says nothing about another's.
  if (!stored || stored.repository !== config.repository) {
    const newest = eventsOf(await commands.gitee(target, EventListSchema, '/projects/:id/events',
      { query: { type: 'all', sort: 'desc', per_page: 1 } })).at(0)
    const since = newest?.created_at ?? ''
    ctx.state.set(KV.gitee.events, { repository: config.repository, since, started: { issue: since, pull: since, comment: since } })
    return
  }
  let newest = ''
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    if (stopped(ctx, round)) throw new Error('The Gitee Source stopped during the poll')
    const events = eventsOf(await commands.gitee(target, EventListSchema, '/projects/:id/events',
      { query: { type: 'all', sort: 'asc', per_page: PAGE_SIZE, page, ...stored.since ? { after: stored.since } : {} } }))
    for (const event of events) {
      // Stopping mid-feed throws before the cursor moves, so unread events are retried.
      if (stopped(ctx, round)) throw new Error('The Gitee Source stopped during the poll')
      round.events += 1
      newest = event.created_at
      if (round.seen.has(event.id)) { round.skipped += 1; continue }
      round.seen.add(event.id)
      const outcome = classifyEvent(event)
      if (!outcome) { round.skipped += 1; continue }
      // The floor belongs to the event's activity, not its target type, so a switch turned on later does not replay backlog.
      const floor = giteeTime(stored.started[outcome.activity] ?? '')
      if (Number.isFinite(floor) && giteeTime(event.created_at) <= floor) { round.skipped += 1; continue }
      let trigger: Trigger | undefined
      let title = ''
      let url: string | undefined
      if (outcome.activity === 'comment') {
        trigger = noteTrigger(outcome.note, { kind: outcome.on, iid: outcome.iid, repository: target.repository }, target, me)
        title = (event.target_title ?? '').trim()
        url = event.merge_request_data?.web_url ?? undefined
      } else {
        const ref: GiteeRef = { kind: outcome.activity, iid: outcome.iid, repository: target.repository }
        try {
          const topic = await readTopic(commands, target, ref, { at: event.created_at, author: (event.author_username ?? '').trim(),
            ...outcome.title ? { title: outcome.title } : {} })
          title = topic.title.trim()
          url = topic.url
          trigger = outcome.activity === 'issue' ? issueTrigger(topic, target, me) : pullTrigger(topic, target, me)
        } catch (error) {
          // A 404 is the item gone before its body could be read: drop it, while any other failure leaves the cursor for a retry.
          if (!(error instanceof CliError) || error.code !== 404) throw error
          round.dropped += 1
          continue
        }
      }
      // Admission gates receipt, not the cursor: an unaddressed event with its switch off is stepped over, and its kind's floor keeps it from replaying later.
      if (!trigger) { round.skipped += 1; continue }
      if (trigger.addressed !== 'mention' && !config[OBSERVED[outcome.activity]]) { round.skipped += 1; continue }
      await ctx.receive(trigger)
      round.triggers += 1
      const kind = outcome.activity === 'comment' ? outcome.on : outcome.activity
      ctx.threads.describe(threadKey({ source: SOURCE, id: threadIdOf(kind, outcome.iid, target.repository) }),
        { label: threadLabel(kind, outcome.iid, title), ...(url ? { url } : {}) })
    }
    if (events.length < PAGE_SIZE) break
  }
  // The cursor moves once, to the newest event examined, after every event above was taken in or deliberately skipped.
  // It never moves backwards, so an overlapping read that returned only events already taken in cannot make the next
  // round re-read the whole window.
  if (round.events && (!stored.since || giteeTime(newest) > giteeTime(stored.since))) {
    ctx.state.set(KV.gitee.events, { repository: stored.repository, since: newest, started: stored.started })
  }
}
/** Polls subscribed Threads for comments newer than each Thread's checkpoint; item creation itself is the feed's business. */
export async function pollThreads(ctx: SourceContext, target: GiteeTarget, me: string, round: Round): Promise<void> {
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    const ref = giteeRef(thread.ref.id)
    if (!ref) throw new Error(`Subscribed Gitee Thread ${thread.ref.id} names no issue or pull request`)
    // A Thread is read against the repository it was created from, so a changed setting cannot make it read
    // another repository's item with the same number.
    const own: GiteeTarget = { cli: target.cli, repository: ref.repository }
    const checkpoint = KV.gitee.read(thread.ref.id)
    const since = ctx.state.get(checkpoint) ?? thread.createdAt
    const floor = giteeTime(since)
    const notes = await readNotes(ctx.commands.withSignal(round.signal), own, ref)
    for (const note of notes) {
      if (stopped(ctx, round)) throw new Error('The Gitee Source stopped during the poll')
      // A comment's `created_at` is its only clock: an edit is out of scope and neither replays a note nor hides one.
      if (!(giteeTime(note.at) >= floor)) continue
      const trigger = noteTrigger(note, ref, own, me)
      if (!trigger) continue
      await ctx.receive(trigger)
      round.triggers += 1
    }
    // Read oldest first, so the last note is the newest, and a stale note never rewinds the checkpoint.
    const newest = notes.at(-1)?.at
    if (newest && (!Number.isFinite(floor) || giteeTime(newest) > floor)) ctx.state.set(checkpoint, newest)
  })
}
