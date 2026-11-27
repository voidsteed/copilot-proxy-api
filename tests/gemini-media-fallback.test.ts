import { afterEach, beforeEach, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import { server } from "~/server"

const originalFetch = globalThis.fetch
const model: Model = {
  id: "gemini-4-neon",
  name: "Gemini 4 Neon",
  vendor: "Google",
  object: "model",
  version: "1",
  preview: true,
  model_picker_enabled: true,
  supported_endpoints: ["/chat/completions"],
  capabilities: {
    family: "gemini-4-neon",
    type: "chat",
    object: "model_capabilities",
    tokenizer: "o200k_base",
    limits: { max_output_tokens: 65536 },
    supports: {
      vision: true,
      streaming: true,
      tool_calls: true,
      reasoning_effort: ["low", "medium", "high", "xhigh"],
    },
  },
}

interface CapturedRequest {
  body: Record<string, unknown>
  headers: Headers
}

let captured: Array<CapturedRequest> = []
let upstreamResponder: (
  input: string | URL | Request,
  init?: RequestInit,
) => Response = () =>
  Response.json({
    id: "reply",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
  })

function generate(body: unknown, stream = false) {
  const endpoint =
    stream ?
      `/v1beta/models/${model.id}:streamGenerateContent?alt=sse`
    : `/v1beta/models/${model.id}:generateContent`
  return server.request(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function buildMinimalTextPdf(text: string): string {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ]
  let pdf = "%PDF-1.4\n"
  const offsets: Array<number> = [0]
  for (const obj of objects) {
    offsets.push(pdf.length)
    pdf += obj
  }
  const xrefOffset = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, "utf8").toString("base64")
}

beforeEach(() => {
  captured = []
  upstreamResponder = () =>
    Response.json({
      id: "reply",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
    })
  state.models = { object: "list", data: [model] }
  state.copilotToken = "fake-upstream"
  state.githubToken = undefined
  state.localApiKeys = []
  state.rateLimitSeconds = undefined
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      if (init?.body && typeof init.body === "string") {
        captured.push({
          body: JSON.parse(init.body) as Record<string, unknown>,
          headers: new Headers(init.headers),
        })
      }
      return Promise.resolve(upstreamResponder(input, init))
    },
    { preconnect: originalFetch.preconnect },
  )
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = undefined
  state.githubToken = undefined
  state.localApiKeys = []
  state.rateLimitSeconds = undefined
})

