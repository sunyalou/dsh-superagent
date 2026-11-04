/** Gitee outbound channel: posts issue and pull request comments under the account the CLI is signed in to. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError, type GiteeTarget } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { giteeMe, giteeNow, readNotes } from './gitee-read.ts'
import type { GiteeRef } from './gitee-trigger.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'

/** True for the toolkit's confirmed missing-item answer; a bare 404 is retried because it can also mean lost visibility. */
const gone = (error: unknown): boolean => error instanceof CliError && /未找到相关|record not found/i.test(error.message)
/** Whether a reply may still reach `address`: an issue or pull request of the configured repository, never one of a previous repository. */
export function giteeAllowed(address: Record<string, string>, config: { repository: string }): boolean {
  return Number(address.iid) > 0 && (address.on === 'issue' || address.on === 'pull')
    && sameName(address.repository ?? '', config.repository)
}
/** Posts a comment on an issue or pull request once per message id; `gone` only when the item can never take it. */
export async function sendGitee(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const { on, iid: iidText = '', repository = '', cli = '' } = message.channel.address
  const iid = Number(iidText)
  if ((on !== 'issue' && on !== 'pull') || !Number.isInteger(iid) || iid <= 0 || !repository || !cli) {
    throw new Error('Missing Gitee reply target')
  }
  const target: GiteeTarget = { cli, repository }
  const ref: GiteeRef = { kind: on, iid, repository }
  const marker = `<!-- dsh-superagent:${message.id} -->`
  try {
    const me = await giteeMe(commands, target)
    // Only the agent's own comment counts, so a quote of the marker in someone else's comment cannot fake delivery.
    const posted = (await readNotes(commands, target, ref)).some(note => sameName(note.author, me) && note.text.includes(marker))
    if (posted) return 'sent'
    const text = `${message.text}\n\n${marker}`
    if (on === 'issue') {
      await commands.gitee(target, z.unknown(), `/projects/:id/issues/${iid}/notes`,
        { method: 'POST', body: { body: text, created_at: giteeNow() } })
    } else {
      await commands.gitee(target, z.unknown(), `/projects/:id/merge_requests/${iid}/notes`,
        { method: 'POST', body: { note: text, noteable_type: 'PullRequest' } })
    }
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
/** An issue has no web URL on this platform, so only a reply that carries one can be opened. */
export function giteeLink(address: Record<string, string>, _links: ChannelLinks): ChannelLink {
  const iid = address.iid ?? ''
  return { url: address.url ?? '', label: address.on === 'pull'
    ? { zh: `Gitee pull request !${iid}`, en: `Gitee pull request !${iid}` }
    : { zh: `Gitee issue #${iid}`, en: `Gitee issue #${iid}` } }
}
