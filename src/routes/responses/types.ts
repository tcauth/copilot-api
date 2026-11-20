import type {
  ChatCompletionChunk,
  ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

export interface ResponseInputItem {
  type: string
  role?: "developer" | "system" | "user" | "assistant"
  content?: string | Array<ResponseContent>
  call_id?: string
  name?: string
  arguments?: string
  output?: string | Array<ResponseContent>
}

export interface ResponseContent {
  type: string
  text?: string
  image_url?: string
  file_id?: string
  detail?: string
}

export interface ResponseFunctionTool {
  type: string
  name?: string
  description?: string
  parameters?: Record<string, unknown>
  strict?: boolean
}

export interface ResponsesPayload {
  model: string
  input: string | Array<ResponseInputItem>
  stream?: boolean
  tools?: Array<ResponseFunctionTool>
  tool_choice?: "auto" | "none" | "required"
  parallel_tool_calls?: boolean
  reasoning?: {
    effort?: ChatCompletionsPayload["reasoning_effort"]
    summary?: string
  }
  text?: {
    verbosity?: ChatCompletionsPayload["verbosity"]
    format?:
      | { type: "text" }
      | {
          type: "json_schema"
          name: string
          description?: string
          schema: Record<string, unknown>
          strict?: boolean
        }
  }
  store?: boolean
  previous_response_id?: string | null
  service_tier?: string
  truncation?: string
  include?: Array<string>
  prompt_cache_key?: string
  prompt_cache_options?: unknown
  stream_options?: unknown
  client_metadata?: Record<string, string>
  access_programs?: unknown
  request_country?: unknown
}

export interface ResponseUsage {
  input_tokens: number
  input_tokens_details: { cached_tokens: number }
  output_tokens: number
  output_tokens_details: { reasoning_tokens: number }
  total_tokens: number
}

export type ResponseOutputItem =
  | {
      type: "message"
      id: string
      status: "completed"
      role: "assistant"
      content: Array<{
        type: "output_text"
        text: string
        annotations: Array<never>
      }>
    }
  | {
      type: "function_call"
      id: string
      status: "completed"
      call_id: string
      name: string
      arguments: string
    }

export interface ResponsesResult {
  id: string
  object: "response"
  created_at: number
  status: "completed"
  error: null
  incomplete_details: null
  model: string
  output: Array<ResponseOutputItem>
  parallel_tool_calls: boolean
  store: false
  tool_choice: ResponsesPayload["tool_choice"]
  tools: ResponsesPayload["tools"]
  usage: ResponseUsage
}

export interface ResponsesStreamState {
  responseId?: string
  model: string
  created: boolean
  text: string
  textItemId?: string
  textItemAdded: boolean
  tools: Map<
    number,
    {
      id: string
      callId: string
      name: string
      arguments: string
      added: boolean
    }
  >
  usage?: ChatCompletionChunk["usage"]
}

export {
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
