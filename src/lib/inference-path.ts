const inferencePaths = new Set([
  "/chat/completions",
  "/v1/chat/completions",
  "/responses",
  "/v1/responses",
  "/messages",
  "/v1/messages",
  "/embeddings",
  "/v1/embeddings",
])

export function isGeminiInferencePath(path: string): boolean {
  return /^\/v1beta\/models\/[\w.-]+:(?:generateContent|streamGenerateContent)$/.test(
    path,
  )
}

export function isInferencePath(path: string): boolean {
  return inferencePaths.has(path) || isGeminiInferencePath(path)
}
