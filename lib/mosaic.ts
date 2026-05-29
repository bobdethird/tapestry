// Photo-mosaic helpers: build an averaged-color signature for each of the
// reference's grid cells and for each tile photo, then pick the min-MSE tile per
// cell. Client-only — these touch `document`/`Image` and must run in a browser.

export type Grid = { cols: number; rows: number }

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

// Draw `img` to fill the destination rect, cropping the overflow (object-cover)
// so cells/signatures never letterbox or distort.
function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number
) {
  const iw = img.naturalWidth || img.width
  const ih = img.naturalHeight || img.height
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
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
}

function context2d(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) throw new Error("2D canvas context unavailable")
  return ctx
}

// S*S*3 averaged-color signature. Drawing a large image into an SxS canvas lets
// the browser area-average each block, so the read-back pixels are the averages.
export function signatureOf(
  img: HTMLImageElement,
  s = SIGNATURE_GRID
): Float32Array {
  const ctx = context2d(s, s)
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
  ref: HTMLImageElement,
  grid: Grid,
  s = SIGNATURE_GRID
): Float32Array[] {
  const w = grid.cols * s
  const h = grid.rows * s
  const ctx = context2d(w, h)
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

// Paint the assigned tile into every cell, cover-cropped to fill it. Cell edges
// are rounded to whole pixels so the grid tiles seamlessly with no hairlines.
export function drawMosaic(
  ctx: CanvasRenderingContext2D,
  grid: Grid,
  assignment: number[],
  tiles: HTMLImageElement[],
  width: number,
  height: number
) {
  const cw = width / grid.cols
  const ch = height / grid.rows
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
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
