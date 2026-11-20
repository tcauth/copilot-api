import { afterEach, describe, expect, test } from "bun:test"

import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalToken = state.copilotToken
const originalModels = state.models

afterEach(() => {
  state.copilotToken = originalToken
  state.models = originalModels
})

describe("Codex Responses route validation", () => {
  test("requires initialized Copilot authentication", async () => {
    state.copilotToken = undefined
    state.models = undefined

    const response = await server.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", input: "hello" }),
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: { code: "copilot_auth_missing" },
    })
  })

  test("rejects models outside the current Copilot catalog", async () => {
    state.copilotToken = "test-token"
    state.models = { object: "list", data: [] }

    const response = await server.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "missing-model", input: "hello" }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "model_not_found" },
    })
  })

  test("returns an explicit error for unsupported Responses features", async () => {
    state.copilotToken = "test-token"
    state.models = undefined

    const response = await server.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        input: "search",
        tools: [{ type: "web_search" }],
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "unsupported_responses_feature" },
    })
  })

  test("keeps the existing Chat Completions route registered", async () => {
    state.copilotToken = undefined
    const response = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).not.toBe(404)
  })
})
