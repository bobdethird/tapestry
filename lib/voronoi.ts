// Dependency-free Voronoi tessellation for the mosaic. Each grid cell gets a
// jittered seed point; its tile shape is that seed's Voronoi cell — the region
// of the frame closer to it than to any neighbour. Each cell is computed by
// clipping a box around the seed against the perpendicular bisectors of nearby
// seeds (Sutherland–Hodgman half-plane clipping). Jittered seeds yield a natural
// mix of triangles, quads, pentagons and hexagons that tessellate with no gaps.

import type { EdgeField, Grid } from "./mosaic"

const SEED = 0x9e3779b9
// How far each seed wanders from its cell center (fraction of the cell). More
// jitter => more irregular cells and a wider spread of polygon shapes.
const SEED_JITTER = 0.5
// Neighbour radius (in cells) whose bisectors can bound a cell. Generous because
// edge-relaxation can pull seeds up to ~1.3 cells from their grid home.
const NEIGHBOR_RADIUS = 4

// Edge-relaxation: slide seeds out of contours so cell borders fall on them.
const RELAX_ITERS = 16
const RELAX_EDGE_STEP = 0.4 // × cell, max slide per step away from an edge
const RELAX_SPRING = 0.1 // pull back toward the seed's home (keeps cells spread)
const RELAX_MAX_DISP = 0.85 // × cell, cap on displacement from home

type Pt = [number, number]

// Bilinear sample of the edge field at field-pixel coords.
function sampleMag(f: EdgeField, x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const cx0 = x0 < 0 ? 0 : x0 >= f.fw ? f.fw - 1 : x0
  const cy0 = y0 < 0 ? 0 : y0 >= f.fh ? f.fh - 1 : y0
  const cx1 = cx0 + 1 >= f.fw ? f.fw - 1 : cx0 + 1
  const cy1 = cy0 + 1 >= f.fh ? f.fh - 1 : cy0 + 1
  const tx = x - x0
  const ty = y - y0
  const a = f.mag[cy0 * f.fw + cx0]
  const b = f.mag[cy0 * f.fw + cx1]
  const c = f.mag[cy1 * f.fw + cx0]
  const d = f.mag[cy1 * f.fw + cx1]
  const top = a + (b - a) * tx
  const bot = c + (d - c) * tx
  return top + (bot - top) * ty
}

// Gradient of the edge field (central differences) at field-pixel coords.
function gradMag(f: EdgeField, x: number, y: number): [number, number] {
  return [
    sampleMag(f, x + 1, y) - sampleMag(f, x - 1, y),
    sampleMag(f, x, y + 1) - sampleMag(f, x, y - 1),
  ]
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Seed point for cell (col,row): its jittered center, clamped to the frame.
function seedAt(
  col: number,
  row: number,
  cw: number,
  ch: number,
  width: number,
  height: number
): Pt {
  const rng = mulberry32(
    (SEED ^ Math.imul(col, 73856093) ^ Math.imul(row, 19349663)) >>> 0
  )
  const x = (col + 0.5) * cw + (rng() * 2 - 1) * SEED_JITTER * cw
  const y = (row + 0.5) * ch + (rng() * 2 - 1) * SEED_JITTER * ch
  return [Math.min(width, Math.max(0, x)), Math.min(height, Math.max(0, y))]
}

// Keep the part of `poly` inside the half-plane a*x + b*y <= c.
function clipHalfPlane(poly: Pt[], a: number, b: number, c: number): Pt[] {
  const out: Pt[] = []
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const A = poly[i]
    const B = poly[(i + 1) % n]
    const da = a * A[0] + b * A[1] - c
    const db = a * B[0] + b * B[1] - c
    const ain = da <= 0
    const bin = db <= 0
    if (ain) out.push(A)
    if (ain !== bin) {
      const t = da / (da - db)
      out.push([A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1])])
    }
  }
  return out
}

