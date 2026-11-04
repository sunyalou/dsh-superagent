import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, threadKey, type Assessor, type ChannelRef, type Executor, type OutboundMessage, type Trigger }
  from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { apply as applyGitee, giteeKind, pollRound, type GiteeConfig } from '../src/sources/gitee.ts'
import { giteeChannel, giteeRef, issueTrigger, mentions, noteTrigger, pullTrigger, threadIdOf,
  type GiteeNoteView, type GiteeTopic } from '../src/sources/gitee-trigger.ts'
import { giteeThreadContext } from '../src/sources/gitee-read.ts'
import { sendGitee } from '../src/sources/gitee-channel.ts'
import { feishuKind, feishuTrigger } from '../src/sources/feishu.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = 'klx/group/repo'
const TARGET = { cli: 'klx-api.sh', repository: REPO }
const ME = { id: 1, username: 'agent' }
const at = (time: string): string => `2026-11-01T${time}+08:00`

const opened: { store: Store; directory: string }[] = []
const healthOf = new WeakMap<SourceRegistry, HealthBoard>()
afterEach(() => {
  for (const { store, directory } of opened.splice(0)) { store.close(); rmSync(directory, { recursive: true, force: true }) }
})

function host(overrides: Partial<SourceContextDeps> = {}, config: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'gitee-'))
  const store = new Store(join(directory, 'db.sqlite'))
  opened.push({ store, directory })
  const settings = SettingsSchema.parse({
    sources: { gitee: { enabled: true, config: { repository: REPO, cli: 'klx-api.sh', ...config } } },
    policy: { sources: { gitee: { allowed: [{ id: 'alice' }] } } },
    eval: { mode: 'auto' },
  })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  const deployment = testDeployment()
  sources.register(giteeKind); sources.register(feishuKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  const context = sourceContextOf(parts, { kind: 'gitee', health: ['gitee'] })
  const health = overrides.sources ? healthOf.get(overrides.sources)!.all : board.all
  return { ...value, ...context, health, store, engine, commands: parts.commands, receive, executor }
}
function emptyRegistry(): SourceRegistry {
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
  healthOf.set(sources, board)
  return sources
}

/**
 * The only Gitee seam: `Commands.gitee` funnels every call through `run`, so a route keyed by `METHOD PATH` stands in for
 * the toolkit and hands back the JSON it would print. A function route sees the argv; an `Error` route is thrown.
 */
function gitee(h: ReturnType<typeof host>, routes: Record<string, unknown>): string[] {
  const reads: string[] = []
  vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
  vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
    const call = `${args[0]} ${args[1]}`
    reads.push(call)
    if (!(call in routes)) throw new Error(`No Gitee route for ${call}`)
    const route = routes[call]
    const value = typeof route === 'function' ? (route as (args: string[]) => unknown)(args) : route
    if (value instanceof Error) throw value
    return JSON.stringify(value)
  })
  return reads
}
const feed = (list: readonly unknown[]) => (args: string[]) => args.includes('sort=desc') ? [list.at(-1)] : list
const seed = (h: ReturnType<typeof host>, since: string, started = since): void =>
  h.store.set(KV.gitee.events, { since, started: { issue: started, pull: started, comment: started } })
const bodyOf = (h: ReturnType<typeof host>, call: string): unknown => {
  const found = vi.mocked(h.commands.run).mock.calls.find(([, args]) => `${args[0]} ${args[1]}` === call)
  if (!found) throw new Error(`No Gitee call ${call}`)
  return JSON.parse(found[1].at(-1)!)
}
const topicOf = (kind: 'issue' | 'pull', iid: number, fields: Partial<GiteeTopic> = {}): GiteeTopic =>
  ({ kind, iid, title: 'Title', text: 'Body', at: at('10:00:00'), author: 'alice', ...fields })
const reply = (id: string, channel: ChannelRef): OutboundMessage => ({ id, channel, text: 'Done', kind: 'reply' })

const issue = { iid: 7, title: 'Fix the margin', description: 'The margin is wrong', created_at: at('10:00:00'),
  author: { user_name: 'alice' } }
const pull = { iid: 3, title: 'Add docs', description: 'The docs are thin',
  web_url: 'https://dev.kunlunxin.com/klx/_code/group/repo/-/pulls/3', created_at: at('11:00:00'), author: { username: 'bob' } }
const discussions = [{ id: 55, body: 'First look', created_at: at('10:10:00'), author: { username: 'carol' },
  notes: [{ id: 56, note: 'A reply from dave', created_at: at('10:11:00'), author: { username: 'dave' } }] }]
