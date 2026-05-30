// Mosaic Web Worker: keeps all heavy, blocking work off the main thread so the
// app stays responsive with thousands of photos.
//
// On ingest it decodes each photo exactly once (via createImageBitmap) to derive
// a tiny color signature and a ~512px JPEG thumbnail, then drops the original.
// On generate it matches tiles to the reference's cells and renders the base
// mosaic into an OffscreenCanvas, returning the result as a transferable
// ImageBitmap. The signatures/thumbnails are retained between generations so
// re-running at a new density is cheap.

import exifr from "exifr"

import { drawPolygonCell, signatureOf, type Grid } from "./mosaic"
import type { IngestItem, WorkerRequest, WorkerResponse } from "./mosaic-protocol"

// Minimal view of the worker global so we don't need the conflicting
// "webworker" TS lib alongside "dom".
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void
}

const CANVAS_WIDTH = 1600
const CANVAS_HEIGHT = 1000
// Longest side of the retained thumbnail (used by the dock and the zoom overlay).
const THUMB_MAX = 512
// Longest side decoded when painting the small base-canvas cells.
const BASE_TILE_MAX = 128
// How many photos to decode in parallel during ingest.
const INGEST_CONCURRENCY = 8
// Minimum gap between in-progress mosaic snapshots emitted during generate.
const PROGRESS_FRAME_MS = 150

type Entry = { sig: Float32Array; thumb: Blob; w: number; h: number }

// Everything we keep per photo: ~3KB signature + a small thumbnail blob.
const store = new Map<string, Entry>()

const queue: IngestItem[] = []
let ingesting = false
let done = 0
let total = 0

// Id of the generate currently rendering. A newer generate bumps this so the
// older loop notices and abandons its work (rather than wasting cycles).
let activeGenerate = 0

function post(message: WorkerResponse, transfer?: Transferable[]) {
  scope.postMessage(message, transfer ?? [])
}

function formatDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  const yy = String(d.getFullYear() % 100).padStart(2, "0")
  return `${mm}/${dd}/${yy}`
}

async function readCaptureDate(blob: Blob): Promise<string | null> {
  try {
    const exif = await exifr.parse(blob, [
      "DateTimeOriginal",
      "CreateDate",
      "ModifyDate",
    ])
    const raw = exif?.DateTimeOriginal ?? exif?.CreateDate ?? exif?.ModifyDate
    if (!raw) return null
    const date = raw instanceof Date ? raw : new Date(raw)
    return Number.isNaN(date.getTime()) ? null : formatDate(date)
  } catch {
    return null
  }
}

async function ingestOne(item: IngestItem): Promise<void> {
  const { id, blob } = item
  try {
    const bmp = await createImageBitmap(blob)
    const sig = signatureOf(bmp)
    const scale = Math.min(1, THUMB_MAX / Math.max(bmp.width, bmp.height))
    const tw = Math.max(1, Math.round(bmp.width * scale))
    const th = Math.max(1, Math.round(bmp.height * scale))
    const canvas = new OffscreenCanvas(tw, th)
    const ctx = canvas.getContext("2d")
    if (ctx) ctx.drawImage(bmp, 0, 0, tw, th)
    bmp.close()
    const thumb = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 })
    store.set(id, { sig, thumb, w: tw, h: th })
    const dateCaption = await readCaptureDate(blob)
    // `sig` is cloned (not transferred) so the worker keeps its copy in `store`.
    post({ type: "ingested", id, thumb, dateCaption, sig, w: tw, h: th })
  } catch {
    // Undecodable (e.g. an unsupported format) — report it so the UI can stop
    // showing a spinner; the tile simply won't participate in the mosaic.
    post({ type: "ingested", id, thumb: null, dateCaption: null, sig: null, w: 0, h: 0 })
  } finally {
    done++
    post({ type: "progress", done, total })
  }
}

async function runIngest(): Promise<void> {
  if (ingesting) return
  ingesting = true
  while (queue.length) {
    const batch = queue.splice(0, INGEST_CONCURRENCY)
    await Promise.all(batch.map(ingestOne))
  }
  ingesting = false
}

// Decode a tile's thumbnail at cell resolution, memoized for this generate.
async function decodeTile(
  index: number,
  ids: string[],
  cache: Map<number, ImageBitmap>
): Promise<ImageBitmap | undefined> {
  const hit = cache.get(index)
  if (hit) return hit
  const entry = store.get(ids[index])
  if (!entry) return undefined
  const scale = Math.min(1, BASE_TILE_MAX / Math.max(entry.w, entry.h))
  const rw = Math.max(1, Math.round(entry.w * scale))
  const rh = Math.max(1, Math.round(entry.h * scale))
  try {
    const bmp = await createImageBitmap(entry.thumb, {
      resizeWidth: rw,
      resizeHeight: rh,
      resizeQuality: "medium",
    })
    cache.set(index, bmp)
    return bmp
  } catch {
    return undefined
  }
}

