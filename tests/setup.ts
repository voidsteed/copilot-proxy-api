import { afterEach } from "bun:test"

const nativeFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = nativeFetch
})