const discussionsWithMine = [{ ...discussions[0]!, notes: [{ id: 57, note: 'I am on it', created_at: at('10:10:30'),
  author: { username: 'agent' } }, ...discussions[0]!.notes!] }]
const events = {
  issue: { id: 101, action_name: 'opened', target_type: 'issue', target_iid: 7, target_title: 'Fix the margin',
    author_username: 'alice', created_at: at('10:00:00') },
  pull: { id: 102, action_name: 'opened', target_type: 'pull_request', target_iid: 3, target_title: 'Add docs',
    author_username: 'bob', created_at: at('11:00:00') },
  mention: { id: 103, action_name: 'created', target_type: 'pull_request', target_iid: 3, target_title: 'Add docs',
    author_username: 'bob', created_at: at('12:00:00'),
    note_data: { id: 900, note: '@agent please look at this', created_at: at('12:00:00'), author: { username: 'bob' } } },
  chatter: { id: 104, action_name: 'created', target_type: 'pull_request', target_iid: 3, target_title: 'Add docs',
    author_username: 'bob', created_at: at('12:05:00'),
    note_data: { id: 901, note: 'Looks fine to me', created_at: at('12:05:00'), author: { username: 'bob' } } },
  push: { id: 105, action_name: 'pushed', target_type: 'project', created_at: at('13:00:00') },
}
const all = [events.issue, events.pull, events.mention, events.chatter, events.push]

