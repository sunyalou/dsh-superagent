/** Normalizes Gitee issues, pull requests, comments and events into domain Triggers, with the wire schemas they come from. */
import { z } from 'zod'
import { key, threadKey, type ChannelRef, type Trigger } from '../core/index.ts'
import type { GiteeTarget } from '../infra/commands.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitee'
/** Gitee numbers issues and pull requests in separate spaces, so every id carries the kind it belongs to. */
export type GiteeKind = 'issue' | 'pull'
export interface GiteeRef { kind: GiteeKind; iid: number }
/** An issue or pull request as the readers hand it to the builders. */
export interface GiteeTopic { kind: GiteeKind; iid: number; title: string; text: string; at: string; author: string; url?: string }
export interface GiteeNoteView { id: number; author: string; at: string; text: string; parent?: number }

export const UserSchema = z.looseObject({ id: z.number().optional(), username: z.string().optional(),
  user_name: z.string().optional(), name: z.string().nullish(), login: z.string().nullish() })
export type GiteeUser = z.infer<typeof UserSchema>
/**
 * The account the Policy names: `username`, then `user_name`, never the display-name field `login`.
 * Issue-list authors spell it `user_name` on some payloads, and `login` can hold a person's name.
 */
export const account = (user: GiteeUser | null | undefined): string =>
  (user?.username ?? user?.user_name ?? '').trim()

export const MeSchema = z.looseObject({ id: z.number(), username: z.string().min(1) })
export const EventSchema = z.looseObject({
  id: z.number(), action_name: z.string().min(1), target_type: z.string().min(1),
  target_iid: z.number().int().nullish(), target_title: z.string().nullish(),
  author_username: z.string().nullish(), created_at: z.string().min(1),
  note_data: z.looseObject({ id: z.number(), note: z.union([z.string(), z.number()]).nullish(),
    created_at: z.string().nullish(), author: UserSchema.nullish() }).nullish(),
  issues_data: z.looseObject({ iid: z.number().optional(), title: z.string().nullish(),
    description: z.string().nullish(), created_at: z.string().nullish(), author: UserSchema.nullish() }).nullish(),
  merge_request_data: z.looseObject({ iid: z.number().optional(), title: z.string().nullish(),
    description: z.string().nullish(), created_at: z.string().nullish(), web_url: z.string().nullish(),
    author: UserSchema.nullish() }).nullish(),
})
export type GiteeEvent = z.infer<typeof EventSchema>

export const IssueSchema = z.looseObject({ iid: z.number().int().positive(), title: z.string(),
  description: z.string().nullish(), created_at: z.string().min(1), updated_at: z.string().nullish(),
  author: UserSchema.nullish() })
export const PullSchema = z.looseObject({ iid: z.number().int().positive(), title: z.string().nullish(),
  description: z.string().nullish(), web_url: z.string().nullish(), created_at: z.string().nullish(),
  updated_at: z.string().nullish(), author: UserSchema.nullish() })

/** A reply nested under a discussion node or its notes; some PR paths nest replies directly on the node. */
export const ChildSchema = z.looseObject({ id: z.number(), note: z.string().nullish(), author: UserSchema.nullish(),
  created_at: z.string().nullish() })
/** One discussion node. Issue nodes carry the root text in `body`; PR nodes carry it in `notes[].note`.
 *  `children[]` holds replies on the PR path. Parsed defensively so either shape yields notes. */
export const DiscussionSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), note: z.union([z.string(), z.number()]).nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(),
  author: UserSchema.nullish(), reply_user: UserSchema.nullish(), children: z.array(ChildSchema).nullish(),
  notes: z.array(z.looseObject({ id: z.number(), note: z.string().nullish(), created_at: z.string().nullish(),
    updated_at: z.string().nullish(), author: UserSchema.nullish(), parent_id: z.number().nullish(),
    children: z.array(ChildSchema).nullish() })).nullish(),
})
/**
 * A list response as the CLI prints it: a bare array, or the `list` of a paged envelope. Gitee answers some list
 * endpoints either way and the CLI unwraps only `data`, so both shapes reach one reader.
 */
