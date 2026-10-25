/**
 * parsers — JSONL event-stream assemblers shared by the spawn engines.
 * Each factory returns {push(line), result()} → {text, meta}.
 * All factories take an optional onDelta(text) called per accepted text chunk
 * as it arrives (live output for the panel run box); result() stays the only
 * authority on the final text, so deltas are display-only and skippable.
 */

/**
 * Claude Code `stream-json`. The same assistant message id is emitted once per
 * content block (thinking, then text) — verified empirically 2026-10-26 on a
 * live tool-use run: events are per-block increments, never cumulative
 * snapshots, and every observed id carries at most one text block. Text blocks
 * are therefore APPENDED per id (a hypothetical second text block must not be
 * lost; on a non-claude clone emitting cumulative snapshots the worst case is
 * duplication, which hurts less than loss), and the ordered ids are joined —
 * dropping duplicate blocks without losing turns.
 * Also the house parser for every claude-protocol clone (codebuddy, deveco, csc).
 */
export function parseClaudeStream(onDelta) {
  const messages = new Map()
  const order = []
  const meta = {}

  return {
    push(line) {
      let event
      try {
        event = JSON.parse(line)
      } catch {
        return
      }
      if (event?.type === 'assistant' && Array.isArray(event.message?.content)) {
        const id = event.message.id || `anon-${order.length}`
        const text = event.message.content
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
        if (text) {
          if (!messages.has(id)) order.push(id)
          messages.set(id, (messages.get(id) || '') + text)
          if (onDelta) onDelta(text)
        }
        if (event.message.model) meta.model = event.message.model
      } else if (event?.type === 'result') {
        if (typeof event.result === 'string' && event.result.trim()) meta.finalResult = event.result
        meta.sessionId = event.session_id || meta.sessionId
        if (typeof event.total_cost_usd === 'number') meta.costUsd = event.total_cost_usd
        if (event.usage?.output_tokens) meta.outputTokens = event.usage.output_tokens
        const first = event.modelUsage && Object.keys(event.modelUsage)[0]
        if (first && !meta.model) meta.model = first
      } else if (event?.type === 'system' && event.subtype === 'init') {
        meta.sessionId = event.session_id || meta.sessionId
      }
    },
    result() {
      const text = order.length
        ? order.map((id) => messages.get(id)).filter(Boolean).join('\n')
        : meta.finalResult || ''
      return { text: text || meta.finalResult || '', meta }
    },
  }
}

/** Best-effort reader for CLIs whose JSON event schema we have not pinned down:
 *  pull every plausible text field out of each line. */
export function parseGenericJsonLines(onDelta) {
  const texts = []
  const meta = {}
  return {
    push(line) {
      let event
      try {
        event = JSON.parse(line)
      } catch {
        texts.push(line)
        if (onDelta) onDelta(line)
        return
      }
      const found = collectText(event)
      if (found) {
        texts.push(found)
        if (onDelta) onDelta(found)
      }
      if (event?.session_id) meta.sessionId = event.session_id
      if (event?.model) meta.model = event.model
      if (typeof event?.cost_usd === 'number') meta.costUsd = event.cost_usd
    },
    result() {
      return { text: texts.join('').trim(), meta }
    },
  }
}

function collectText(node, depth = 0) {
  if (depth > 6 || node === null || node === undefined) return ''
  if (typeof node === 'string') return ''
  if (Array.isArray(node)) return node.map((item) => collectText(item, depth + 1)).join('')
  if (typeof node !== 'object') return ''
  if (typeof node.text === 'string') return node.text
  if (typeof node.result === 'string') return node.result
  if (typeof node.content === 'string') return node.content
  if (Array.isArray(node.content))
    return node.content.map((item) => collectText(item, depth + 1)).join('')
  if (node.message) return collectText(node.message, depth + 1)
  return ''
}
