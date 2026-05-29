"use client"

import * as React from "react"
import { Frame, Maximize, Minus, Plus, Sparkles } from "lucide-react"

import {
  PhotoDock,
  makePhotoFromFile,
  type Photo,
} from "@/components/photo-dock"
import {
  ReferenceCard,
  ReferenceEmptyCard,
  makeReferenceFromFile,
  type ReferenceImage,
} from "@/components/reference-image"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { MosaicEngine } from "@/lib/mosaic-client"
import {
  averageColor,
  drawWarpedMosaicRegion,
  gridForCellSize,
  loadImage,
  referenceCellOrientations,
  referenceCellSignatures,
  warpedGridVertices,
  type Grid,
} from "@/lib/mosaic"
import { cn } from "@/lib/utils"

const CANVAS_WIDTH = 1600
const CANVAS_HEIGHT = 1000
const MIN_SCALE = 0.1
const MAX_SCALE = 8

// Mosaic cell size in px (within the 1600x1000 frame). Smaller = finer grid.
const DENSITY_MIN = 16
const DENSITY_MAX = 80

// Once zoomed past this scale we re-render the visible tiles from their
// full-resolution sources so the constituent photos stay sharp instead of
// upscaling the baked-in low-res canvas.
const CRISP_SCALE = 1.5
// Delay before painting the crisp overlay, so it only fires once a zoom/pan
// gesture settles rather than on every intermediate frame.
const CRISP_SETTLE_MS = 120
// Cap on decoded thumbnail bitmaps kept for the crisp overlay (bounded memory).
const CRISP_CACHE_MAX = 300

type Transform = { x: number; y: number; scale: number }

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max)
}

function isTypingTarget(t: EventTarget | null) {
  if (!(t instanceof HTMLElement)) return false
  return (
    t.isContentEditable ||
    t.tagName === "INPUT" ||
    t.tagName === "TEXTAREA" ||
    t.tagName === "SELECT"
  )
}

function useZoomPan() {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const [transform, setTransform] = React.useState<Transform>({
    x: 0,
    y: 0,
    scale: 1,
  })
  const [isPanning, setIsPanning] = React.useState(false)
  const [animating, setAnimating] = React.useState(false)
  const [mounted, setMounted] = React.useState(false)

  const transformRef = React.useRef(transform)
  React.useEffect(() => {
    transformRef.current = transform
  }, [transform])

  const animTimer = React.useRef<number | null>(null)
  const triggerAnim = React.useCallback((ms = 240) => {
    setAnimating(true)
    if (animTimer.current !== null) window.clearTimeout(animTimer.current)
    animTimer.current = window.setTimeout(() => setAnimating(false), ms)
  }, [])

  const computeFit = React.useCallback((padding = 96): Transform => {
    const el = containerRef.current
    if (!el) return { x: 0, y: 0, scale: 1 }
    const cw = el.clientWidth
    const ch = el.clientHeight
    const sx = (cw - padding * 2) / CANVAS_WIDTH
    const sy = (ch - padding * 2) / CANVAS_HEIGHT
    const scale = clamp(Math.min(sx, sy), MIN_SCALE, MAX_SCALE)
    return {
      scale,
      x: (cw - CANVAS_WIDTH * scale) / 2,
      y: (ch - CANVAS_HEIGHT * scale) / 2,
    }
  }, [])

  // Cursor-anchored zoom: keep the point under the focal coordinate fixed
  // by scaling the offset vector from the focal point.
  const zoomAround = React.useCallback(
    (nextScale: number, focalX: number, focalY: number) => {
      setTransform((t) => {
        const clamped = clamp(nextScale, MIN_SCALE, MAX_SCALE)
        const factor = clamped / t.scale
        return {
          scale: clamped,
          x: focalX - (focalX - t.x) * factor,
          y: focalY - (focalY - t.y) * factor,
        }
      })
    },
    []
  )

  const zoomFromCenter = React.useCallback(
    (nextScale: number) => {
      const el = containerRef.current
      if (!el) return
      zoomAround(nextScale, el.clientWidth / 2, el.clientHeight / 2)
      triggerAnim()
    },
    [zoomAround, triggerAnim]
  )

  const zoomIn = React.useCallback(() => {
    zoomFromCenter(transformRef.current.scale * 1.25)
  }, [zoomFromCenter])

  const zoomOut = React.useCallback(() => {
    zoomFromCenter(transformRef.current.scale / 1.25)
  }, [zoomFromCenter])

  const fitToView = React.useCallback(() => {
    setTransform(computeFit())
    triggerAnim()
  }, [computeFit, triggerAnim])

  const reset100 = React.useCallback(() => {
    const el = containerRef.current
    if (!el) return
    setTransform({
      scale: 1,
      x: (el.clientWidth - CANVAS_WIDTH) / 2,
      y: (el.clientHeight - CANVAS_HEIGHT) / 2,
    })
    triggerAnim()
  }, [triggerAnim])

  // Callback ref: measure once on attach and seed the initial transform.
  // Doing this in a ref callback (rather than an effect) avoids the
  // cascading-render pattern flagged by react-hooks/set-state-in-effect.
  const setContainer = React.useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node
    if (!node) return
    const padding = 96
    const cw = node.clientWidth
    const ch = node.clientHeight
    const sx = (cw - padding * 2) / CANVAS_WIDTH
    const sy = (ch - padding * 2) / CANVAS_HEIGHT
    const scale = clamp(Math.min(sx, sy), MIN_SCALE, MAX_SCALE)
    setTransform({
      scale,
      x: (cw - CANVAS_WIDTH * scale) / 2,
      y: (ch - CANVAS_HEIGHT * scale) / 2,
    })
    setMounted(true)
  }, [])

  // Wheel: ctrl/meta (or trackpad pinch) zooms toward cursor; plain wheel pans.
  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const fx = e.clientX - rect.left
      const fy = e.clientY - rect.top
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.01)
        zoomAround(transformRef.current.scale * factor, fx, fy)
      } else {
        setTransform((t) => ({
          ...t,
          x: t.x - e.deltaX,
          y: t.y - e.deltaY,
        }))
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [zoomAround])

  const onPointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 && e.button !== 1) return
      const target = e.target as HTMLElement
      if (target.closest("[data-no-pan]")) return

      const el = e.currentTarget
      el.setPointerCapture(e.pointerId)
      const start = {
        x: e.clientX,
        y: e.clientY,
        t: { ...transformRef.current },
      }
      setIsPanning(true)

      const onMove = (ev: PointerEvent) => {
        setTransform({
          ...start.t,
          x: start.t.x + (ev.clientX - start.x),
          y: start.t.y + (ev.clientY - start.y),
        })
      }
      const onUp = (ev: PointerEvent) => {
        setIsPanning(false)
        try {
          el.releasePointerCapture(ev.pointerId)
        } catch {
          // releasing a capture we no longer hold is fine
        }
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        window.removeEventListener("pointercancel", onUp)
      }
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
      window.addEventListener("pointercancel", onUp)
    },
    []
  )

  // Keyboard: +/- to zoom, 0 for 100%, 1 to fit. Skip when typing.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      switch (e.key) {
        case "+":
        case "=":
          e.preventDefault()
          zoomIn()
          break
        case "-":
        case "_":
          e.preventDefault()
          zoomOut()
          break
        case "0":
          e.preventDefault()
          reset100()
          break
        case "1":
          e.preventDefault()
          fitToView()
          break
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [zoomIn, zoomOut, reset100, fitToView])

  return {
    setContainer,
    transform,
    isPanning,
    animating,
    mounted,
    zoomIn,
    zoomOut,
    fitToView,
    reset100,
    onPointerDown,
  }
}

