import { writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { deflateSync } from "node:zlib"

const directory = fileURLToPath(new URL("../assets", import.meta.url))
await mkdir(directory, { recursive: true })

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}

function bridgeMark(px: number, py: number): boolean {
  const radius = Math.hypot((px - 0.5) / 0.24, (py - 0.61) / 0.27)
  const arch = py < 0.61 && radius > 0.79 && radius < 1
  const rectangles: Array<[number, number, number, number]> = [
    [0.26, 0.58, 0.31, 0.75],
    [0.69, 0.58, 0.74, 0.75],
    [0.475, 0.36, 0.525, 0.72],
    [0.23, 0.67, 0.77, 0.72],
  ]
  return (
    arch
    || rectangles.some(
      ([left, top, right, bottom]) =>
        px > left && px < right && py > top && py < bottom,
    )
  )
}

function image(size: number, template: boolean): Buffer {
  const pixels = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / size
      const py = (y + 0.5) / size
      const mark = bridgeMark(px, py)
      const corner = Math.hypot(
        Math.max(0, Math.abs(px - 0.5) - 0.31),
        Math.max(0, Math.abs(py - 0.5) - 0.31),
      )
      const visible = template ? mark : corner < 0.16
      let color = [15, 105, 99]
      if (mark) color = [249, 253, 252]
      if (template) color = [34, 41, 46]
      const index = y * (size * 4 + 1) + 1 + x * 4
      pixels[index] = color[0]
      pixels[index + 1] = color[1]
      pixels[index + 2] = color[2]
      pixels[index + 3] = visible ? 255 : 0
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

await writeFile(path.join(directory, "icon.png"), image(1024, false))
await writeFile(path.join(directory, "trayTemplate.png"), image(40, true))
