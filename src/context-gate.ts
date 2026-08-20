/**
 * Keep dsh-claude-in context out of the first model request.
 *
 * A session becomes ready after its first durable assistant output or tool
 * call. Context queued before that point is injected for the next request.
 */

export interface DeferredContextGate {
  attach(agent: any): void
  observe(session: any, event: any): void
  ready(agent: any): boolean
  inject(agent: any, message: any): boolean
}

const PROMOTION_EVENTS = new Set(['assistant/message', 'tool/call'])

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

function alreadyPromoted(session: any): boolean {
  return Array.isArray(session?.events) && session.events.some((event: any) => PROMOTION_EVENTS.has(event?.type))
}

export function createDeferredContextGate(): DeferredContextGate {
  const agents = new WeakMap<object, any>()
  const promoted = new WeakSet<object>()
  const pending = new WeakMap<object, any[]>()

  const promote = (session: object): void => {
    if (promoted.has(session)) return
    promoted.add(session)
    const agent = agents.get(session)
    const messages = pending.get(session)
    pending.delete(session)
    if (agent === undefined || messages === undefined) return
    for (const message of messages) agent.inject(message)
  }

  return {
    attach(agent: any): void {
      const session = agent?.session
      if (!isObject(session)) return
      agents.set(session, agent)
      if (alreadyPromoted(session)) promote(session)
    },

    observe(session: any, event: any): void {
      if (!isObject(session) || !PROMOTION_EVENTS.has(event?.type)) return
      promote(session)
    },

    ready(agent: any): boolean {
      const session = agent?.session
      return isObject(session) && (promoted.has(session) || alreadyPromoted(session))
    },

    inject(agent: any, message: any): boolean {
      const session = agent?.session
      if (!isObject(session)) return false
      agents.set(session, agent)
      if (promoted.has(session) || alreadyPromoted(session)) {
        promote(session)
        agent.inject(message)
        return true
      }
      const messages = pending.get(session)
      if (messages === undefined) pending.set(session, [message])
      else messages.push(message)
      return false
    },
  }
}
