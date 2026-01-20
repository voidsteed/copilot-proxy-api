// OpenAI Responses API Types

export interface ResponsesApiRequest {
  model: string
  input: string | Array<ResponsesInputItem>
  instructions?: string
  tools?: Array<ResponsesTool>
  tool_choice?: string | { type: string; function?: { name: string } }
  parallel_tool_calls?: boolean
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  stream?: boolean
  store?: boolean
  reasoning?: { effort?: "minimal" | "medium" | "high" }
  text?: {
    format?: {
      type: "json_schema"
      name?: string
      strict?: boolean
      schema?: Record<string, unknown>
      json_schema?: {
        name: string
        strict?: boolean
        schema: Record<string, unknown>
      }
    }
  }
}

export interface ResponsesInputItem {
  role: "system" | "user" | "assistant" | "developer"
  content: string | Array<ResponsesContentPart>
  type?: "message" | "tool_result"
  tool_call_id?: string
  output?: string
}

export interface ResponsesContentPart {
  type: "input_text" | "output_text" | "input_image"
  text?: string
  image_url?: string
}

export interface ResponsesTool {
  type: "function" | "web_search_preview" | "file_search"
  function?: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export interface ResponsesApiResponse {
  id: string
  object: "response"
  created_at: number
  model: string
  output: Array<ResponsesOutputItem>
  output_text: string
  usage?: ResponsesUsage
  status: "completed" | "failed" | "in_progress"
}

export interface ResponsesUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

export interface ResponsesOutputItem {
  id: string
  type: "message" | "function_call" | "reasoning"
  role?: "assistant"
  status?: "completed" | "in_progress"
  content?: Array<ResponsesOutputContent>
  // For function_call type
  name?: string
  arguments?: string
  call_id?: string
  // For reasoning type
  summary?: Array<{ type: "summary_text"; text: string }>
}

export interface ResponsesOutputContent {
  type: "output_text" | "refusal"
  text?: string
}

// Streaming event types
export interface ResponsesStreamEvent {
  type: string
  delta?: string
  item?: ResponsesOutputItem
  output_index?: number
  content_index?: number
  response?: Partial<ResponsesApiResponse>
}