// ─── Artwork ────────────────────────────────────────────────────────────────

const PALETTE = [
  "#1e3a8a", // indigo
  "#b45309", // ochre
  "#9a3412", // terra
  "#3f6212", // sage
  "#475569", // slate
  "#831843", // rose
  "#1c1917", // ink
  "#fef3c7", // cream
] as const

const PATTERNS = [
  "p-weft",
  "p-warp",
  "p-cross",
  "p-dot",
  "p-diamond",
  "p-plus",
  "p-check",
  "p-solid",
] as const

const COLS = 8
const ROWS = 5
const CELL = 200

type Cell = {
  col: number
  row: number
  color: string
  pattern: (typeof PATTERNS)[number]
  light: boolean
}

const CELLS: Cell[] = Array.from({ length: COLS * ROWS }, (_, i) => {
  const col = i % COLS
  const row = Math.floor(i / COLS)
  const colorIdx = (col * 3 + row * 5 + 1) % PALETTE.length
  const patternIdx = (col * 2 + row * 7) % PATTERNS.length
  const color = PALETTE[colorIdx]
  return {
    col,
    row,
    color,
    pattern: PATTERNS[patternIdx],
    light: color === "#fef3c7",
  }
})

const ANNOTATIONS = [
  { col: 1, row: 1, label: "indigo · warp" },
  { col: 5, row: 0, label: "ochre · weft" },
  { col: 2, row: 3, label: "terra · cross" },
  { col: 6, row: 4, label: "sage · plus" },
] as const

