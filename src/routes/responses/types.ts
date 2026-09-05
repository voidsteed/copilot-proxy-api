// OpenAI Responses API Types

type ResponsesInputItemType =
  | "message"
  | "tool_result"
  | "function_call"
  | "function_call_output"
  | "reasoning"
  | "compaction"
  | (string & {})

type ResponsesContentPartType =
  | "input_text"
  | "output_text"
  | "input_image"
  | "input_file"
  | (string & {})

type ResponsesContextManagementType = "compaction" | (string & {})

type ResponsesToolType =
  | "function"
  | "web_search"
  | "web_search_preview"
  | "file_search"
  | "image_generation"
  | (string & {})

export interface ResponsesApiRequest {
  model: string
  input: string | Array<ResponsesInputItem>
  instructions?: string | null
  tools?: Array<ResponsesTool>
  tool_choice?:
    | string
    | { type: string; function?: { name: string }; name?: string }
  parallel_tool_calls?: boolean
  max_output_tokens?: number | null
  temperature?: number | null
  top_p?: number | null
  stream?: boolean
  store?: boolean
  previous_response_id?: string | null
  include?: Array<string>
  metadata?: Record<string, string> | null
  service_tier?: string | null
  prompt_cache_key?: string | null
  prompt_cache_retention?: "in_memory" | "24h" | null
  safety_identifier?: string | null
  context_management?: Array<ResponsesContextManagementItem> | null
  reasoning?: {
    effort?:
      | "none"
      | "minimal"
      | "low"
      | "medium"
      | "high"
      | "xhigh"
      | "max"
      | null
    summary?: "auto" | "concise" | "detailed" | null
  } | null
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
  [key: string]: unknown
}

export interface ResponsesInputItem {
  role?: "system" | "user" | "assistant" | "developer"
  content?: string | Array<ResponsesContentPart>
  type?: ResponsesInputItemType
  tools?: Array<ResponsesTool>
  tool_call_id?: string
  call_id?: string
  name?: string
  arguments?: string
  output?: string | Array<ResponsesContentPart>
  status?: string
  summary?: Array<{ type: "summary_text"; text: string }>
  encrypted_content?: string
  [key: string]: unknown
}

export interface ResponsesContentPart {
  type: ResponsesContentPartType
  text?: string
  image_url?: string | null
  file_data?: string | null
  file_id?: string | null
  filename?: string | null
  detail?: "low" | "high" | "auto"
  [key: string]: unknown
}

export interface ResponsesContextManagementItem {
  type: ResponsesContextManagementType
  compact_threshold?: number
  [key: string]: unknown
}

export interface ResponsesTool {
  type: ResponsesToolType
  function?: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
  name?: string
  description?: string
  parameters?: Record<string, unknown>
  strict?: boolean | null
  [key: string]: unknown
}

export interface ResponsesApiResponse {
  id: string
  object: "response"
  created_at: number
  model: string
  output: Array<ResponsesOutputItem>
  output_text: string
  usage?: ResponsesUsage
  status: "completed" | "failed" | "in_progress" | "incomplete"
  incomplete_details?: {
    reason?: "max_output_tokens" | "content_filter"
  } | null
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
  status?: "completed" | "in_progress" | "incomplete"
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
