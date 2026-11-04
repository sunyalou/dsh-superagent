/** Reads a Gitee issue or pull request, its comments, the account behind the CLI, and a Trigger's own conversation. */
import type { z } from 'zod'
import type { Commands, GiteeTarget } from '../infra/commands.ts'
import { DiscussionListSchema, DiscussionSchema, IssueSchema, MeSchema, PullSchema, account, discussionsOf,
  refOf, topicText, type GiteeNoteView, type GiteeRef, type GiteeTopic } from './gitee-trigger.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

/** `2026-08-01 10:00[:00][.123][+08:00]` or the same with a `T`, with an optional offset and `Z` for UTC. */
const TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/
/**
 * Parses a platform timestamp into epoch milliseconds: a `T` separator or a space, optional fractional seconds and
 * offset, and a value without an offset as `+08:00`, which is what the platform means. Unparsable values are `NaN`,
 * so a caller can keep its own order rather than invent one.
 */
export function giteeTime(value: string): number {
  const match = TIME.exec(value.trim())
  if (!match) return NaN
  const [, year, month, day, hour = '00', minute = '00', second = '00', fraction = '', offset] = match
  const zone = (offset ?? '+08:00').replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')
  return Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}.${(fraction + '000').slice(0, 3)}${zone}`)
}
/** The timestamp a new issue comment carries: local `YYYY-MM-DD HH:MM:SS`, which the platform takes as `+08:00`. */
export const giteeNow = (): string => new Date().toLocaleString('sv-SE', { hour12: false }).slice(0, 19)

/** Reads an issue or pull request's title and description; a PR also yields its `web_url`. */
export async function readTopic(commands: Commands, target: GiteeTarget, ref: GiteeRef,
  fallback?: { at?: string; author?: string; title?: string }): Promise<GiteeTopic> {
  if (ref.kind === 'issue') {
    const issue = await commands.gitee(target, IssueSchema, `/projects/:id/issues/${ref.iid}`)
    return { kind: 'issue', iid: ref.iid, title: issue.title || fallback?.title || '', text: issue.description ?? '',
      at: issue.created_at || fallback?.at || new Date().toISOString(), author: account(issue.author) || fallback?.author || '' }
  }
  const pull = await commands.gitee(target, PullSchema, `/projects/:id/merge_requests/${ref.iid}`)
  return { kind: 'pull', iid: ref.iid, title: pull.title || fallback?.title || '', text: pull.description ?? '',
    at: pull.created_at || fallback?.at || new Date().toISOString(), author: account(pull.author) || fallback?.author || '',
    ...(pull.web_url ? { url: pull.web_url } : {}) }
}

/** Every note of a discussion node in display order: the root text, its `notes[]`, then their `children[]`. */
export function discussionNotes(node: z.infer<typeof DiscussionSchema>): GiteeNoteView[] {
  const notes: GiteeNoteView[] = []
  const seen = new Set<number>()
  const emit = (note: GiteeNoteView): void => {
    if (seen.has(note.id)) return
    seen.add(note.id)
    notes.push(note)
  }
  const now = new Date().toISOString()
  const body = node.body ?? ''
  const flat = typeof node.note === 'string' ? node.note : typeof node.note === 'number' ? String(node.note) : ''
  const root = body.trim() ? node.id : undefined
  if (root !== undefined) emit({ id: node.id, author: account(node.author), at: node.created_at ?? now, text: body })
  for (const note of node.notes ?? []) {
    if (note.note?.trim()) {
      emit({ id: note.id, author: account(note.author), at: note.created_at ?? node.created_at ?? now, text: note.note,
        ...(root !== undefined ? { parent: root } : {}) })
    }
    for (const child of note.children ?? []) {
      if (child.note?.trim()) {
        emit({ id: child.id, author: account(child.author), at: child.created_at ?? note.created_at ?? node.created_at ?? now,
          text: child.note, parent: note.id })
      }
    }
  }
  // Some PR paths nest replies on the node itself, under no note that could be their parent.
  const under = root ?? (flat.trim() ? node.id : undefined)
  for (const child of node.children ?? []) {
    if (child.note?.trim()) {
      emit({ id: child.id, author: account(child.author), at: child.created_at ?? node.created_at ?? now, text: child.note,
        ...(under !== undefined ? { parent: under } : {}) })
    }
  }
  if (!body.trim() && flat.trim()) emit({ id: node.id, author: account(node.author), at: node.created_at ?? now, text: flat })
  return notes
}

/** Reads every comment of an issue or pull request, oldest first, from `discussions`, which the platform returns whole. */
export async function readNotes(commands: Commands, target: GiteeTarget, ref: GiteeRef): Promise<GiteeNoteView[]> {
  const path = `/projects/:id/${ref.kind === 'issue' ? 'issues' : 'merge_requests'}/${ref.iid}/discussions`
  const nodes = discussionsOf(await commands.gitee(target, DiscussionListSchema, path))
  // An unparsable timestamp keeps its input position: the platform's order is the only evidence of that note's place.
  return nodes.flatMap(discussionNotes).map(note => ({ note, time: giteeTime(note.at) }))
    .sort((a, b) => Number.isFinite(a.time) && Number.isFinite(b.time) ? a.time - b.time : 0)
    .map(item => item.note)
}

/** The model-facing form of notes: the only mapping from GiteeNoteView to ContextMessage. */
export const messagesOf = (notes: readonly GiteeNoteView[]): ContextMessage[] =>
  notes.map(note => ({ id: String(note.id), from: note.author, at: note.at, text: note.text,
    ...(note.parent !== undefined ? { reply_to: String(note.parent) } : {}) }))

/** The account the CLI is signed in to. */
export async function giteeMe(commands: Commands, target: GiteeTarget): Promise<string> {
  return (await commands.gitee(target, MeSchema, '/user')).username
}

/** Context reader for a Gitee Trigger: the item's own text, then its comments in the order the platform shows them. */
export const giteeThreadContext: ThreadContext<unknown> = {
  messageId: trigger => trigger.meta.kind === 'comment'
    ? String(trigger.meta.noteId) : `topic:${String(trigger.meta.iid)}`,
  read: async (commands, trigger, part, _cursor, _config) => {
    const ref = refOf(trigger)
    const address = trigger.channel?.address ?? {}
    const target: GiteeTarget = { cli: String(address.cli ?? ''), repository: String(address.repository ?? '') }
    if (!target.cli || !target.repository) throw new Error('The Gitee Trigger carries no repository')
    const topic = await readTopic(commands, target, ref)
    const notes = await readNotes(commands, target, ref)
    const root: ContextMessage = { id: `topic:${ref.iid}`, from: topic.author, at: topic.at, text: topicText(topic),
      ...(topic.url ? { url: topic.url } : {}) }
    if (part === 'thread') {
      const messages = [root, ...messagesOf(notes)]
      return { messages, body: { messages } }
    }
    if (part === 'root') return { messages: [root], body: { messages: [root] } }
    const parent = notes.filter(note => note.id === Number(trigger.meta.replyTo))
    const messages = parent.length ? messagesOf(parent) : [root]
    return { messages, body: { messages } }
  },
}
