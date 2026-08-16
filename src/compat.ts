/**
 * 宿主 API 的最小本地实现（避免运行时依赖 @deepseek-ai/dsh-skill / dsh-llm，
 * 让构建产物完全自包含，任何安装位置都能加载）。
 * 语义与官方实现一致（见 DSH 0.1.0-rc.6 源码）：
 *  - isSkillName: /^[a-z0-9]+(?:-[a-z0-9]+)*$/
 *  - createUserMessage: {...input, role: 'user', id: randomUUID()}（id 无验证品牌）
 * @module dsh-claude-in/compat
 */
import { randomUUID } from 'node:crypto'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name)
}

export function createUserMessage<T extends { content: unknown; source: unknown }>(input: T): T & { role: 'user'; id: string } {
  return {
    ...input,
    role: 'user' as const,
    id: randomUUID(),
  }
}
