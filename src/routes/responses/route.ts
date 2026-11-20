import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleResponse } from "./handler"
import { UnsupportedResponsesFeatureError } from "./translation"

export const responseRoutes = new Hono()

responseRoutes.post("/", async (c) => {
  try {
    return await handleResponse(c)
  } catch (error) {
    if (error instanceof UnsupportedResponsesFeatureError) {
      return c.json(
        {
          error: {
            message: error.message,
            type: "invalid_request_error",
            code: error.code,
          },
        },
        400,
      )
    }
    return await forwardError(c, error)
  }
})