describe('Gitee triggers', () => {
  it('keeps the issue and pull request number spaces apart', () => {
    const issueTriggerValue = issueTrigger(topicOf('issue', 12), TARGET, 'agent')!
    const pullTriggerValue = pullTrigger(topicOf('pull', 12), TARGET, 'agent')!
    expect(issueTriggerValue.id).toBe(key('gitee-issue', '12'))
    expect(pullTriggerValue.id).toBe(key('gitee-pull', '12'))
    expect(issueTriggerValue.id).not.toBe(pullTriggerValue.id)
    expect(issueTriggerValue.threads).toEqual([{ source: 'gitee', id: 'issue:12' }])
    expect(pullTriggerValue.threads).toEqual([{ source: 'gitee', id: 'pull:12' }])
    expect(threadKey(issueTriggerValue.threads[0]!)).toBe('gitee:issue:12')
    expect(threadKey(pullTriggerValue.threads[0]!)).toBe('gitee:pull:12')
    expect(threadIdOf('pull', 12)).toBe('pull:12')
    expect(giteeRef('issue:12')).toEqual({ kind: 'issue', iid: 12 })
    expect(giteeRef('pull:12')).toEqual({ kind: 'pull', iid: 12 })
  })
  it('builds nothing for the agent\'s own issue, pull request or comment, nor for a bodyless comment', () => {
    expect(issueTrigger(topicOf('issue', 5, { author: 'agent' }), TARGET, 'agent')).toBeUndefined()
    expect(pullTrigger(topicOf('pull', 5, { author: 'agent' }), TARGET, 'agent')).toBeUndefined()
    const note: GiteeNoteView = { id: 9, author: 'agent', at: at('10:00:00'), text: 'On it' }
    expect(noteTrigger(note, { kind: 'issue', iid: 5 }, TARGET, 'agent')).toBeUndefined()
    expect(noteTrigger({ ...note, author: 'alice', text: '   ' }, { kind: 'issue', iid: 5 }, TARGET, 'agent')).toBeUndefined()
  })
  it('takes the actor from the account field and marks only a whole-handle mention', async () => {
    const h = host({}, { observeIssues: true })
    seed(h, at('09:00:00'))
    // The event carries the display name; only the item's account field may name the actor.
    gitee(h, { 'GET /projects/:id/events': () => [{ ...events.issue, author_username: 'Alice Smith' }],
      'GET /projects/:id/issues/7': { ...issue, author: { user_name: 'alice', login: 'Alice Smith' } } })
    await pollRound(h, TARGET, 'agent')
    expect(h.receive.mock.calls[0]![0].actor).toEqual({ source: 'gitee', id: 'alice' })
    expect(mentions('@agent please look', 'agent')).toBe(true)
    expect(mentions('@AGENT please look', 'agent')).toBe(true)
    expect(mentions('mail@agent.dev is my address', 'agent')).toBe(false)
    const addressed = noteTrigger({ id: 1, author: 'bob', at: at('10:00:00'), text: '@agent please look' },
      { kind: 'pull', iid: 3 }, TARGET, 'agent')!
    expect(addressed.addressed).toBe('mention')
    const plain = noteTrigger({ id: 2, author: 'bob', at: at('10:00:00'), text: 'mail@agent.dev is my address' },
      { kind: 'pull', iid: 3 }, TARGET, 'agent')!
    expect(plain).not.toHaveProperty('addressed')
  })
  it('takes in an issue body and a mention from the feed, advances the cursor, and calls a replay a duplicate', async () => {
    const h = host({}, { observeIssues: true })
    seed(h, at('09:00:00'))
    gitee(h, { 'GET /projects/:id/events': feed(all), 'GET /projects/:id/issues/7': issue,
      'GET /projects/:id/merge_requests/3': pull })
    expect(await pollRound(h, TARGET, 'agent')).toMatchObject({ events: 5, triggers: 2, dropped: 0 })
    expect(h.receive.mock.calls.map(([trigger]) => trigger.id)).toEqual([key('gitee-issue', '7'), key('gitee-note', 'pull:3', '900')])
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ source: 'gitee', threads: [{ source: 'gitee', id: 'issue:7' }],
      actor: { source: 'gitee', id: 'alice' }, human: true, at: at('10:00:00'), text: 'Fix the margin\n\nThe margin is wrong',
      meta: { kind: 'issue', on: 'issue', iid: 7, title: 'Fix the margin' } })
    expect(h.receive.mock.calls[1]![0]).toMatchObject({ actor: { source: 'gitee', id: 'bob' }, addressed: 'mention',
      text: '@agent please look at this', meta: { kind: 'comment', on: 'pull', iid: 3, noteId: 900 } })
    expect(h.store.get(KV.gitee.events)).toEqual({ since: at('13:00:00'),
      started: { issue: at('09:00:00'), pull: at('09:00:00'), comment: at('09:00:00') } })
    const before = h.receive.mock.results.length
    await pollRound(h, TARGET, 'agent')
    expect(await Promise.all(h.receive.mock.results.slice(before).map(result => result.value)))
      .toEqual(['duplicate', 'duplicate'])
  })
  it('takes in an issue that mentions the agent although new Issues are not observed, and leaves the gate to decide', async () => {
    const h = host()
    seed(h, at('09:00:00'))
    gitee(h, { 'GET /projects/:id/events': feed([events.issue]),
      'GET /projects/:id/issues/7': { ...issue, description: '@agent the margin is wrong' } })
    await pollRound(h, TARGET, 'agent')
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ addressed: 'mention', actor: { source: 'gitee', id: 'alice' } })
    const config = h.config<GiteeConfig>('gitee')!
    expect(giteeKind.scope!({ meta: { kind: 'issue' } }, config)).toEqual({ listened: true, observed: false, row: 'issue' })
  })
  it('fails the round on a detail read that is not a 404, and drops one that is', async () => {
    const h = host()
    seed(h, at('09:00:00'))
    const before = h.store.get(KV.gitee.events)
    gitee(h, { 'GET /projects/:id/events': feed([events.issue]),
      'GET /projects/:id/issues/7': commandError({ stderr: 'ERROR: 500 服务端错误', code: 1 }) })
    await expect(pollRound(h, TARGET, 'agent')).rejects.toThrow('ERROR: 500 服务端错误')
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get(KV.gitee.events)).toEqual(before)
    const stale = host()
    seed(stale, at('09:00:00'))
    gitee(stale, { 'GET /projects/:id/events': feed([events.issue]),
      'GET /projects/:id/issues/7': commandError({ stderr: 'ERROR: 404 不存在', code: 1 }) })
    expect(await pollRound(stale, TARGET, 'agent')).toMatchObject({ triggers: 0, dropped: 1 })
    expect(stale.receive).not.toHaveBeenCalled()
    expect(stale.store.get(KV.gitee.events)).toEqual({ since: at('10:00:00'),
      started: { issue: at('09:00:00'), pull: at('09:00:00'), comment: at('09:00:00') } })
  })
  it('moves no cursor when the Source stops mid-round', async () => {
    const h = host()
    seed(h, at('09:00:00'))
    const before = h.store.get(KV.gitee.events)
    const controller = new AbortController()
    gitee(h, { 'GET /projects/:id/events': feed([events.issue, events.pull]),
      'GET /projects/:id/issues/7': () => { controller.abort(); return issue },
      'GET /projects/:id/merge_requests/3': pull })
    await expect(pollRound(h, TARGET, 'agent', controller.signal)).rejects.toThrow('stopped')
    expect(h.store.get(KV.gitee.events)).toEqual(before)
  })
  it('bootstraps from the newest event without taking anything in', async () => {
    const h = host()
    gitee(h, { 'GET /projects/:id/events': feed(all) })
    await pollRound(h, TARGET, 'agent')
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get(KV.gitee.events)).toEqual({ since: at('13:00:00'),
      started: { issue: at('13:00:00'), pull: at('13:00:00'), comment: at('13:00:00') } })
    const [, args] = vi.mocked(h.commands.run).mock.calls[0]!
    expect(args.slice(0, 2)).toEqual(['GET', '/projects/:id/events'])
    expect(args).toEqual(expect.arrayContaining(['sort=desc', 'per_page=1']))
  })
  it('skips an event below its kind\'s replay floor instead of replaying a switch turned on later', async () => {
    const h = host()
    const floor = at('12:00:00')
    seed(h, at('09:00:00'), floor)
    gitee(h, { 'GET /projects/:id/events': feed([events.issue]) })
    expect(await pollRound(h, TARGET, 'agent')).toMatchObject({ events: 1, triggers: 0, skipped: 1 })
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get(KV.gitee.events)).toEqual({ since: at('10:00:00'),
      started: { issue: floor, pull: floor, comment: floor } })
  })
  it('polls a subscribed issue Thread through its discussion notes once, then calls the newest note a duplicate', async () => {
    const h = host()
    seed(h, at('09:00:00'))
    h.store.threads.save({ key: 'gitee:issue:7', ref: { source: 'gitee', id: 'issue:7' }, createdAt: at('10:00:00'),
      lastAt: new Date().toISOString(), subscriptions: ['t1'], correlated: [], pending: [], meta: { kind: 'issue', iid: 7 } })
    gitee(h, { 'GET /projects/:id/events': feed([]), 'GET /projects/:id/issues/7/discussions': discussionsWithMine })
    await pollRound(h, TARGET, 'agent')
    expect(h.receive.mock.calls.map(([trigger]) => [trigger.actor.id, trigger.text]))
      .toEqual([['carol', 'First look'], ['dave', 'A reply from dave']])
    expect(h.store.get(KV.gitee.read('issue:7'))).toBe(at('10:11:00'))
    const before = h.receive.mock.results.length
    await pollRound(h, TARGET, 'agent')
    expect(h.receive.mock.calls.length).toBe(before + 1)
    expect(await h.receive.mock.results.at(-1)!.value).toBe('duplicate')
  })
})