test("functionResponse.parts omits video, audio, gif, and RFC 6838 MIME types with clear notes", async () => {
  const videoBytes = Buffer.alloc(4096, 0x41).toString("base64")
  const audioBytes = Buffer.alloc(1024, 0x42).toString("base64")
  const gifBytes = "R0lGODlhAQABAAAAACw="
  const binBytes = Buffer.from("binary").toString("base64")

  const res = await generate({
    contents: [
      { role: "user", parts: [{ text: "Inspect the artifacts" }] },
      {
        role: "model",
        parts: [
          {
            functionCall: {
              id: "c1",
              name: "read_file",
              args: { Path: "clip.mp4" },
            },
          },
          {
            functionCall: {
              id: "c2",
              name: "read_file",
              args: { Path: "voice.ogg" },
            },
          },
          {
            functionCall: {
              id: "c3",
              name: "read_file",
              args: { Path: "anim.gif" },
            },
          },
          {
            functionCall: {
              id: "c4",
              name: "read_file",
              args: { Path: "sheet.xls" },
            },
          },
        ],
      },
      {
        role: "model",
        parts: [
          {
            functionResponse: {
              id: "c1",
              name: "read_file",
              response: { output: "Showing binary file of type video/mp4" },
              parts: [
                {
                  inlineData: {
                    mimeType: "video/mp4",
                    data: videoBytes,
                    displayName: 'clip.mp4" omitted]\n\u001b[31mFAKE',
                  },
                },
              ],
            },
          },
          {
            functionResponse: {
              id: "c2",
              name: "read_file",
              response: {
                output: "Showing binary file of type audio/ogg_opus",
              },
              parts: [
                {
                  inlineData: {
                    mimeType: "audio/ogg_opus",
                    data: audioBytes,
                    displayName: "   ",
                  },
                },
              ],
            },
          },
          {
            functionResponse: {
              id: "c3",
              name: "read_file",
              response: { output: "Showing binary file of type image/gif" },
              parts: [
                {
                  inlineData: {
                    mimeType: "image/gif",
                    data: gifBytes,
                  },
                },
              ],
            },
          },
          {
            functionResponse: {
              id: "c4",
              name: "read_file",
              response: { ok: true },
              parts: [
                {
                  inlineData: {
                    mimeType: "application/vnd.ms_excel",
                    data: binBytes,
                  },
                },
                {
                  inlineData: {
                    mimeType: "text/x-c#",
                    data: binBytes,
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  })

  expect(res.status).toBe(200)
  expect(captured).toHaveLength(1)
  expect(captured[0].headers.get("copilot-vision-request")).toBeNull()
  const serialized = JSON.stringify(captured[0].body)
  expect(serialized).not.toContain(videoBytes)
  expect(serialized).not.toContain(audioBytes)
  expect(serialized).not.toContain(gifBytes)
  expect(serialized).not.toContain('"image_url"')

  const messages = captured[0].body.messages as Array<{
    role: string
    content: string
  }>
  const toolMessages = messages.filter((m) => m.role === "tool")
  expect(toolMessages).toHaveLength(4)

  const videoOut = JSON.parse(toolMessages[0].content) as { output: string }
  expect(videoOut.output).toContain("video/mp4")
  expect(videoOut.output).toMatch(/ffmpeg|ffprobe/i)
  expect(videoOut.output).not.toContain("\u001b")
  expect(videoOut.output).not.toContain('clip.mp4" omitted]')

  const audioOut = JSON.parse(toolMessages[1].content) as { output: string }
  expect(audioOut.output).toContain("audio/ogg_opus")
  expect(audioOut.output).not.toContain('Attachment "   "')

  const gifOut = JSON.parse(toolMessages[2].content) as { output: string }
  expect(gifOut.output).toContain("image/gif")
  expect(gifOut.output).toMatch(/PNG|JPEG|WebP/i)

  const miscOut = JSON.parse(toolMessages[3].content) as {
    ok: boolean
    output: string
  }
  expect(miscOut.ok).toBe(true)
  expect(miscOut.output).toContain("application/vnd.ms_excel")
  expect(miscOut.output).toContain("text/x-c#")
})

test("5.8 MB video/mp4 in functionResponse.parts is stripped before the 5 MB wire ceiling over SSE", async () => {
  upstreamResponder = () =>
    new Response(
      `data: ${JSON.stringify({
        id: "chunk-1",
        choices: [
          {
            index: 0,
            delta: { content: "continued" },
            finish_reason: "stop",
          },
        ],
      })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )

  const largeVideoBase64 = Buffer.alloc(5_800_000, 0x20).toString("base64")
  const res = await generate(
    {
      contents: [
        { role: "user", parts: [{ text: "Earlier turn context" }] },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "c-big-vid",
                name: "read_file",
                args: { Path: "recording.mp4" },
              },
            },
          ],
        },
        {
          role: "model",
          parts: [
            {
              functionResponse: {
                id: "c-big-vid",
                name: "read_file",
                response: { output: "Showing binary file of type video/mp4" },
                parts: [
                  {
                    inlineData: {
                      mimeType: "video/mp4",
                      data: largeVideoBase64,
                      displayName: "recording.mp4",
                    },
                  },
                ],
              },
            },
          ],
        },
        { role: "user", parts: [{ text: "continue" }] },
      ],
    },
    true,
  )

  expect(res.status).toBe(200)
  const sseText = await res.text()
  expect(sseText).toContain("continued")
  expect(captured).toHaveLength(1)
  expect(captured[0].headers.get("copilot-vision-request")).toBeNull()
  const wireBytes = Buffer.byteLength(JSON.stringify(captured[0].body), "utf8")
  expect(wireBytes).toBeLessThan(10_000)
  expect(JSON.stringify(captured[0].body)).toContain("Earlier turn context")
  expect(JSON.stringify(captured[0].body)).toContain("5.5 MB")
})

test("functionResponse.parts normalizes supported images, tolerates 0-byte and wrapped/base64url payloads", async () => {
  const pngStandard = Buffer.from([0xfb, 0xff, 0xfe, 0x01]).toString("base64")
  const pngWrappedBase64Url = `${pngStandard.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}\r\n`

  const res = await generate({
    contents: [
      { role: "user", parts: [{ text: "Check attachments" }] },
      {
        role: "model",
        parts: [
          {
            functionCall: {
              id: "c-mix",
              name: "read_file",
              args: { Path: "bundle" },
            },
          },
        ],
      },
      {
        role: "model",
        parts: [
          {
            functionResponse: {
              id: "c-mix",
              name: "read_file",
              response: { output: "Loaded attachments" },
              parts: [
                {
                  inlineData: {
                    mimeType: "IMAGE/PNG; charset=binary",
                    data: pngWrappedBase64Url,
                  },
                },
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: "",
                    displayName: "empty.png",
                  },
                },
                {
                  inlineData: {
                    mimeType: "video/mp4; codecs=avc1",
                    data: "",
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  })

  expect(res.status).toBe(200)
  const messages = captured[0].body.messages as Array<{
    role: string
    content: unknown
  }>
  const toolMessage = messages.find((m) => m.role === "tool")
  const toolContent = JSON.parse(String(toolMessage?.content)) as {
    output: string
  }
  expect(toolContent.output).toContain("empty.png")
  expect(toolContent.output).toContain("0 B")
  expect(toolContent.output).toContain("video/mp4")

  const imageMessage = messages.at(-1)
  expect(imageMessage?.role).toBe("user")
  expect(imageMessage?.content).toEqual([
    {
      type: "text",
      text: "Attached image(s) returned by the preceding tool call(s):",
    },
    {
      type: "image_url",
      image_url: { url: `data:image/png;base64,${pngStandard}` },
    },
  ])
})

test("structured functionResponse.response separates extracted PDFs from omitted media without clobbering existing keys", async () => {
  const validPdf = buildMinimalTextPdf("Quarterly report")
  const badPdf = Buffer.from("not a pdf").toString("base64")

  const res = await generate({
    contents: [
      { role: "user", parts: [{ text: "Inspect docs" }] },
      {
        role: "model",
        parts: [
          { functionCall: { id: "c-1", name: "fetch_docs" } },
          { functionCall: { id: "c-2", name: "fetch_docs" } },
        ],
      },
      {
        role: "model",
        parts: [
          {
            functionResponse: {
              id: "c-1",
              name: "fetch_docs",
              response: {
                output: { ok: true, id: 1 },
                omittedAttachments: ["existing-note"],
              },
              parts: [
                {
                  inlineData: {
                    mimeType: "application/pdf",
                    data: validPdf,
                    displayName: "report.pdf",
                  },
                },
                {
                  inlineData: {
                    mimeType: "application/pdf",
                    data: badPdf,
                    displayName: "corrupt.pdf",
                  },
                },
              ],
            },
          },
          {
            functionResponse: {
              id: "c-2",
              name: "fetch_docs",
              response: {
                output: { ok: true, id: 2 },
                omittedAttachments: 0,
                proxyOmittedAttachments: "keep-me",
              },
              parts: [
                {
                  inlineData: {
                    mimeType: "video/mp4",
                    data: "AAAA",
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  })

  expect(res.status).toBe(200)
  const messages = captured[0].body.messages as Array<{
    role: string
    content: string
  }>
  const toolMessages = messages.filter((m) => m.role === "tool")

  const first = JSON.parse(toolMessages[0].content) as {
    output: unknown
    extractedDocuments: Array<string>
    omittedAttachments: Array<string>
  }
  expect(first.output).toEqual({ ok: true, id: 1 })
  expect(first.extractedDocuments).toHaveLength(1)
  expect(first.extractedDocuments[0]).toContain("Quarterly report")
  expect(first.omittedAttachments).toHaveLength(2)
  expect(first.omittedAttachments[0]).toBe("existing-note")
  expect(first.omittedAttachments[1]).toContain("corrupt.pdf")
  expect(first.omittedAttachments[1]).toContain(
    "Invalid or corrupted PDF document",
  )

  const second = JSON.parse(toolMessages[1].content) as {
    output: unknown
    omittedAttachments: unknown
    proxyOmittedAttachments: unknown
    proxyOmittedAttachments_2?: Array<string>
  }
  expect(second.output).toEqual({ ok: true, id: 2 })
  expect(second.omittedAttachments).toBe(0)
  expect(second.proxyOmittedAttachments).toBe("keep-me")
  expect(second.proxyOmittedAttachments_2).toHaveLength(1)
  expect(second.proxyOmittedAttachments_2?.[0]).toContain("video/mp4")
})

test("top-level user media enforces supported types, normalizes MIME case/params, and rejects model-role PDFs", async () => {
  const videoRes = await generate({
    contents: [
      {
        role: "user",
        parts: [{ inlineData: { mimeType: "video/mp4", data: "AAAA" } }],
      },
    ],
  })
  expect(videoRes.status).toBe(400)
  const videoBody = (await videoRes.json()) as { error: { message: string } }
  expect(videoBody.error.message).toContain("video/mp4")
  expect(videoBody.error.message).not.toContain("Invalid input")

  for (const badMime of [
    "\r\nimage/png\r\n",
    "image/png; a=1\u2028",
    `${" ".repeat(600)}image/png`,
    "video/mp4\r\n;codecs=avc1",
    "text/c\u017fv",
    `video/${"a".repeat(300)}`,
  ]) {
    const res = await generate({
      contents: [
        {
          role: "user",
          parts: [{ inlineData: { mimeType: badMime, data: "AAAA" } }],
        },
      ],
    })
    expect(res.status).toBe(400)
  }

  for (const badBase64 of ["A", "A=", "A==", "AA=", "AAA=="]) {
    const res = await generate({
      contents: [
        {
          role: "user",
          parts: [{ inlineData: { mimeType: "image/png", data: badBase64 } }],
        },
      ],
    })
    expect(res.status).toBe(400)
  }

  const normalizedRes = await generate({
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: "IMAGE/PNG; charset=binary",
              data: "aGVsbG8=",
            },
          },
        ],
      },
    ],
  })
  expect(normalizedRes.status).toBe(200)
  expect(JSON.stringify(captured[0].body)).toContain(
    "data:image/png;base64,aGVsbG8=",
  )

  const validPdf = buildMinimalTextPdf("Model PDF")
  const modelPdfRes = await generate({
    contents: [
      { role: "user", parts: [{ text: "hello" }] },
      {
        role: "model",
        parts: [
          {
            inlineData: {
              mimeType: "application/pdf",
              data: validPdf,
            },
          },
        ],
      },
    ],
  })
  expect(modelPdfRes.status).toBe(400)
  const modelPdfBody = (await modelPdfRes.json()) as {
    error: { message: string }
  }
  expect(modelPdfBody.error.message).toContain(
    "Model content supports only text and functionCall parts",
  )
})

test("schema validation unwraps part union errors accurately even with asymmetric optional keys", async () => {
  const cases: Array<{
    part: unknown
    expectedPath: string
    expectedText?: string
    forbidden?: string
  }> = [
    {
      part: {
        functionResponse: {
          id: "c1",
          name: "read_file",
          response: { output: "ok" },
          parts: [
            {
              inlineData: { mimeType: "video/mp4", data: "not valid base64!" },
            },
          ],
        },
      },
      expectedPath:
        "contents.0.parts.0.functionResponse.parts.0.inlineData.data",
    },
    {
      part: {
        functionResponse: {
          name: "read_file",
          response: { ok: true },
          parts: [{ inlineData: { mimeType: "video/mp4", data: "bad!" } }],
        },
        thought: false,
        thoughtSignature: "sig",
      },
      expectedPath:
        "contents.0.parts.0.functionResponse.parts.0.inlineData.data",
      forbidden: "contents.0.parts.0.text",
    },
    {
      part: {
        inlineData: null,
        thought: true,
        thoughtSignature: "sig",
      },
      expectedPath: "contents.0.parts.0.inlineData",
      forbidden: "contents.0.parts.0.text",
    },
    {
      part: {
        functionCall: { name: "f" },
        thoughtSignature: 123,
        thought: true,
      },
      expectedPath: "contents.0.parts.0.thoughtSignature",
    },
    {
      part: { text: 123 },
      expectedPath: "contents.0.parts.0.text",
    },
    {
      part: {
        functionResponse: { name: "read_file", response: { ok: true } },
        bogusExtra: true,
      },
      expectedPath: "contents.0.parts.0",
      expectedText: "bogusExtra",
    },
    {
      part: { fileData: { fileUri: "gs://a" }, thought: false },
      expectedPath: "contents.0.parts.0.",
      forbidden: "contents.0.parts.0.text",
    },
    {
      part: { unknownPartKey: true },
      expectedPath: "contents.0.parts.0.",
      forbidden: "contents.0.parts.0.text",
    },
  ]

  for (const item of cases) {
    const res = await generate({
      contents: [{ role: "user", parts: [item.part] }],
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain(item.expectedPath)
    if (item.expectedText) {
      expect(body.error.message).toContain(item.expectedText)
    }
    if (item.forbidden) {
      expect(body.error.message).not.toContain(item.forbidden)
    }
  }

  const hugeExtraKey = `${"k".repeat(400)}\u001b[31m`
  const hugeKeyRes = await generate({
    contents: [
      {
        role: "user",
        parts: [
          {
            functionResponse: { name: "read_file", response: { ok: true } },
            [hugeExtraKey]: true,
          },
        ],
      },
    ],
  })
  expect(hugeKeyRes.status).toBe(400)
  const hugeKeyBody = (await hugeKeyRes.json()) as {
    error: { message: string }
  }
  expect(hugeKeyBody.error.message.length).toBeLessThan(320)
  expect(hugeKeyBody.error.message).not.toContain("\u001b")
})

function singleToolTurn(
  id: string,
  parts: Array<Record<string, unknown>>,
  response: Record<string, unknown> = { output: "ok" },
) {
  return {
    contents: [
      { role: "user", parts: [{ text: "Read" }] },
      {
        role: "model",
        parts: [{ functionCall: { id, name: "read_file" } }],
      },
      {
        role: "model",
        parts: [
          { functionResponse: { id, name: "read_file", response, parts } },
        ],
      },
    ],
  }
}

test("sole unpadded tool image gets padded, malformed tool base64 is rejected, and mass omissions are capped", async () => {
  const unpaddedRes = await generate(
    singleToolTurn("c-pad", [
      { inlineData: { mimeType: "image/png", data: "aGVsbG8" } },
    ]),
  )
  expect(unpaddedRes.status).toBe(200)
  expect(JSON.stringify(captured[0].body)).toContain(
    "data:image/png;base64,aGVsbG8=",
  )

  for (const badToolData of ["_", "A", "A=\n", "A==", "AA=", "a+b_c"]) {
    const badRes = await generate(
      singleToolTurn("c-bad", [
        { inlineData: { mimeType: "image/png", data: badToolData } },
      ]),
    )
    expect(badRes.status).toBe(400)
  }

  const manyVideos = Array.from({ length: 30 }, (_, index) => ({
    inlineData: {
      mimeType: "video/mp4",
      data: "",
      displayName: `clip [${index + 1}].mp4`,
    },
  }))
  const cappedRes = await generate(
    singleToolTurn("c-many", manyVideos, { output: "Loaded clips" }),
  )
  expect(cappedRes.status).toBe(200)
  const messages = captured.at(-1)?.body.messages as Array<{
    role: string
    content: string
  }>
  const toolMessage = messages.find((m) => m.role === "tool")
  const parsedTool = JSON.parse(toolMessage?.content ?? "{}") as {
    output: string
  }
  expect(parsedTool.output).toContain('Attachment "clip (1).mp4" omitted')
  expect(parsedTool.output).toContain(
    "and 10 more unsupported/unreadable attachment(s) omitted",
  )
  expect(parsedTool.output).not.toContain('Attachment "clip (25).mp4" omitted')
})