// Voronoi cell polygons for every grid cell, packed into transferable arrays:
// `polys` holds all [x,y] vertices, and cell `i` owns the vertex range
// `offsets[i]..offsets[i+1]`. Cell `i` corresponds to grid cell `i` (row-major),
// so it lines up with the per-cell signatures and edge angles.
export function voronoiPolygons(
  grid: Grid,
  width: number,
  height: number,
  edge?: EdgeField
): { polys: Float32Array; offsets: Int32Array } {
  const { cols, rows } = grid
  const n = cols * rows
  const cw = width / cols
  const ch = height / rows
  const seeds: Pt[] = new Array(n)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      seeds[row * cols + col] = seedAt(col, row, cw, ch, width, height)
    }
  }
  // Edge relaxation: repeatedly slide each seed downhill on the edge field
  // (away from contours), scaled by how strong the local edge is, with a spring
  // back to its home so cells stay spread. When two seeds straddle a contour
  // their shared Voronoi border settles right on it.
  if (edge) {
    const homes = seeds.map((s) => [s[0], s[1]] as Pt)
    const fxs = edge.fw / width
    const fys = edge.fh / height
    const cap = RELAX_MAX_DISP * Math.min(cw, ch)
    for (let it = 0; it < RELAX_ITERS; it++) {
      for (let i = 0; i < n; i++) {
        const s = seeds[i]
        const e = sampleMag(edge, s[0] * fxs, s[1] * fys)
        const [gx, gy] = gradMag(edge, s[0] * fxs, s[1] * fys)
        const gl = Math.hypot(gx, gy)
        let nx = s[0]
        let ny = s[1]
        if (gl > 1e-6) {
          nx -= RELAX_EDGE_STEP * cw * (gx / gl) * e
          ny -= RELAX_EDGE_STEP * ch * (gy / gl) * e
        }
        const h = homes[i]
        nx += RELAX_SPRING * (h[0] - nx)
        ny += RELAX_SPRING * (h[1] - ny)
        const dx = nx - h[0]
        const dy = ny - h[1]
        const dd = Math.hypot(dx, dy)
        if (dd > cap) {
          nx = h[0] + (dx / dd) * cap
          ny = h[1] + (dy / dd) * cap
        }
        s[0] = Math.min(width, Math.max(0, nx))
        s[1] = Math.min(height, Math.max(0, ny))
      }
    }
  }
  // Box half-size around each seed to start from — larger than any cell can be,
  // so it never wrongly clips the true Voronoi cell.
  const margin = Math.max(cw, ch) * (NEIGHBOR_RADIUS + 1)
  const cells: Pt[][] = new Array(n)
  let total = 0
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col
      const [sx, sy] = seeds[i]
      const x0 = Math.max(0, sx - margin)
      const y0 = Math.max(0, sy - margin)
      const x1 = Math.min(width, sx + margin)
      const y1 = Math.min(height, sy + margin)
      let poly: Pt[] = [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ]
      const si2 = sx * sx + sy * sy
      for (let dr = -NEIGHBOR_RADIUS; dr <= NEIGHBOR_RADIUS && poly.length; dr++) {
        const nr = row + dr
        if (nr < 0 || nr >= rows) continue
        for (let dc = -NEIGHBOR_RADIUS; dc <= NEIGHBOR_RADIUS; dc++) {
          if (dr === 0 && dc === 0) continue
          const nc = col + dc
          if (nc < 0 || nc >= cols) continue
          const [qx, qy] = seeds[nr * cols + nc]
          // Bisector: keep points closer to the seed than to this neighbour.
          poly = clipHalfPlane(poly, 2 * (qx - sx), 2 * (qy - sy), qx * qx + qy * qy - si2)
          if (!poly.length) break
        }
      }
      cells[i] = poly
      total += poly.length
    }
  }
  const polys = new Float32Array(total * 2)
  const offsets = new Int32Array(n + 1)
  let v = 0
  for (let i = 0; i < n; i++) {
    offsets[i] = v
    const poly = cells[i]
    for (let j = 0; j < poly.length; j++) {
      polys[v * 2] = poly[j][0]
      polys[v * 2 + 1] = poly[j][1]
      v++
    }
  }
  offsets[n] = v
  return { polys, offsets }
}
