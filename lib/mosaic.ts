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

// Minimum Sobel gradient magnitude (on the coarse cols×rows luminance grid)
// before a cell counts as "on an edge". Below it the local direction is mostly
// noise, so the tile is left axis-aligned (angle 0).
const EDGE_MIN = 16

// Per-cell stroke orientation in radians, derived from the reference's edges. A
// Sobel gradient is taken over a cols×rows luminance grid and each tile is
// aligned ALONG the local contour (perpendicular to the gradient). Flat areas
// resolve to 0 so only real edges steer the tiles.
export function referenceCellOrientations(
  ref: TileSource,
  grid: Grid
): Float32Array {
  const { cols, rows } = grid
  const ctx = createContext2d(cols, rows)
  drawCover(ctx, ref, 0, 0, cols, rows)
  const { data } = ctx.getImageData(0, 0, cols, rows)
  const lum = new Float32Array(cols * rows)
  for (let i = 0; i < cols * rows; i++) {
    lum[i] =
      0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
  }
  const at = (x: number, y: number) => {
    const cx = x < 0 ? 0 : x >= cols ? cols - 1 : x
    const cy = y < 0 ? 0 : y >= rows ? rows - 1 : y
    return lum[cy * cols + cx]
  }
  const angles = new Float32Array(cols * rows)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const gx =
        at(x + 1, y - 1) +
        2 * at(x + 1, y) +
        at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))
      const gy =
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))
      const mag = Math.hypot(gx, gy)
      angles[y * cols + x] =
        mag > EDGE_MIN ? Math.atan2(gy, gx) + Math.PI / 2 : 0
    }
  }
  return angles
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

// Fast, deterministic PRNG (mulberry32) so the warped mesh is stable across
// re-renders rather than jittering on every generate.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Seed + how far interior mesh vertices wander (fraction of a cell). Kept well
// below 0.5 so neighbouring vertices never cross and the quads stay simple.
const MESH_SEED = 0x9e3779b9
const MESH_JITTER = 0.34

// Vertices of a (cols+1)×(rows+1) mesh over the width×height frame with interior
// points jittered; border points stay on the frame edge. Adjacent cells share
// corners, so the resulting quads tile the frame with no gaps. A vertex (vx,vy)
// lives at index (vy*(cols+1)+vx)*2. Deterministic, so the worker (base render)
// and the main thread (zoom overlay) compute identical meshes.
export function warpedGridVertices(
  grid: Grid,
  width: number,
  height: number
): Float32Array {
  const { cols, rows } = grid
  const vcols = cols + 1
  const vrows = rows + 1
  const cw = width / cols
  const ch = height / rows
  const pts = new Float32Array(vcols * vrows * 2)
  for (let vy = 0; vy < vrows; vy++) {
    for (let vx = 0; vx < vcols; vx++) {
      const rng = mulberry32(
        (MESH_SEED ^ Math.imul(vx, 73856093) ^ Math.imul(vy, 19349663)) >>> 0
      )
      const jx = (rng() * 2 - 1) * MESH_JITTER * cw
      const jy = (rng() * 2 - 1) * MESH_JITTER * ch
      const i = (vy * vcols + vx) * 2
      pts[i] = vx * cw + (vx > 0 && vx < cols ? jx : 0)
      pts[i + 1] = vy * ch + (vy > 0 && vy < rows ? jy : 0)
    }
  }
  return pts
}

// Fill one cell's warped quad with its photo: clip to the quad, then cover-fill
// with the image rotated to the cell's edge angle. The cover square is sized to
// the quad's diagonal so it still covers the quad after rotation — no white.
export function drawWarpedCell(
  ctx: AnyCanvasContext,
  col: number,
  row: number,
  cols: number,
  verts: ArrayLike<number>,
  img: TileSource,
  angle: number
) {
  const vcols = cols + 1
  const tl = (row * vcols + col) * 2
  const tr = (row * vcols + col + 1) * 2
  const br = ((row + 1) * vcols + col + 1) * 2
  const bl = ((row + 1) * vcols + col) * 2
  const x0 = verts[tl]
  const y0 = verts[tl + 1]
  const x1 = verts[tr]
  const y1 = verts[tr + 1]
  const x2 = verts[br]
  const y2 = verts[br + 1]
  const x3 = verts[bl]
  const y3 = verts[bl + 1]
  const minX = Math.min(x0, x1, x2, x3)
  const maxX = Math.max(x0, x1, x2, x3)
  const minY = Math.min(y0, y1, y2, y3)
  const maxY = Math.max(y0, y1, y2, y3)
  const side = Math.hypot(maxX - minX, maxY - minY)
  const c = ctx as CanvasRenderingContext2D
  c.save()
  c.beginPath()
  c.moveTo(x0, y0)
  c.lineTo(x1, y1)
  c.lineTo(x2, y2)
  c.lineTo(x3, y3)
  c.closePath()
  c.clip()
  c.translate((minX + maxX) / 2, (minY + maxY) / 2)
  if (angle) c.rotate(angle)
  drawCover(ctx, img, -side / 2, -side / 2, side, side)
  c.restore()
}

// Warped-mesh variant of `drawMosaicRegion`: every cell is an irregular quad (so
// tiles are non-rectangular and tessellate with no white space), filled with its
// matched photo rotated to the cell's edge orientation. The visited range is
// widened by one cell so jitter-spilled quads aren't clipped at the region edge.
export function drawWarpedMosaicRegion(
  ctx: AnyCanvasContext,
  grid: Grid,
  assignment: ArrayLike<number>,
  angles: ArrayLike<number>,
  tiles: ReadonlyArray<TileSource | null | undefined>,
  width: number,
  height: number,
  region: Region,
  verts: ArrayLike<number>
) {
  const { cols, rows } = grid
  const cw = width / cols
  const ch = height / rows
  const colStart = Math.max(0, Math.floor(region.x / cw) - 1)
  const colEnd = Math.min(cols - 1, Math.floor((region.x + region.w) / cw) + 1)
  const rowStart = Math.max(0, Math.floor(region.y / ch) - 1)
  const rowEnd = Math.min(rows - 1, Math.floor((region.y + region.h) / ch) + 1)
  if (colEnd < colStart || rowEnd < rowStart) return
  for (let row = rowStart; row <= rowEnd; row++) {
    for (let col = colStart; col <= colEnd; col++) {
      const idx = row * cols + col
      const tile = tiles[assignment[idx]]
      if (!tile) continue
      drawWarpedCell(ctx, col, row, cols, verts, tile, angles[idx])
    }
  }
}