function CanvasArtwork() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
      width={CANVAS_WIDTH}
      height={CANVAS_HEIGHT}
      className="block"
      style={{ fontFamily: "var(--font-sans), system-ui, sans-serif" }}
    >
      <defs>
        <radialGradient id="paper" cx="50%" cy="38%" r="80%">
          <stop offset="0" stopColor="#fbf6ec" />
          <stop offset="1" stopColor="#e9dec7" />
        </radialGradient>

        <pattern
          id="p-weft"
          width="20"
          height="20"
          patternUnits="userSpaceOnUse"
        >
          <line
            x1="0"
            y1="4"
            x2="20"
            y2="4"
            stroke="#000"
            strokeOpacity="0.2"
            strokeWidth="1.4"
          />
          <line
            x1="0"
            y1="10"
            x2="20"
            y2="10"
            stroke="#000"
            strokeOpacity="0.2"
            strokeWidth="1.4"
          />
          <line
            x1="0"
            y1="16"
            x2="20"
            y2="16"
            stroke="#000"
            strokeOpacity="0.2"
            strokeWidth="1.4"
          />
        </pattern>

        <pattern
          id="p-warp"
          width="20"
          height="20"
          patternUnits="userSpaceOnUse"
        >
          <line
            x1="4"
            y1="0"
            x2="4"
            y2="20"
            stroke="#000"
            strokeOpacity="0.2"
            strokeWidth="1.4"
          />
          <line
            x1="10"
            y1="0"
            x2="10"
            y2="20"
            stroke="#000"
            strokeOpacity="0.2"
            strokeWidth="1.4"
          />
          <line
            x1="16"
            y1="0"
            x2="16"
            y2="20"
            stroke="#000"
            strokeOpacity="0.2"
            strokeWidth="1.4"
          />
        </pattern>

        <pattern
          id="p-cross"
          width="16"
          height="16"
          patternUnits="userSpaceOnUse"
        >
          <line
            x1="0"
            y1="16"
            x2="16"
            y2="0"
            stroke="#000"
            strokeOpacity="0.22"
            strokeWidth="1"
          />
          <line
            x1="0"
            y1="0"
            x2="16"
            y2="16"
            stroke="#000"
            strokeOpacity="0.22"
            strokeWidth="1"
          />
        </pattern>

        <pattern
          id="p-dot"
          width="16"
          height="16"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="8" cy="8" r="2.2" fill="#000" fillOpacity="0.28" />
        </pattern>

        <pattern
          id="p-diamond"
          width="22"
          height="22"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M11 3 L19 11 L11 19 L3 11 Z"
            fill="none"
            stroke="#000"
            strokeOpacity="0.22"
            strokeWidth="1.2"
          />
        </pattern>

        <pattern
          id="p-plus"
          width="22"
          height="22"
          patternUnits="userSpaceOnUse"
        >
          <line
            x1="11"
            y1="6"
            x2="11"
            y2="16"
            stroke="#000"
            strokeOpacity="0.26"
            strokeWidth="1.4"
          />
          <line
            x1="6"
            y1="11"
            x2="16"
            y2="11"
            stroke="#000"
            strokeOpacity="0.26"
            strokeWidth="1.4"
          />
        </pattern>

        <pattern
          id="p-check"
          width="20"
          height="20"
          patternUnits="userSpaceOnUse"
        >
          <rect width="10" height="10" fill="#000" fillOpacity="0.16" />
          <rect
            x="10"
            y="10"
            width="10"
            height="10"
            fill="#000"
            fillOpacity="0.16"
          />
        </pattern>

        {/* p-solid is intentionally empty; we just skip the overlay */}

        {/* Subtle grain to make the cells feel woven, not painted.
            The last row of the matrix maps the noise's R channel to alpha,
            biased so only the brighter peaks of the noise become visible —
            yielding sparse speckle rather than a flat overlay. */}
        <filter id="grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.85"
            numOctaves="2"
            seed="7"
            stitchTiles="stitch"
          />
          <feColorMatrix
            values="0 0 0 0 0
                    0 0 0 0 0
                    0 0 0 0 0
                    1.4 0 0 0 -0.7"
          />
        </filter>
      </defs>

      <rect width={CANVAS_WIDTH} height={CANVAS_HEIGHT} fill="url(#paper)" />

      {/* Tapestry cells */}
      {CELLS.map((c) => (
        <g
          key={`${c.col}-${c.row}`}
          transform={`translate(${c.col * CELL} ${c.row * CELL})`}
        >
          <rect width={CELL} height={CELL} fill={c.color} />
          {c.pattern !== "p-solid" && (
            <rect width={CELL} height={CELL} fill={`url(#${c.pattern})`} />
          )}
          {/* Tiny cell coord — invisible from afar, readable when zoomed in */}
          <text
            x={8}
            y={18}
            fontSize="9"
            fontFamily="var(--font-mono), ui-monospace, monospace"
            fill={c.light ? "#1c1917" : "#fef3c7"}
            fillOpacity="0.7"
          >
            {String.fromCharCode(65 + c.col)}
            {c.row + 1}
          </text>
        </g>
      ))}

      {/* Thin "guides" between cells — the Photoshop-style cyan lines */}
      <g stroke="#0ea5b7" strokeOpacity="0.18" strokeWidth="0.5">
        {Array.from({ length: COLS - 1 }, (_, i) => (
          <line
            key={`v-${i}`}
            x1={(i + 1) * CELL}
            y1="0"
            x2={(i + 1) * CELL}
            y2={CANVAS_HEIGHT}
          />
        ))}
        {Array.from({ length: ROWS - 1 }, (_, i) => (
          <line
            key={`h-${i}`}
            x1="0"
            y1={(i + 1) * CELL}
            x2={CANVAS_WIDTH}
            y2={(i + 1) * CELL}
          />
        ))}
      </g>

      {/* Wordmark — sits over the cells like a watermark */}
      <text
        x={CANVAS_WIDTH / 2}
        y={CANVAS_HEIGHT / 2 + 56}
        textAnchor="middle"
        fontSize="200"
        fontWeight="900"
        letterSpacing="-6"
        fill="#1c1917"
        fillOpacity="0.85"
        style={{ paintOrder: "stroke fill" }}
        stroke="#fbf6ec"
        strokeWidth="6"
      >
        TAPESTRY
      </text>

      {/* Annotations: small target + leader line + label */}
      <g>
        {ANNOTATIONS.map((a, i) => {
          const cx = a.col * CELL + CELL / 2
          const cy = a.row * CELL + CELL / 2
          const flip = i % 2 === 0 ? -1 : 1
          const lx = cx + flip * 110
          const ly = cy - 80
          return (
            <g key={i}>
              <circle
                cx={cx}
                cy={cy}
                r="12"
                fill="none"
                stroke="#fef3c7"
                strokeOpacity="0.95"
                strokeWidth="1.5"
              />
              <circle cx={cx} cy={cy} r="2" fill="#fef3c7" />
              <line
                x1={cx}
                y1={cy}
                x2={lx}
                y2={ly}
                stroke="#fef3c7"
                strokeOpacity="0.9"
                strokeWidth="1"
              />
              <rect
                x={lx - (flip < 0 ? 110 : 0)}
                y={ly - 16}
                width="110"
                height="20"
                rx="2"
                fill="#1c1917"
                fillOpacity="0.85"
              />
              <text
                x={lx + (flip < 0 ? -55 : 55)}
                y={ly - 2}
                textAnchor="middle"
                fontSize="11"
                fontFamily="var(--font-mono), ui-monospace, monospace"
                fill="#fef3c7"
                letterSpacing="0.5"
              >
                {a.label.toUpperCase()}
              </text>
            </g>
          )
        })}
      </g>

      {/* Registration marks at corners (printer style) */}
      <g stroke="#1c1917" strokeWidth="1" fill="none">
        {[
          [40, 40],
          [CANVAS_WIDTH - 40, 40],
          [40, CANVAS_HEIGHT - 40],
          [CANVAS_WIDTH - 40, CANVAS_HEIGHT - 40],
        ].map(([x, y], i) => (
          <g key={i} transform={`translate(${x} ${y})`}>
            <circle r="10" />
            <line x1="-16" y1="0" x2="16" y2="0" />
            <line x1="0" y1="-16" x2="0" y2="16" />
          </g>
        ))}
      </g>

      {/* Signature tag in the bottom-right */}
      <g transform={`translate(${CANVAS_WIDTH - 320} ${CANVAS_HEIGHT - 90})`}>
        <rect
          width="280"
          height="56"
          fill="#fbf6ec"
          stroke="#1c1917"
          strokeWidth="1"
        />
        <text
          x="16"
          y="22"
          fontSize="10"
          fontFamily="var(--font-mono), ui-monospace, monospace"
          letterSpacing="1.5"
          fill="#1c1917"
        >
          TAPESTRY · NO. 01
        </text>
        <text
          x="16"
          y="40"
          fontSize="9"
          fontFamily="var(--font-mono), ui-monospace, monospace"
          letterSpacing="1"
          fill="#1c1917"
          opacity="0.7"
        >
          1600 × 1000 · indigo, ochre, terra, sage
        </text>
      </g>

      {/* Grain pass to subtly age the whole thing */}
      <rect
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        filter="url(#grain)"
        opacity="0.18"
        pointerEvents="none"
      />
    </svg>
  )
}

