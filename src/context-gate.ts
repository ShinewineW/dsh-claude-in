/**
 * Keep dsh-claude-in context out of the first model request.
 *
 * A session becomes ready on its second pre-step. Durable assistant output or
 * a tool call also marks a resumed session ready. Queued context is then
 * returned to the caller for direct inclusion in that model request.
 */

export interface DeferredContextGate {
  attach(agent: any): void
  beginRequest(agent: any): boolean
  ready(agent: any): boolean
  defer(agent: any, message: any): void
  drain(agent: any): any[]
  inject(agent: any, message: any): boolean
}

const PROMOTION_EVENTS = new Set(['assistant/message', 'tool/call'])

function sessionKey(session: any): string | undefined {
  return typeof session?.id === 'string' && session.id.length > 0 ? session.id : undefined
}

function alreadyPromoted(session: any): boolean {
  return Array.isArray(session?.events) && session.events.some((event: any) => PROMOTION_EVENTS.has(event?.type))
}

export function createDeferredContextGate(): DeferredContextGate {
  const seenRequest = new Set<string>()
  const promoted = new Set<string>()
  const pending = new Map<string, any[]>()

  return {
    attach(agent: any): void {
      const session = agent?.session
      const key = sessionKey(session)
      if (key === undefined) return
      if (alreadyPromoted(session)) promoted.add(key)
    },

    beginRequest(agent: any): boolean {
      const session = agent?.session
      const key = sessionKey(session)
      if (key === undefined) return false
      if (promoted.has(key) || alreadyPromoted(session) || seenRequest.has(key)) {
        promoted.add(key)
        return true
      }
      seenRequest.add(key)
      return false
    },

    ready(agent: any): boolean {
      const session = agent?.session
      const key = sessionKey(session)
      return key !== undefined && (promoted.has(key) || alreadyPromoted(session))
    },

    defer(agent: any, message: any): void {
      const key = sessionKey(agent?.session)
      if (key === undefined) return
      const messages = pending.get(key)
      if (messages === undefined) pending.set(key, [message])
      else messages.push(message)
    },

    drain(agent: any): any[] {
      const key = sessionKey(agent?.session)
      if (key === undefined || !promoted.has(key)) return []
      const messages = pending.get(key) ?? []
      pending.delete(key)
      return messages
    },

    inject(agent: any, message: any): boolean {
      const session = agent?.session
      const key = sessionKey(session)
      if (key === undefined) return false
      if (promoted.has(key) || alreadyPromoted(session)) {
        promoted.add(key)
        agent.inject(message)
        return true
      }
      this.defer(agent, message)
      return false
    },
  }
}
