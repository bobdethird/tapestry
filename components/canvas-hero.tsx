"use client"

import * as React from "react"
import { Frame, Maximize, Minus, Plus, Sparkles } from "lucide-react"

import {
  PhotoDock,
  captionDateFromFile,
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
import { cn } from "@/lib/utils"

const CANVAS_WIDTH = 1600
const CANVAS_HEIGHT = 1000
const MIN_SCALE = 0.1
const MAX_SCALE = 8

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

  // Blob URLs are session-scoped — revoke them when the component unmounts so
  // we don't leak memory or hold onto detached files.
  React.useEffect(() => {
    return () => {
      photos.forEach((p) => URL.revokeObjectURL(p.url))
    }
    // We intentionally only run this on unmount; per-photo revocation happens
    // in handleRemove.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const handleAddPhotos = React.useCallback(
    (files: File[]) => {
      // Create the photos up front with their filename-derived captions so they
      // show in the dock instantly (EXIF parsing below is async).
      const created = files.map((f, i) =>
        makePhotoFromFile(f, photos.length + i)
      )
      setPhotos((prev) => [...prev, ...created])

      // Then, if a photo carries a capture date in its metadata, swap its
      // caption for that date. Matching by id means this safely no-ops when a
      // photo was removed before its metadata resolved.
      created.forEach((photo, i) => {
        void captionDateFromFile(files[i]).then((dateCaption) => {
          if (!dateCaption) return
          setPhotos((curr) => {
            // Photo may have been removed while its metadata was parsing;
            // return the same reference so React skips a needless re-render.
            if (!curr.some((p) => p.id === photo.id)) return curr
            return curr.map((p) =>
              p.id === photo.id ? { ...p, caption: dateCaption } : p
            )
          })
        })
      })
    },
    [photos.length]
  )

  const handleRemovePhoto = React.useCallback((id: string) => {
    setPhotos((prev) => {
      const target = prev.find((p) => p.id === id)
      if (target) URL.revokeObjectURL(target.url)
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
    } catch {
      // Unreadable image — keep current state so the user can retry.
    }
  }, [])

  const handleRemoveReference = React.useCallback(() => {
    setReference((prev) => {
      if (prev) URL.revokeObjectURL(prev.url)
      return null
    })
  }, [])

  const handleGenerate = React.useCallback(() => {
    // TODO: mosaic generation (future phase) — assemble `photos` into a mosaic
    // that matches `reference`, then swap it in for the placeholder artwork.
  }, [])

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
            <div className="size-full bg-white" />
          ) : (
            <CanvasArtwork />
          )}
        </div>
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

      {/* Generate the mosaic from the tiles (enabled once tiles exist) */}
      {reference && (
        <div data-no-pan className="absolute right-6 bottom-14 z-20">
          <Button
            size="lg"
            onClick={handleGenerate}
            disabled={photos.length === 0}
            data-icon="inline-start"
            className="shadow-xl shadow-black/15"
          >
            <Sparkles />
            Generate mosaic
          </Button>
        </div>
      )}

      {/* Bottom dock of polaroid photos */}
      <PhotoDock
        photos={photos}
        selectedId={selectedPhotoId}
        expanded={isDockExpanded}
        onExpandedChange={setIsDockExpanded}
        onAdd={handleAddPhotos}
        onSelect={setSelectedPhotoId}
        onRemove={handleRemovePhoto}
      />
    </section>
  )
}
