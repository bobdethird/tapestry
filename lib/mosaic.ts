// Photo-mosaic helpers: build an averaged-color signature for each of the
// reference's grid cells and for each tile photo, then pick the min-MSE tile per
// cell. These run on BOTH the main thread and inside the mosaic Web Worker, so
// they avoid `document` (preferring OffscreenCanvas) and accept either an
// HTMLImageElement (main thread) or an ImageBitmap (worker) as an image source.

export type Grid = { cols: number; rows: number }

// A rectangle in mosaic-content coordinates (the 0..width × 0..height frame).
export type Region = { x: number; y: number; w: number; h: number }

// A 2D context from either a DOM <canvas> or an OffscreenCanvas (worker-safe).
export type AnyCanvasContext =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D

// Anything we can draw into a cell/signature: an ImageBitmap (decoded in the
// worker) or an HTMLImageElement (decoded on the main thread).
export type TileSource = HTMLImageElement | ImageBitmap

// Side length of the square color signature sampled per tile/cell. Larger is
// finer/more granular — closer to a pixel-for-pixel comparison (an NxN grid of
// average colors, MSE taken over N*N*3 values) at a higher matching cost.
export const SIGNATURE_GRID = 16

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("Could not load image"))
    img.src = url
  })
}

// HTMLImageElement exposes naturalWidth/Height; ImageBitmap only width/height.
function sourceSize(img: TileSource): { w: number; h: number } {
  if ("naturalWidth" in img) {
    return { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height }
  }
  return { w: img.width, h: img.height }
}

// Draw `img` to fill the destination rect, cropping the overflow (object-cover)
// so cells/signatures never letterbox or distort. Exported so the worker can
// paint individual cells while a mosaic generates progressively.
export function drawCover(
  ctx: AnyCanvasContext,
  img: TileSource,
  dx: number,
  dy: number,
  dw: number,
  dh: number
) {
  const { w: iw, h: ih } = sourceSize(img)
  if (!iw || !ih) return
  const imgRatio = iw / ih
  const dstRatio = dw / dh
  let sx = 0
  let sy = 0
  let sw = iw
  let sh = ih
  if (imgRatio > dstRatio) {
    // Source is wider than the cell — crop the sides.
    sw = ih * dstRatio
    sx = (iw - sw) / 2
  } else {
    // Source is taller — crop top and bottom.
    sh = iw / dstRatio
    sy = (ih - sh) / 2
  }
  // drawImage is identically shaped on both context types; the cast just sidesteps
  // a spurious "union of overloads" complaint from TypeScript.
  ;(ctx as CanvasRenderingContext2D).drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
}

// Create a 2D context backed by an OffscreenCanvas when available (works both in
// workers and on the main thread), falling back to a DOM canvas otherwise.
function createContext2d(width: number, height: number): AnyCanvasContext {
  if (typeof OffscreenCanvas !== "undefined") {
    const ctx = new OffscreenCanvas(width, height).getContext("2d", {
      willReadFrequently: true,
    })
    if (ctx) return ctx
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (ctx) return ctx
  }
  throw new Error("2D canvas context unavailable")
}

// S*S*3 averaged-color signature. Drawing a large image into an SxS canvas lets
// the browser area-average each block, so the read-back pixels are the averages.
export function signatureOf(
  img: TileSource,
  s = SIGNATURE_GRID
): Float32Array {
  const ctx = createContext2d(s, s)
  drawCover(ctx, img, 0, 0, s, s)
  const { data } = ctx.getImageData(0, 0, s, s)
  const sig = new Float32Array(s * s * 3)
  for (let i = 0; i < s * s; i++) {
    sig[i * 3] = data[i * 4]
    sig[i * 3 + 1] = data[i * 4 + 1]
    sig[i * 3 + 2] = data[i * 4 + 2]
  }
  return sig
}

// One signature per grid cell from a single reference draw at (cols*s)x(rows*s).
export function referenceCellSignatures(
  ref: TileSource,
  grid: Grid,
  s = SIGNATURE_GRID
): Float32Array[] {
  const w = grid.cols * s
  const h = grid.rows * s
  const ctx = createContext2d(w, h)
  drawCover(ctx, ref, 0, 0, w, h)
  const { data } = ctx.getImageData(0, 0, w, h)
  const cells: Float32Array[] = []
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const sig = new Float32Array(s * s * 3)
      for (let yy = 0; yy < s; yy++) {
        for (let xx = 0; xx < s; xx++) {
          const px = ((row * s + yy) * w + (col * s + xx)) * 4
          const k = (yy * s + xx) * 3
          sig[k] = data[px]
          sig[k + 1] = data[px + 1]
          sig[k + 2] = data[px + 2]
        }
      }
      cells.push(sig)
    }
  }
  return cells
}

export function mse(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    sum += d * d
  }
  return sum / a.length
}

// For each cell, the index of the tile with the lowest MSE. Tiles are reused
// freely (a tile may fill many cells), which is required when cells outnumber
// the uploaded photos.
export function assignTiles(
  cellSigs: Float32Array[],
  tileSigs: Float32Array[]
): number[] {
  return cellSigs.map((cell) => {
    let best = 0
    let bestErr = Infinity
    for (let t = 0; t < tileSigs.length; t++) {
      const err = mse(cell, tileSigs[t])
      if (err < bestErr) {
        bestErr = err
        best = t
      }
    }
    return best
  })
}

export function gridForCellSize(
  cellPx: number,
  width: number,
  height: number
): Grid {
  return {
    cols: Math.max(1, Math.round(width / cellPx)),
    rows: Math.max(1, Math.round(height / cellPx)),
  }
}

// Paint every assigned tile, cover-cropped to fill its cell. Cell edges are
// rounded to whole pixels so the grid tiles seamlessly with no hairlines.
export function drawMosaic(
  ctx: AnyCanvasContext,
  grid: Grid,
  assignment: ArrayLike<number>,
  tiles: ReadonlyArray<TileSource | null | undefined>,
  width: number,
  height: number
) {
  drawMosaicRegion(ctx, grid, assignment, tiles, width, height, {
    x: 0,
    y: 0,
    w: width,
    h: height,
  })
}

// Like `drawMosaic`, but only paints the cells overlapping `region`. The caller
// is expected to have applied the pan/zoom transform to `ctx` already, so tiles
// are drawn from their source at the displayed size. Restricting to the visible
// region keeps the work (and memory) bounded no matter the zoom level.
export function drawMosaicRegion(
  ctx: AnyCanvasContext,
  grid: Grid,
  assignment: ArrayLike<number>,
  tiles: ReadonlyArray<TileSource | null | undefined>,
  width: number,
  height: number,
  region: Region
) {
  const cw = width / grid.cols
  const ch = height / grid.rows
  const colStart = Math.max(0, Math.floor(region.x / cw))
  const colEnd = Math.min(grid.cols - 1, Math.floor((region.x + region.w) / cw))
  const rowStart = Math.max(0, Math.floor(region.y / ch))
  const rowEnd = Math.min(grid.rows - 1, Math.floor((region.y + region.h) / ch))
  if (colEnd < colStart || rowEnd < rowStart) return
  for (let row = rowStart; row <= rowEnd; row++) {
    for (let col = colStart; col <= colEnd; col++) {
      const tile = tiles[assignment[row * grid.cols + col]]
      if (!tile) continue
      const x = Math.round(col * cw)
      const y = Math.round(row * ch)
      const w = Math.round((col + 1) * cw) - x
      const h = Math.round((row + 1) * ch) - y
      drawCover(ctx, tile, x, y, w, h)
    }
  }
}
