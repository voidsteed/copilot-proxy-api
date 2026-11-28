import { request } from "node:http"
import { z } from "zod"

process.once("message", (message) => {
  const { origin, headers } = z
    .object({
      origin: z.url(),
      headers: z.record(z.string(), z.string()),
    })
    .parse(message)
  const req = request(origin, { method: "POST", headers }, (res) => {
    res.once("data", (chunk) => {
      if (!Buffer.isBuffer(chunk)) throw new Error("Expected stream bytes")
      const socket = res.socket
      socket.once("close", () => {
        process.send({
          bytes: chunk.length,
          destroyed: req.destroyed && res.destroyed && socket.destroyed,
        })
        process.disconnect()
      })
      res.destroy()
      req.destroy()
    })
  })
  req.once("error", () => process.exit(1))
  req.setTimeout(8000, () => process.exit(2))
  req.end(
    JSON.stringify({
      model: "fixture-responses-only",
      input: "fixture:long",
      stream: true,
    }),
  )
})