describe('Gitee channel', () => {
  it('takes its own marker as delivered, and a quoted marker in someone else\'s comment as not', async () => {
    const marker = 'Done\n\n<!-- dsh-superagent:m1 -->'
    const mine = host()
    gitee(mine, { 'GET /user': ME, 'GET /projects/:id/issues/7/discussions': [{ id: 55, body: marker,
      created_at: at('10:00:00'), author: { username: 'agent' } }] })
    expect(await sendGitee({ commands: mine.commands }, reply('m1', giteeChannel('issue', 7, TARGET)))).toBe('sent')
    expect(vi.mocked(mine.commands.run).mock.calls.some(([, args]) => args[0] === 'POST')).toBe(false)
    const quoted = host()
    gitee(quoted, { 'GET /user': ME, 'GET /projects/:id/issues/7/discussions': [{ id: 55, body: marker,
      created_at: at('10:00:00'), author: { username: 'carol' } }],
    'POST /projects/:id/issues/7/notes': { message: '添加成功', code: 0 } })
    expect(await sendGitee({ commands: quoted.commands }, reply('m1', giteeChannel('issue', 7, TARGET)))).toBe('sent')
    expect(vi.mocked(quoted.commands.run).mock.calls.some(([, args]) => args[0] === 'POST')).toBe(true)
  })
  it('posts an issue body with created_at and a pull request note with noteable_type', async () => {
    const h = host()
    gitee(h, { 'GET /user': ME, 'GET /projects/:id/issues/7/discussions': [], 'POST /projects/:id/issues/7/notes': { message: '添加成功', code: 0 },
      'GET /projects/:id/merge_requests/3/discussions': [], 'POST /projects/:id/merge_requests/3/notes': { message: '添加成功', code: 0 } })
    expect(await sendGitee({ commands: h.commands }, reply('m2', giteeChannel('issue', 7, TARGET)))).toBe('sent')
    const issueBody = bodyOf(h, 'POST /projects/:id/issues/7/notes')
    expect(issueBody).toEqual({ body: 'Done\n\n<!-- dsh-superagent:m2 -->',
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) })
    expect(issueBody).not.toHaveProperty('noteable_type')
    expect(await sendGitee({ commands: h.commands }, reply('m3', giteeChannel('pull', 3, TARGET)))).toBe('sent')
    expect(bodyOf(h, 'POST /projects/:id/merge_requests/3/notes'))
      .toEqual({ note: 'Done\n\n<!-- dsh-superagent:m3 -->', noteable_type: 'PullRequest' })
  })
  it('drops a confirmed dead destination and keeps a bare 404 for a retry', async () => {
    const h = host()
    gitee(h, { 'GET /user': ME, 'GET /projects/:id/issues/7/discussions': [],
      'POST /projects/:id/issues/7/notes': commandError({ stderr: 'ERROR: 404 未找到相关记录', code: 1 }) })
    expect(await sendGitee({ commands: h.commands }, reply('m4', giteeChannel('issue', 7, TARGET)))).toBe('gone')
    const bare = host()
    gitee(bare, { 'GET /user': ME, 'GET /projects/:id/issues/7/discussions': [],
      'POST /projects/:id/issues/7/notes': commandError({ stderr: 'ERROR: 404 不存在', code: 1 }) })
    await expect(sendGitee({ commands: bare.commands }, reply('m5', giteeChannel('issue', 7, TARGET))))
      .rejects.toThrow('ERROR: 404')
  })
})