async function handleGenerate(
  reqId: number,
  cellSigs: Float32Array[],
  grid: Grid,
  ids: string[],
  angles: Float32Array,
  polys: Float32Array,
  offsets: Int32Array
): Promise<void> {
  activeGenerate = reqId

  // Tile signatures in the same order as `ids` so assignment indices map back to
  // the caller's photo list. A zero signature stands in for any missing entry
  // (shouldn't happen — the caller only sends ingested ids).
  const sigLen = cellSigs[0]?.length ?? 0
  const empty = new Float32Array(sigLen)
  const tileSigs: Float32Array[] = new Array(ids.length)
  for (let i = 0; i < ids.length; i++) {
    tileSigs[i] = store.get(ids[i])?.sig ?? empty
  }

  const canvas = new OffscreenCanvas(CANVAS_WIDTH, CANVAS_HEIGHT)
  const ctx = canvas.getContext("2d")
  if (!ctx) return
  // Transparent background — the main thread paints the reference's average color
  // (the grout) behind the tiles so the gaps and tile shadows sit on-palette.

  // One tile per signature — the count is driven by `cellSigs`, not the grid, so
  // the same path serves both the grid layout (voronoi, where it equals
  // cols×rows) and the free-form contour-flow layout (an arbitrary tile count).
  const cellCount = cellSigs.length
  const assignment = new Int32Array(cellCount)
  const decoded = new Map<number, ImageBitmap>()
  const cleanup = () => {
    for (const bmp of decoded.values()) bmp.close()
  }

  // Match + paint cell-by-cell (row-major) so the mosaic visibly fills in, and
  // ship periodic snapshots back to the main thread.
  let lastFrame = performance.now()
  for (let cell = 0; cell < cellCount; cell++) {
    if (activeGenerate !== reqId) {
      cleanup()
      return
    }

    // Nearest tile by summed squared error, with an exact early exit: once a
    // tile's partial sum can't beat the current best it's abandoned. The /N
    // average is monotonic, so comparing raw sums yields the same argmin.
    const cellSig = cellSigs[cell]
    const len = cellSig.length
    let best = 0
    let bestErr = Infinity
    for (let t = 0; t < tileSigs.length; t++) {
      const ts = tileSigs[t]
      let sum = 0
      for (let i = 0; i < len; i++) {
        const d = cellSig[i] - ts[i]
        sum += d * d
        if (sum >= bestErr) break
      }
      if (sum < bestErr) {
        bestErr = sum
        best = t
      }
    }
    assignment[cell] = best

    const bmp = await decodeTile(best, ids, decoded)
    if (bmp) {
      drawPolygonCell(ctx, polys, offsets, cell, bmp, angles[cell])
    }

    const now = performance.now()
    if (now - lastFrame >= PROGRESS_FRAME_MS && cell + 1 < cellCount) {
      lastFrame = now
      // createImageBitmap copies the canvas; it keeps drawing for later cells.
      const snapshot = await createImageBitmap(canvas)
      if (activeGenerate !== reqId) {
        snapshot.close()
        cleanup()
        return
      }
      post(
        { type: "progressFrame", reqId, base: snapshot, done: cell + 1, total: cellCount },
        [snapshot]
      )
    }
  }

  const base = canvas.transferToImageBitmap()
  cleanup()
  if (activeGenerate !== reqId) {
    base.close()
    return
  }
  post({ type: "generated", reqId, assignment, base }, [base, assignment.buffer])
}

scope.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  switch (msg.type) {
    case "ingest":
      total += msg.items.length
      queue.push(...msg.items)
      post({ type: "progress", done, total })
      void runIngest()
      break
    case "generate":
      void handleGenerate(
        msg.reqId,
        msg.cellSigs,
        msg.grid,
        msg.ids,
        msg.angles,
        msg.polys,
        msg.offsets
      )
      break
    case "hydrate":
      // Restore cached photos into the store so they're usable immediately.
      for (const it of msg.items) {
        store.set(it.id, { sig: it.sig, thumb: it.thumb, w: it.w, h: it.h })
      }
      break
    case "drop":
      for (const id of msg.ids) store.delete(id)
      break
    case "clear":
      store.clear()
      queue.length = 0
      done = 0
      total = 0
      break
  }
}
