// Message contract between the main thread (lib/mosaic-client.ts) and the mosaic
// Web Worker (lib/mosaic-worker.ts). Kept type-only so it can be imported from
// both sides without creating a runtime dependency cycle.

import type { Grid } from "./mosaic"

export type IngestItem = { id: string; blob: Blob }

// A photo restored from the cache, replayed into the worker's in-memory store so
// it can participate in matching/rendering without being re-decoded.
export type HydrateItem = {
  id: string
  sig: Float32Array
  thumb: Blob
  w: number
  h: number
}

export type WorkerRequest =
  | { type: "ingest"; items: IngestItem[] }
  | { type: "hydrate"; items: HydrateItem[] }
  | {
      type: "generate"
      reqId: number
      cellSigs: Float32Array[]
      grid: Grid
      ids: string[]
      // Per-cell edge orientation (radians) so the worker can rotate each tile's
      // photo along the reference's contours.
      angles: Float32Array
      // Voronoi cell polygons (computed on the main thread): all vertices in
      // `polys` as x,y pairs, with cell `i` spanning `offsets[i]..offsets[i+1]`.
      polys: Float32Array
      offsets: Int32Array
    }
  | { type: "drop"; ids: string[] }
  | { type: "clear" }

export type WorkerResponse =
  // One per photo as ingest completes. `thumb`/`sig` are null if the image could
  // not be decoded (e.g. an unsupported format), in which case the tile is
  // unusable. `sig`/`w`/`h` are echoed back so the main thread can cache them.
  | {
      type: "ingested"
      id: string
      thumb: Blob | null
      dateCaption: string | null
      sig: Float32Array | null
      w: number
      h: number
    }
  | { type: "progress"; done: number; total: number }
  // An in-progress snapshot of the mosaic as it fills in (cells matched so far),
  // emitted periodically during generate so the UI can show live progress.
  | {
      type: "progressFrame"
      reqId: number
      base: ImageBitmap
      done: number
      total: number
    }
  | {
      type: "generated"
      reqId: number
      assignment: Int32Array
      base: ImageBitmap
    }