// ─── Toolbar ────────────────────────────────────────────────────────────────

interface CanvasToolbarProps {
  scale: number
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
  on100: () => void
}

function CanvasToolbar({
  scale,
  onZoomIn,
  onZoomOut,
  onFit,
  on100,
}: CanvasToolbarProps) {
  return (
    <div
      data-no-pan
      className="absolute top-6 right-6 z-20 flex items-center gap-1 rounded-2xl border border-border/60 bg-popover/85 px-1.5 py-1.5 shadow-xl shadow-black/15 backdrop-blur-md"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onZoomOut}
        aria-label="Zoom out"
      >
        <Minus />
      </Button>

      <div className="flex w-14 items-baseline justify-center font-mono text-xs text-muted-foreground tabular-nums">
        {Math.round(scale * 100)}%
      </div>

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onZoomIn}
        aria-label="Zoom in"
      >
        <Plus />
      </Button>

      <Separator
        orientation="vertical"
        className="mx-1 h-5 data-vertical:self-center"
      />

      <Button
        variant="ghost"
        size="sm"
        onClick={onFit}
        data-icon="inline-start"
      >
        <Frame />
        Fit
      </Button>

      <Button
        variant="ghost"
        size="sm"
        onClick={on100}
        data-icon="inline-start"
      >
        <Maximize />
        100%
      </Button>
    </div>
  )
}

// ─── Hero ───────────────────────────────────────────────────────────────────