export const EventListSchema = z.union([z.array(EventSchema), z.looseObject({ list: z.array(EventSchema) })])
export const eventsOf = (page: z.infer<typeof EventListSchema>): GiteeEvent[] => Array.isArray(page) ? page : page.list
export const DiscussionListSchema = z.union([z.array(DiscussionSchema), z.looseObject({ list: z.array(DiscussionSchema) })])
export const discussionsOf = (page: z.infer<typeof DiscussionListSchema>): z.infer<typeof DiscussionSchema>[] =>
  Array.isArray(page) ? page : page.list

/** The Thread id of an item: `issue:12` or `pull:34`. */
export const threadIdOf = (kind: GiteeKind, iid: number): string => `${kind}:${iid}`
/** The item kind a platform `target_type` names; undefined for pushes, projects and other events. */
const kindOf = (target: string): GiteeKind | undefined =>
  target === 'issue' ? 'issue' : target === 'pull_request' || target === 'pull' || target === 'merge_request' ? 'pull' : undefined
/** The inverse of {@link threadIdOf}, for a stored Thread id; undefined for anything else. */
export function giteeRef(id: string): GiteeRef | undefined {
  const match = /^(issue|pull):([1-9]\d*)$/.exec(id)
  if (!match) return undefined
  const kind = kindOf(match[1]!)
  return kind ? { kind, iid: Number(match[2]!) } : undefined
}
/** The item a Trigger sits on, read from `meta`; throws when `meta` names none. */
export function refOf(trigger: Trigger): GiteeRef {
  const { on, iid } = trigger.meta
  const kind = on === 'issue' || on === 'pull' ? on : undefined
  if (!kind || typeof iid !== 'number' || !Number.isInteger(iid) || iid <= 0) {
    throw new Error('The Gitee Trigger names no issue or pull request')
  }
  return { kind, iid }
}
/** Whole-handle, case-insensitive mention match on `@username`; not inside a word or an email. */
export const mentions = (text: string, username: string): boolean => {
  const handle = username.trim()
  return !!handle && new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(handle)}(?![a-zA-Z0-9_-])`, 'i').test(text)
}
/** True for an account that is the agent itself; case-insensitive, and never for a topic that names nobody. */
export const isMe = (author: string, me: string): boolean =>
  !!author.trim() && !!me.trim() && sameName(author.trim(), me.trim())
/** The reply address of an item. It carries the CLI and repository because `channel.send` cannot see config. */
export const giteeChannel = (kind: GiteeKind, iid: number, target: GiteeTarget, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: `${SOURCE}:${threadIdOf(kind, iid)}`,
    address: { on: kind, iid: String(iid), repository: target.repository, cli: target.cli, ...(url ? { url } : {}) } })
/** An item's model-facing text: its title, then its description, without a blank line when the description is empty. */
export const topicText = (topic: Pick<GiteeTopic, 'title' | 'text'>): string =>
  [topic.title, topic.text].filter(Boolean).join('\n\n')

/**
 * `#12` names the issue Thread, `!12` the pull Thread, a bare number both. Ident and web URLs become search terms.
 * A bare number is no ident, so it adds no term: it would match every Trigger that mentions the number.
 */
