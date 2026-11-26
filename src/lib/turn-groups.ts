import type { Message } from "~/services/copilot/create-chat-completions"

export const TOOL_IMAGE_HEADER =
  "Attached image(s) returned by the preceding tool call(s):"
export const IMAGE_STRIPPED_PLACEHOLDER = "[image removed to save context]"
export const IMAGE_LIMIT_PLACEHOLDER =
  "[earlier image omitted to fit Copilot's image limit]"
export const HISTORY_OMITTED_USER_MESSAGE: Message = {
  role: "user",
  content: "[earlier conversation history omitted to fit context]",
}

const OVERSIZED_IMAGE_PLACEHOLDER_PATTERN =
  /^\[image omitted: exceeds Copilot's .+ image limit\]$/

export interface ConversationTurnGroup {
  kind: "tool_round" | "orphaned_artifact" | "single_turn"
  messages: Array<Message>
}

export function normalizeMessageParts(msg: Message): Message {
  if (!Array.isArray(msg.content)) return msg
  if (!msg.content.every((part) => part.type === "text")) return msg
  return {
    ...msg,
    content: msg.content.map((part) => part.text).join("\n\n"),
  }
}

function isImagePlaceholderText(text: string): boolean {
  return (
    text === IMAGE_STRIPPED_PLACEHOLDER
    || text === IMAGE_LIMIT_PLACEHOLDER
    || OVERSIZED_IMAGE_PLACEHOLDER_PATTERN.test(text)
  )
}

function isSyntheticToolImagePart(part: unknown): boolean {
  if (typeof part !== "object" || part === null || !("type" in part)) {
    return false
  }
  if (part.type === "image_url") return true
  return (
    part.type === "text"
    && "text" in part
    && typeof part.text === "string"
    && isImagePlaceholderText(part.text)
  )
}

function isSyntheticToolImageUserMessage(msg: Message): boolean {
  if (msg.role !== "user") return false
  if (Array.isArray(msg.content)) {
    if (msg.content.length < 2) return false
    const first = msg.content[0]
    if (first.type !== "text" || first.text !== TOOL_IMAGE_HEADER) {
      return false
    }
    return msg.content.slice(1).every((part) => isSyntheticToolImagePart(part))
  }
  if (typeof msg.content === "string") {
    if (!msg.content.startsWith(`${TOOL_IMAGE_HEADER}\n\n`)) return false
    const segments = msg.content.split("\n\n")
    return (
      segments.length >= 2
      && segments.slice(1).every((segment) => isImagePlaceholderText(segment))
    )
  }
  return false
}

function consumeToolRound(
  conversationMessages: Array<Message>,
  startIndex: number,
): { group: ConversationTurnGroup; nextIndex: number } {
  const roundMessages: Array<Message> = [conversationMessages[startIndex]]
  let index = startIndex + 1
  let sawTool = false
  while (
    index < conversationMessages.length
    && conversationMessages[index].role === "tool"
  ) {
    roundMessages.push(conversationMessages[index])
    sawTool = true
    index++
  }
  if (!sawTool) {
    return {
      group: {
        kind: "single_turn",
        messages: [conversationMessages[startIndex]],
      },
      nextIndex: index,
    }
  }
  if (
    index < conversationMessages.length
    && isSyntheticToolImageUserMessage(conversationMessages[index])
  ) {
    roundMessages.push(conversationMessages[index])
    index++
  }
  return {
    group: { kind: "tool_round", messages: roundMessages },
    nextIndex: index,
  }
}

export function partitionTurnGroups(
  conversationMessages: Array<Message>,
): Array<ConversationTurnGroup> {
  const groups: Array<ConversationTurnGroup> = []
  let index = 0

  while (index < conversationMessages.length) {
    const msg = conversationMessages[index]
    if (msg.role === "assistant" && (msg.tool_calls?.length ?? 0) > 0) {
      const consumed = consumeToolRound(conversationMessages, index)
      groups.push(consumed.group)
      index = consumed.nextIndex
      continue
    }

    if (msg.role === "tool" || isSyntheticToolImageUserMessage(msg)) {
      groups.push({ kind: "orphaned_artifact", messages: [msg] })
      index++
      continue
    }

    groups.push({ kind: "single_turn", messages: [msg] })
    index++
  }

  return groups
}

export function stripOrphanedArtifacts(groups: Array<ConversationTurnGroup>): {
  groups: Array<ConversationTurnGroup>
  orphansDropped: number
} {
  const remaining: Array<ConversationTurnGroup> = []
  let orphansDropped = 0

  for (const group of groups) {
    if (group.kind === "orphaned_artifact") {
      orphansDropped += group.messages.length
    } else {
      remaining.push(group)
    }
  }

  if (remaining.length === 0) return { groups, orphansDropped: 0 }
  return { groups: remaining, orphansDropped }
}