describe('Gitee context and kind', () => {
  it('reads the topic, the whole conversation, and the replied-to note', async () => {
    const h = host()
    gitee(h, { 'GET /projects/:id/issues/7': issue, 'GET /projects/:id/issues/7/discussions': discussions })
    const trigger = noteTrigger({ id: 56, author: 'dave', at: at('10:11:00'), text: 'A reply from dave', parent: 55 },
      { kind: 'issue', iid: 7 }, TARGET, 'agent')!
    expect(giteeThreadContext.messageId(trigger)).toBe('56')
    const thread = await giteeThreadContext.read(h.commands, trigger, 'thread', undefined, {})
    expect(thread.messages.map(message => message.id)).toEqual(['topic:7', '55', '56'])
    expect(thread.messages[0]).toMatchObject({ from: 'alice', at: at('10:00:00'), text: 'Fix the margin\n\nThe margin is wrong' })
    expect(thread.messages[2]).toMatchObject({ from: 'dave', reply_to: '55' })
    expect((await giteeThreadContext.read(h.commands, trigger, 'root', undefined, {})).messages.map(message => message.id))
      .toEqual(['topic:7'])
    expect((await giteeThreadContext.read(h.commands, trigger, 'parent', undefined, {})).messages.map(message => message.id))
      .toEqual(['55'])
    expect(giteeThreadContext.messageId(issueTrigger(topicOf('issue', 7), TARGET, 'agent')!)).toBe('topic:7')
  })
  it('reports its admission rows and lets the Engine admit a listed mention as explicit', async () => {
    expect(giteeKind.policy!.rows!({}).map(row => [row.id, row.cells])).toEqual([
      ['issue', { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false }],
      ['pull', { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false }],
      ['comment', { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false }]])
    expect(giteeKind.policy!.rows!({ observeIssues: true, observePulls: true, observeComments: true }).map(row => [row.id, row.cells]))
      .toEqual([['issue', { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true }],
        ['pull', { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true }],
        ['comment', { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true }]])
    const h = host()
    const trigger = noteTrigger({ id: 900, author: 'alice', at: at('12:00:00'), text: '@agent please look' },
      { kind: 'issue', iid: 7 }, TARGET, 'agent')!
    expect(await h.receive(trigger)).toBe('stored')
    expect(h.store.threads.get('gitee:issue:7')?.evaluating).toMatchObject({ strength: 'explicit',
      actor: { source: 'gitee', id: 'alice' }, basis: expect.objectContaining({ via: 'addressed', addressed: 'mention' }) })
  })
  it('fills its environment variables for a Gitee Trigger and leaves them empty for a Feishu one', () => {
    const config = giteeKind.schema.parse({ repository: REPO, cli: 'klx-api.sh' })
    const giteeTrigger = issueTrigger(topicOf('issue', 7), TARGET, 'agent')!
    expect(giteeKind.environment!.values({ deployment: testDeployment(), config, trigger: giteeTrigger })).toEqual({
      DSH_SUPERAGENT_GITEE_REPOSITORY: REPO, DSH_SUPERAGENT_GITEE_KIND: 'issue', DSH_SUPERAGENT_GITEE_IID: '7' })
    // The kind names the item a comment sits on, not the fact that it is a comment.
    const comment = noteTrigger({ id: 900, author: 'bob', at: at('12:00:00'), text: 'hi' },
      { kind: 'pull', iid: 3 }, TARGET, 'agent')!
    expect(giteeKind.environment!.values({ deployment: testDeployment(), config, trigger: comment })).toEqual({
      DSH_SUPERAGENT_GITEE_REPOSITORY: REPO, DSH_SUPERAGENT_GITEE_KIND: 'pull', DSH_SUPERAGENT_GITEE_IID: '3' })
    const feishu = feishuTrigger({ message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', sender_id: 'ou_alice',
      sender_type: 'user', content: 'hi', create_time: '1757376000000' }, 'ou_bot', 'cli_bot')!
    expect(giteeKind.environment!.values({ deployment: testDeployment(), config, trigger: feishu })).toEqual({
      DSH_SUPERAGENT_GITEE_REPOSITORY: REPO, DSH_SUPERAGENT_GITEE_KIND: '', DSH_SUPERAGENT_GITEE_IID: '' })
  })
  it('registers its kind, waits for setup, and gives the kind back when disposed', async () => {
    const value = host({ sources: emptyRegistry(), configured: () => false })
    const disposers: (() => unknown)[] = []
    applyGitee({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    await vi.waitFor(() => expect(value.health.gitee).toMatchObject({ state: 'paused', code: 'setupPending' }))
    expect(value.sources.kind('gitee')).toBe(giteeKind)
    for (const dispose of disposers) await dispose()
    expect(value.sources.kind('gitee')).toBeUndefined()
    expect(value.health.gitee).toBeUndefined()
  })
  it('reports a failure that escapes the polling loop as its health instead of an unhandled rejection', async () => {
    const value = host({ sources: emptyRegistry(), ready: Promise.reject(new Error('lock held')) })
    const disposers: (() => unknown)[] = []
    applyGitee({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    try {
      await vi.waitFor(() => expect(value.health.gitee).toMatchObject({ state: 'error', detail: expect.stringContaining('lock held') }))
    } finally { for (const dispose of disposers) await dispose() }
  })
  it('reports only a run of failed polls, and clears the count with one success', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const board = new HealthBoard()
      const settings = SettingsSchema.parse({ sources: { gitee: { enabled: true, config: { repository: REPO, cli: 'klx-api.sh',
        pollSeconds: 60, failuresBeforeError: 3 } } }, policy: { sources: { gitee: { allowed: [{ id: 'alice' }] } } }, eval: { mode: 'auto' } })
      const sources = new SourceRegistry(() => settings, board)
      healthOf.set(sources, board)
      const value = host({ sources })
      const outcomes = [false, false, false, true, false]
      let round = 0
      const run = vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_program, args) => {
        if (args[1] === '/user') {
          if (!outcomes[round++]) throw commandError({ stderr: 'ERROR: 500 服务端错误', code: 1 })
          return JSON.stringify(ME)
        }
        if (args[1] === '/projects/:id/events') return '[]'
        throw commandError({ stderr: 'ERROR: 404 不存在', code: 1 })
      })
      const disposers: (() => unknown)[] = []
      applyGitee({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
      const until = async (count: number): Promise<void> => {
        while (round < count) {
          await vi.waitFor(() => expect(round).toBeGreaterThan(0))
          if (round < count) await vi.advanceTimersByTimeAsync(60_000)
        }
      }
      try {
        await until(1)
        expect(value.health.gitee).toMatchObject({ state: 'starting' })
        await until(2)
        expect(value.health.gitee).toMatchObject({ state: 'starting' })
        await until(3)
        await vi.waitFor(() => expect(value.health.gitee).toMatchObject({ state: 'error', code: 'pollFailures',
          values: { count: '3' } }))
        await until(4)
        await vi.waitFor(() => expect(value.health.gitee).toMatchObject({ state: 'ready' }))
        // The success cleared the run: one more failure does not bring the error back at once.
        await until(5)
        await vi.waitFor(() => expect(round).toBe(5))
        expect(value.health.gitee).toMatchObject({ state: 'ready' })
      } finally {
        for (const dispose of disposers) await dispose()
        run.mockRestore()
      }
    } finally { vi.useRealTimers() }
  })
})
