// Main-thread handle to the mosaic Web Worker. Wraps postMessage in a small
// promise/callback API so components don't deal with raw messages.

import type { Grid } from "./mosaic"
import type {
  HydrateItem,
  WorkerRequest,
  WorkerResponse,
} from "./mosaic-protocol"

export type IngestedTile = {
  id: string
  thumb: Blob | null
  dateCaption: string | null
  // Echoed back so the caller can persist the photo: its color signature and
  // thumbnail dimensions (null sig when the image couldn't be decoded).
  sig: Float32Array | null
  w: number
  h: number
}

export type GenerateResult = { assignment: Int32Array; base: ImageBitmap }

// Called with each in-progress snapshot as the mosaic fills in. The caller owns
// closing the bitmap after drawing it.
export type GenerateFrameCallback = (
  frame: ImageBitmap,
  done: number,
  total: number
) => void

type Pending = {
  resolve: (result: GenerateResult) => void
  onFrame?: GenerateFrameCallback
}

export class MosaicEngine {
  private worker: Worker
  private reqId = 0
  private pending = new Map<number, Pending>()

  // Called once per photo as its thumbnail/signature become available.
  onIngested: ((tile: IngestedTile) => void) | null = null
  // Cumulative ingest progress (done/total across all queued photos).
  onProgress: ((done: number, total: number) => void) | null = null

  constructor() {
    this.worker = new Worker(new URL("./mosaic-worker.ts", import.meta.url), {
      type: "module",
    })
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      if (msg.type === "ingested") {
        this.onIngested?.({
          id: msg.id,
          thumb: msg.thumb,
          dateCaption: msg.dateCaption,
          sig: msg.sig,
          w: msg.w,
          h: msg.h,
        })
      } else if (msg.type === "progress") {
        this.onProgress?.(msg.done, msg.total)
      } else if (msg.type === "progressFrame") {
        this.pending.get(msg.reqId)?.onFrame?.(msg.base, msg.done, msg.total)
      } else if (msg.type === "generated") {
        const entry = this.pending.get(msg.reqId)
        if (entry) {
          this.pending.delete(msg.reqId)
          entry.resolve({ assignment: msg.assignment, base: msg.base })
        }
      }
    }
  }

  private send(message: WorkerRequest) {
    this.worker.postMessage(message)
  }

  ingest(items: { id: string; blob: Blob }[]) {
    if (items.length) this.send({ type: "ingest", items })
  }

  // Replay cached photos into the worker's store so a restored library can be
  // matched/rendered without re-decoding the originals.
  hydrate(items: HydrateItem[]) {
    if (items.length) this.send({ type: "hydrate", items })
  }

  generate(
    cellSigs: Float32Array[],
    grid: Grid,
    ids: string[],
    angles: Float32Array,
    polys: Float32Array,
    offsets: Int32Array,
    onFrame?: GenerateFrameCallback
  ): Promise<GenerateResult> {
    const reqId = ++this.reqId
    return new Promise((resolve) => {
      this.pending.set(reqId, { resolve, onFrame })
      // angles/polys/offsets are sent (cloned, not transferred) so the caller
      // keeps its copies for the crisp zoom overlay.
      this.send({ type: "generate", reqId, cellSigs, grid, ids, angles, polys, offsets })
    })
  }

  drop(ids: string[]) {
    if (ids.length) this.send({ type: "drop", ids })
  }

  clear() {
    this.send({ type: "clear" })
  }

  terminate() {
    this.worker.terminate()
  }
}