export function CanvasHero() {
  const {
    setContainer,
    transform,
    isPanning,
    animating,
    mounted,
    zoomIn,
    zoomOut,
    fitToView,
    reset100,
    onPointerDown,
  } = useZoomPan()

  const [photos, setPhotos] = React.useState<Photo[]>([])
  const [selectedPhotoId, setSelectedPhotoId] = React.useState<string | null>(
    null
  )
  const [isDockExpanded, setIsDockExpanded] = React.useState(false)
  const [reference, setReference] = React.useState<ReferenceImage | null>(null)
  const [density, setDensity] = React.useState(40)
  const [isGenerating, setIsGenerating] = React.useState(false)
  const [hasMosaic, setHasMosaic] = React.useState(false)
  // Cumulative ingest progress reported by the worker (done/total photos).
  const [ingestProgress, setIngestProgress] = React.useState({
    done: 0,
    total: 0,
  })
  // Live generate progress (cells matched / total) while the mosaic fills in.
  const [generateProgress, setGenerateProgress] = React.useState<{
    done: number
    total: number
  } | null>(null)
  const mosaicCanvasRef = React.useRef<HTMLCanvasElement | null>(null)
  // High-resolution overlay, pinned to the viewport. When zoomed in we paint the
  // visible tiles into it at device resolution so the photos read sharply.
  const crispCanvasRef = React.useRef<HTMLCanvasElement | null>(null)
  // What the crisp overlay needs to re-paint the visible mosaic on zoom: the
  // grid, the per-cell tile assignment (indices into thumbUrls), and the tile
  // thumbnail URLs. No full-resolution images are held — that's what lets this
  // scale to thousands of photos.
  const mosaicModelRef = React.useRef<{
    grid: Grid
    assignment: Int32Array
    angles: Float32Array
    verts: Float32Array
    bg: string
    thumbUrls: string[]
  } | null>(null)
  // Bumped whenever the mosaic is (re)generated or cleared, so the crisp-overlay
  // effect re-runs even when the zoom transform itself hasn't changed.
  const [mosaicVersion, setMosaicVersion] = React.useState(0)
  // Bounded LRU (oldest first) of decoded overlay thumbnails, keyed by URL.
  const crispCacheRef = React.useRef<Map<string, HTMLImageElement>>(new Map())
  // Worker handle: decode + signature + tile matching + base-canvas render.
  const engineRef = React.useRef<MosaicEngine | null>(null)
  // Mirror of photos so worker callbacks and generate read the latest list
  // without re-subscribing on every change.
  const photosRef = React.useRef<Photo[]>(photos)
  React.useEffect(() => {
    photosRef.current = photos
  }, [photos])
  // Monotonic token so a superseded generate (rapid density tweaks) is discarded
  // rather than overwriting a newer result.
  const generateTokenRef = React.useRef(0)

  // Thumbnail object URLs are session-scoped — revoke them on unmount. Per-photo
  // revocation otherwise happens in handleRemovePhoto / the ingest callback.
  React.useEffect(() => {
    return () => {
      photosRef.current.forEach(
        (p) => p.thumbUrl && URL.revokeObjectURL(p.thumbUrl)
      )
    }
  }, [])

  // Spin up the mosaic worker once on mount. It owns decoding, signature
  // extraction, tile matching, and base-canvas rendering, keeping the main
  // thread responsive with thousands of photos.
  React.useEffect(() => {
    const engine = new MosaicEngine()
    engineRef.current = engine
    engine.onIngested = ({ id, thumb, dateCaption }) => {
      const url = thumb ? URL.createObjectURL(thumb) : undefined
      setPhotos((curr) => {
        const idx = curr.findIndex((p) => p.id === id)
        if (idx === -1) {
          // Photo was removed mid-ingest — drop the freshly-made URL.
          if (url) URL.revokeObjectURL(url)
          return curr
        }
        const next = curr.slice()
        const prev = next[idx]
        if (prev.thumbUrl) URL.revokeObjectURL(prev.thumbUrl)
        next[idx] = {
          ...prev,
          thumbUrl: url,
          status: "ready",
          caption: dateCaption ?? prev.caption,
        }
        return next
      })
    }
    engine.onProgress = (done, total) => setIngestProgress({ done, total })
    return () => {
      engine.terminate()
      engineRef.current = null
    }
  }, [])

  // Keep a ref in sync so the unmount cleanup can revoke the *current* reference
  // URL (replace/remove already revoke eagerly).
  const referenceRef = React.useRef<ReferenceImage | null>(null)
  React.useEffect(() => {
    referenceRef.current = reference
  }, [reference])
  React.useEffect(() => {
    return () => {
      if (referenceRef.current) URL.revokeObjectURL(referenceRef.current.url)
    }
  }, [])

  const handleAddPhotos = React.useCallback((files: File[]) => {
    // Show pending photos immediately; the worker streams back thumbnails and
    // EXIF captions as it indexes them. Originals are handed to the worker and
    // not retained on the main thread.
    const base = photosRef.current.length
    const created = files.map((f, i) => makePhotoFromFile(f, base + i))
    setPhotos((prev) => [...prev, ...created])
    engineRef.current?.ingest(
      created.map((p, i) => ({ id: p.id, blob: files[i] }))
    )
  }, [])

  const handleRemovePhoto = React.useCallback((id: string) => {
    engineRef.current?.drop([id])
    setPhotos((prev) => {
      const target = prev.find((p) => p.id === id)
      if (target?.thumbUrl) URL.revokeObjectURL(target.thumbUrl)
      return prev.filter((p) => p.id !== id)
    })
    setSelectedPhotoId((curr) => (curr === id ? null : curr))
  }, [])

  const handleSetReference = React.useCallback(async (file: File) => {
    try {
      const next = await makeReferenceFromFile(file)
      setReference((prev) => {
        if (prev) URL.revokeObjectURL(prev.url)
        return next
      })
      // A new reference invalidates any existing mosaic — back to a white canvas.
      setHasMosaic(false)
      mosaicModelRef.current = null
      setMosaicVersion((v) => v + 1)
      mosaicCanvasRef.current
        ?.getContext("2d")
        ?.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)
    } catch {
      // Unreadable image — keep current state so the user can retry.
    }
  }, [])

  const handleRemoveReference = React.useCallback(() => {
    setReference((prev) => {
      if (prev) URL.revokeObjectURL(prev.url)
      return null
    })
    setHasMosaic(false)
    mosaicModelRef.current = null
    setMosaicVersion((v) => v + 1)
  }, [])

  const handleGenerate = React.useCallback(async () => {
    const ref = referenceRef.current
    const engine = engineRef.current
    if (!ref || !engine) return
    const ready = photosRef.current.filter(
      (p) => p.status === "ready" && p.thumbUrl
    )
    if (ready.length === 0) return
    const token = ++generateTokenRef.current
    setIsGenerating(true)
    setGenerateProgress(null)
    // Paint the reference's average color (the grout) then the worker frame on
    // top; the frame is transparent between tiles, so the grout shows in the gaps.
    let bgColor = "#ffffff"
    const blit = (frame: ImageBitmap) => {
      const ctx = mosaicCanvasRef.current?.getContext("2d")
      if (!ctx) return
      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)
      ctx.fillStyle = bgColor
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)
      ctx.drawImage(frame, 0, 0)
    }
    try {
      const refImg = await loadImage(ref.url)
      bgColor = averageColor(refImg)
      const grid = gridForCellSize(density, CANVAS_WIDTH, CANVAS_HEIGHT)
      const cellSigs = referenceCellSignatures(refImg, grid)
      // Per-cell edge orientation so each tile is rotated to follow the
      // reference's contours.
      const angles = referenceCellOrientations(refImg, grid)
      // Warped mesh: irregular quads that tessellate (no white gaps). Computed
      // deterministically here for the zoom overlay; the worker mirrors it.
      const verts = warpedGridVertices(grid, CANVAS_WIDTH, CANVAS_HEIGHT)
      const ids = ready.map((p) => p.id)
      const thumbUrls = ready.map((p) => p.thumbUrl as string)
      // The worker matches tiles to cells and renders the base mosaic, streaming
      // in-progress snapshots so the user watches it fill in. No full-res images
      // touch the main thread.
      const { assignment, base } = await engine.generate(
        cellSigs,
        grid,
        ids,
        angles,
        (frame, doneCells, totalCells) => {
          // Ignore frames from a superseded generate.
          if (token !== generateTokenRef.current) {
            frame.close()
            return
          }
          blit(frame)
          frame.close()
          setGenerateProgress({ done: doneCells, total: totalCells })
        }
      )
      // A newer generate started while we awaited — discard this stale result.
      if (token !== generateTokenRef.current) {
        base.close()
        return
      }
      blit(base)
      base.close()
      // Keep the render model so the crisp overlay can repaint visible tiles
      // from their thumbnails as the user zooms in.
      mosaicModelRef.current = { grid, assignment, angles, verts, bg: bgColor, thumbUrls }
      setMosaicVersion((v) => v + 1)
      setHasMosaic(true)
    } catch {
      // Generation failed — keep the prior canvas.
    } finally {
      if (token === generateTokenRef.current) {
        setIsGenerating(false)
        setGenerateProgress(null)
      }
    }
  }, [density])

  // Keep the latest generator in a ref so the live-density effect can call it
  // without resubscribing on every render.
  const generateRef = React.useRef(handleGenerate)
  React.useEffect(() => {
    generateRef.current = handleGenerate
  }, [handleGenerate])

  // Once a mosaic exists, re-run (debounced) whenever density changes so the
  // slider tunes the result live.
  React.useEffect(() => {
    if (!hasMosaic) return
    const id = window.setTimeout(() => void generateRef.current(), 150)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [density])

  // Decode a thumbnail into an HTMLImageElement, memoized in a bounded LRU so
  // repeated overlay renders don't re-decode and memory stays flat.
  const ensureThumb = React.useCallback(
    async (url: string): Promise<HTMLImageElement | null> => {
      const cache = crispCacheRef.current
      const hit = cache.get(url)
      if (hit) {
        // Touch: move to most-recently-used.
        cache.delete(url)
        cache.set(url, hit)
        return hit
      }
      try {
        const img = await loadImage(url)
        cache.set(url, img)
        while (cache.size > CRISP_CACHE_MAX) {
          const oldest = cache.keys().next().value
          if (oldest === undefined) break
          cache.delete(oldest)
        }
        return img
      } catch {
        return null
      }
    },
    []
  )

  // Paint the currently-visible tiles into the viewport overlay at device
  // resolution from their thumbnails. Work is bounded to the visible region, so
  // cost/memory stay flat regardless of zoom level or photo count. Async because
  // the needed thumbnails are decoded on demand.
  const renderCrisp = React.useCallback(
    async (t: Transform, isCancelled: () => boolean) => {
      const canvas = crispCanvasRef.current
      const model = mosaicModelRef.current
      if (!canvas || !model) return
      const cssW = canvas.clientWidth
      const cssH = canvas.clientHeight
      if (!cssW || !cssH) return

      const { grid, assignment, angles, verts, bg, thumbUrls } = model
      const region = {
        x: -t.x / t.scale,
        y: -t.y / t.scale,
        w: cssW / t.scale,
        h: cssH / t.scale,
      }
      const cw = CANVAS_WIDTH / grid.cols
      const ch = CANVAS_HEIGHT / grid.rows
      // Widen by one cell to match drawWarpedMosaicRegion, so warped quads that
      // spill in from just outside the region still get their tiles decoded.
      const colStart = Math.max(0, Math.floor(region.x / cw) - 1)
      const colEnd = Math.min(grid.cols - 1, Math.floor((region.x + region.w) / cw) + 1)
      const rowStart = Math.max(0, Math.floor(region.y / ch) - 1)
      const rowEnd = Math.min(grid.rows - 1, Math.floor((region.y + region.h) / ch) + 1)
      if (colEnd < colStart || rowEnd < rowStart) return

      // Decode only the tiles visible in this region.
      const needed = new Set<number>()
      for (let row = rowStart; row <= rowEnd; row++) {
        for (let col = colStart; col <= colEnd; col++) {
          needed.add(assignment[row * grid.cols + col])
        }
      }
      const tiles: (HTMLImageElement | null)[] = new Array(thumbUrls.length)
      await Promise.all(
        [...needed].map(async (idx) => {
          const url = thumbUrls[idx]
          if (url) tiles[idx] = await ensureThumb(url)
        })
      )
      // Bail if the view moved on while we were decoding.
      if (isCancelled()) return

      const dpr = window.devicePixelRatio || 1
      const bw = Math.round(cssW * dpr)
      const bh = Math.round(cssH * dpr)
      if (canvas.width !== bw) canvas.width = bw
      if (canvas.height !== bh) canvas.height = bh
      const ctx = canvas.getContext("2d")
      if (!ctx) return
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, bw, bh)
      // Map mosaic-content space → device pixels (DPR · the live pan/zoom). This
      // mirrors the CSS transform on the base canvas so the overlay lines up.
      ctx.setTransform(dpr * t.scale, 0, 0, dpr * t.scale, dpr * t.x, dpr * t.y)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = "high"
      // Grout: fill the reference's average color behind the tiles (clamped to
      // the artwork frame) so gaps stay on-palette and crisp when zoomed in.
      const fx = Math.max(region.x, 0)
      const fy = Math.max(region.y, 0)
      const fw = Math.min(region.x + region.w, CANVAS_WIDTH) - fx
      const fh = Math.min(region.y + region.h, CANVAS_HEIGHT) - fy
      if (fw > 0 && fh > 0) {
        ctx.fillStyle = bg
        ctx.fillRect(fx, fy, fw, fh)
      }
      drawWarpedMosaicRegion(
        ctx,
        grid,
        assignment,
        angles,
        tiles,
        CANVAS_WIDTH,
        CANVAS_HEIGHT,
        region,
        verts
      )
    },
    [ensureThumb]
  )

  // Reveal the crisp overlay once a zoomed-in view settles; hide it instantly
  // during interaction so the GPU-scaled base canvas tracks gestures smoothly.
  // While a button-zoom animation is running we hold off — re-running when it
  // ends — so the overlay sharpens in only after the motion completes.
  React.useEffect(() => {
    const canvas = crispCanvasRef.current
    if (!canvas) return
    canvas.style.transition = "none"
    canvas.style.opacity = "0"
    if (!mosaicModelRef.current || transform.scale < CRISP_SCALE || animating)
      return
    let cancelled = false
    const id = window.setTimeout(() => {
      void renderCrisp(transform, () => cancelled).then(() => {
        if (cancelled) return
        canvas.style.transition = "opacity 160ms ease-out"
        canvas.style.opacity = "1"
      })
    }, CRISP_SETTLE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(id)
    }
  }, [transform, mosaicVersion, animating, renderCrisp])

  // Paste an image from the clipboard to set or replace the reference.
  React.useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target)) return
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile()
          if (file) {
            e.preventDefault()
            void handleSetReference(file)
            break
          }
        }
      }
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  }, [handleSetReference])

  const readyCount = photos.reduce(
    (n, p) => (p.status === "ready" && p.thumbUrl ? n + 1 : n),
    0
  )
  const isIndexing =
    ingestProgress.total > 0 && ingestProgress.done < ingestProgress.total

  return (
    <section className="relative h-svh w-full overflow-hidden bg-muted/60 select-none">
      {/* Photoshop-style transparency checkerboard backdrop */}
      <div
        aria-hidden
        className={cn(
          "absolute inset-0",
          "[background-image:linear-gradient(45deg,var(--border)_25%,transparent_25%),linear-gradient(-45deg,var(--border)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,var(--border)_75%),linear-gradient(-45deg,transparent_75%,var(--border)_75%)]",
          "[background-size:24px_24px]",
          "[background-position:0_0,0_12px,12px_-12px,-12px_0]",
          "opacity-40"
        )}
      />
      {/* Vignette so the canvas commands the eye */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [background:radial-gradient(120%_80%_at_50%_50%,transparent_45%,oklch(0_0_0/0.18)_100%)]"
      />

      {/* Canvas viewport */}
      <div
        ref={setContainer}
        onPointerDown={onPointerDown}
        className={cn(
          "absolute inset-0 touch-none overscroll-contain outline-none",
          isPanning ? "cursor-grabbing" : "cursor-grab"
        )}
        tabIndex={0}
      >
        <div
          style={{
            width: CANVAS_WIDTH,
            height: CANVAS_HEIGHT,
            transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
            transformOrigin: "0 0",
            transition: animating
              ? "transform 240ms cubic-bezier(0.22, 1, 0.36, 1)"
              : undefined,
            willChange: "transform",
            opacity: mounted ? 1 : 0,
          }}
          className={cn(
            "shadow-2xl ring-1 shadow-black/30 ring-black/10",
            "transition-opacity duration-300"
          )}
        >
          {reference ? (
            <canvas
              ref={mosaicCanvasRef}
              width={CANVAS_WIDTH}
              height={CANVAS_HEIGHT}
              className="block size-full bg-white"
            />
          ) : (
            <CanvasArtwork />
          )}
        </div>

        {/* Full-resolution overlay: pinned to the viewport (not the transformed
            frame) and painted only when zoomed in, so the photos that make up
            the mosaic stay sharp. Transparent + non-interactive otherwise. */}
        {reference && (
          <canvas
            ref={crispCanvasRef}
            aria-hidden
            className="pointer-events-none absolute inset-0 size-full"
            style={{ opacity: 0 }}
          />
        )}
      </div>

      {/* Top-left: wordmark + reference card */}
      <div className="absolute top-6 left-6 z-20 flex flex-col gap-2">
        <div
          data-no-pan
          className="w-fit rounded-2xl border border-border/60 bg-popover/85 px-3 py-1.5 font-mono text-xs backdrop-blur-md"
        >
          Tapestry
        </div>
        {reference ? (
          <ReferenceCard
            reference={reference}
            onReplace={handleSetReference}
            onRemove={handleRemoveReference}
          />
        ) : (
          <ReferenceEmptyCard onSelect={handleSetReference} />
        )}
      </div>

      {/* Zoom toolbar */}
      <CanvasToolbar
        scale={transform.scale}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onFit={fitToView}
        on100={reset100}
      />

      {/* Mosaic controls: density + generate (enabled once tiles exist) */}
      {reference && (
        <div
          data-no-pan
          className="absolute right-6 bottom-14 z-20 flex flex-col gap-2 rounded-2xl border border-border/60 bg-popover/85 p-2.5 shadow-xl shadow-black/15 backdrop-blur-md"
        >
          <div className="flex items-center gap-3 px-1">
            <span className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
              density
            </span>
            <Slider
              className="w-36"
              min={DENSITY_MIN}
              max={DENSITY_MAX}
              step={2}
              value={[DENSITY_MIN + DENSITY_MAX - density]}
              onValueChange={(v) => setDensity(DENSITY_MIN + DENSITY_MAX - v[0])}
              aria-label="Mosaic density"
            />
          </div>
          {isIndexing && (
            <div className="px-1 font-mono text-[10px] text-muted-foreground">
              <div className="mb-1 flex justify-between tabular-nums">
                <span className="tracking-wider uppercase">indexing</span>
                <span>
                  {ingestProgress.done}/{ingestProgress.total}
                </span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-border">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-200"
                  style={{
                    width: `${(ingestProgress.done / ingestProgress.total) * 100}%`,
                  }}
                />
              </div>
            </div>
          )}
          <Button
            size="lg"
            onClick={() => void handleGenerate()}
            disabled={readyCount === 0 || isGenerating}
            data-icon="inline-start"
          >
            <Sparkles />
            {isGenerating
              ? generateProgress && generateProgress.total > 0
                ? `Generating ${Math.round(
                    (generateProgress.done / generateProgress.total) * 100
                  )}%`
                : "Generating…"
              : hasMosaic
                ? "Regenerate"
                : "Generate mosaic"}
          </Button>
        </div>
      )}

      {/* Bottom dock of polaroid photos */}
      <PhotoDock
        photos={photos}
        selectedId={selectedPhotoId}
        expanded={isDockExpanded}
        ingest={ingestProgress}
        onExpandedChange={setIsDockExpanded}
        onAdd={handleAddPhotos}
        onSelect={setSelectedPhotoId}
        onRemove={handleRemovePhoto}
      />
    </section>
  )
}