export function giteeFind(query: string): { threads: string[]; terms: string[] } {
  const value = query.trim()
  // Any host, because the platform is an internal deployment; the number a web URL carries is read as the iid.
  const page = /^(https?:\/\/\S*?\/(issues|pulls?)\/(\d+))\/?(?:[?#].*)?$/i.exec(value)
  if (page) {
    const kind: GiteeKind = page[2]!.toLowerCase() === 'issues' ? 'issue' : 'pull'
    return { threads: [threadOf(kind, Number(page[3]!))], terms: [page[1]!] }
  }
  const ident = /^([#!]?)([1-9]\d*)$/.exec(value)
  if (!ident) return { threads: [], terms: [] }
  const kinds: GiteeKind[] = ident[1] === '#' ? ['issue'] : ident[1] === '!' ? ['pull'] : ['issue', 'pull']
  return { threads: kinds.map(kind => threadOf(kind, Number(ident[2]!))),
    terms: ident[1] ? [`${ident[1]}${ident[2]!}`] : [] }
}
const threadOf = (kind: GiteeKind, iid: number): string => threadKey({ source: SOURCE, id: threadIdOf(kind, iid) })

/** Trigger id namespaces of an item's own body. */
const TOPIC_KEY: Record<GiteeKind, string> = { issue: 'gitee-issue', pull: 'gitee-pull' }
function topicTrigger(kind: GiteeKind, topic: GiteeTopic, target: GiteeTarget, me: string): Trigger | undefined {
  if (isMe(topic.author, me)) return undefined
  const text = topicText(topic)
  if (!text.trim()) return undefined
  return { id: key(TOPIC_KEY[kind], String(topic.iid)), source: SOURCE,
    threads: [{ source: SOURCE, id: threadIdOf(kind, topic.iid) }], actor: { source: SOURCE, id: topic.author },
    human: !isMe(topic.author, me), ...(mentions(text, me) ? { addressed: 'mention' as const } : {}), at: topic.at, text,
    channel: giteeChannel(kind, topic.iid, target, topic.url), ...(topic.url ? { url: topic.url } : {}),
    meta: { kind, on: kind, iid: topic.iid, title: topic.title } }
}
/** Builds the Trigger of a newly opened issue's title and description; none for the agent's own issue or an empty one. */
export const issueTrigger = (topic: GiteeTopic, target: GiteeTarget, me: string): Trigger | undefined =>
  topicTrigger('issue', topic, target, me)
/** Builds the Trigger of a newly opened pull request; a PR yields its `web_url` when the platform has one. */
export const pullTrigger = (topic: GiteeTopic, target: GiteeTarget, me: string): Trigger | undefined =>
  topicTrigger('pull', topic, target, me)
/**
 * Builds the Trigger of a comment; none for the agent's own comment or a bodyless one.
 * The id carries no edit version: the events feed and the discussions reader must derive one id per note, and
 * edited comments are out of scope.
 */
export function noteTrigger(note: GiteeNoteView, ref: GiteeRef, target: GiteeTarget, me: string, url?: string): Trigger | undefined {
  if (isMe(note.author, me)) return undefined
  if (!note.text.trim()) return undefined
  return { id: key('gitee-note', threadIdOf(ref.kind, ref.iid), String(note.id)), source: SOURCE,
    threads: [{ source: SOURCE, id: threadIdOf(ref.kind, ref.iid) }], actor: { source: SOURCE, id: note.author },
    human: !isMe(note.author, me), ...(mentions(note.text, me) ? { addressed: 'mention' as const } : {}),
    at: note.at, text: note.text, channel: giteeChannel(ref.kind, ref.iid, target, url), ...(url ? { url } : {}),
    meta: { kind: 'comment', on: ref.kind, iid: ref.iid, noteId: note.id, ...(note.parent ? { replyTo: note.parent } : {}) } }
}

/** What one event asks for: an issue body, a pull body, a comment, or nothing. */
export type EventOutcome =
  | { activity: 'issue'; iid: number; title?: string }
  | { activity: 'pull'; iid: number; title?: string }
  | { activity: 'comment'; on: GiteeKind; iid: number; note: GiteeNoteView }
/**
 * Classifies one event of the project feed without I/O. A note is a comment; an opened or created issue or pull
 * request is an item body; pushes, projects and lifecycle changes (`merged`, `closed`, `reopened`, `drafted`,
 * `destroyed`) ask for nothing.
 */
export function classifyEvent(event: GiteeEvent): EventOutcome | undefined {
  const note = event.note_data
  // A comment is what asks for work, so when an event names no target type its payload names the target instead.
  const kind = kindOf(event.target_type.trim().toLowerCase())
    ?? (note ? event.issues_data ? 'issue' : event.merge_request_data ? 'pull' : undefined : undefined)
  const iid = event.target_iid ?? (kind === 'issue' ? event.issues_data?.iid : event.merge_request_data?.iid)
  if (!kind || iid == null || !Number.isInteger(iid) || iid <= 0) return undefined
  if (note) {
    const text = (typeof note.note === 'number' ? String(note.note) : note.note ?? '').trim()
    if (!text) return undefined
    return { activity: 'comment', on: kind, iid,
      note: { id: note.id, author: account(note.author) || (event.author_username ?? '').trim(),
        at: note.created_at ?? event.created_at, text } }
  }
  const action = event.action_name.trim().toLowerCase()
  if (action !== 'opened' && action !== 'created') return undefined
  const title = ((kind === 'issue' ? event.issues_data : event.merge_request_data)?.title ?? event.target_title ?? '').trim()
  return kind === 'issue' ? { activity: 'issue', iid, ...(title ? { title } : {}) }
    : { activity: 'pull', iid, ...(title ? { title } : {}) }
}
