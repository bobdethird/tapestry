"use client"

import * as React from "react"
import { Images, Plus, X } from "lucide-react"

import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

export type Photo = {
  id: string
  // Object URL of the worker-generated thumbnail. Undefined while the photo is
  // still being indexed, or if it couldn't be decoded.
  thumbUrl?: string
  rotation: number
  caption: string
  status: "pending" | "ready"
}

// How much of the dock peeks above the viewport bottom when collapsed.
// Exported so the canvas can position its floating toolbar to match.
export const DOCK_PEEK_HEIGHT = 32

// Fixed geometry for the virtualized row. Cards are uniform width so we can map
// scroll position to a visible slice and only mount what's on screen.
const CARD_WIDTH = 100
const CARD_GAP = 16
const SLOT = CARD_WIDTH + CARD_GAP
const TRACK_PAD = 24
const TRACK_HEIGHT = 168
const CARD_BOTTOM = 16
const OVERSCAN = 6

// Deterministic rotations so polaroids don't jitter on re-render
const TILT_PATTERN = [-4, 3, -2, 5, -3, 2, -5, 4, -1, 3, -3, 2]

function tiltForIndex(i: number) {
  return TILT_PATTERN[i % TILT_PATTERN.length]
}

function captionFromFile(file: File) {
  return (
    file.name
      .replace(/\.[^.]+$/, "")
      .replace(/[-_]+/g, " ")
      .trim()
      .slice(0, 24)
      .toLowerCase() || "untitled"
  )
}

// Create a pending photo immediately so it shows in the dock while the worker
// decodes it. The thumbnail and EXIF caption fill in via the ingest callback.
export function makePhotoFromFile(file: File, index: number): Photo {
  return {
    id: crypto.randomUUID(),
    rotation: tiltForIndex(index),
    caption: captionFromFile(file),
    status: "pending",
  }
}

interface PhotoDockProps {
  ref?: React.Ref<HTMLDivElement>
  photos: Photo[]
  selectedId: string | null
  expanded: boolean
  ingest?: { done: number; total: number }
  onExpandedChange: (next: boolean) => void
  onAdd: (files: File[]) => void
  onSelect: (id: string) => void
  onRemove: (id: string) => void
}

export function PhotoDock({
  ref,
  photos,
  selectedId,
  expanded,
  ingest,
  onExpandedChange,
  onAdd,
  onSelect,
  onRemove,
}: PhotoDockProps) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const [isDragOver, setIsDragOver] = React.useState(false)
  const [scrollLeft, setScrollLeft] = React.useState(0)
  const [viewportW, setViewportW] = React.useState(0)

  // Track each independent "reason to stay open" so they don't collide.
  // Drag uses a depth counter for nested dragenter/leave events on children.
  const triggers = React.useRef({ hover: false, focus: false, drag: 0 })

  const syncExpanded = React.useCallback(() => {
    const t = triggers.current
    onExpandedChange(t.hover || t.focus || t.drag > 0)
  }, [onExpandedChange])

  const handleFiles = React.useCallback(
    (files: File[]) => {
      const images = files.filter((f) => f.type.startsWith("image/"))
      if (images.length) onAdd(images)
    },
    [onAdd]
  )

  // Vertical wheel becomes horizontal scroll. Pass-through native horizontal
  // wheel (trackpad two-finger swipe) so it feels right on macOS.
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault()
        el.scrollLeft += e.deltaY
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  // Keep the visible window in sync with the scroller's width.
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewportW(el.clientWidth))
    ro.observe(el)
    setViewportW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const count = photos.length
  const trackWidth = TRACK_PAD * 2 + count * SLOT + CARD_WIDTH
  // Inclusive index range of cards to actually render (plus overscan).
  const first = Math.max(0, Math.floor((scrollLeft - TRACK_PAD) / SLOT) - OVERSCAN)
  const last = Math.min(
    count - 1,
    Math.ceil((scrollLeft + viewportW - TRACK_PAD) / SLOT) + OVERSCAN
  )

  const visible: number[] = []
  for (let i = first; i <= last; i++) visible.push(i)

  const indexing = ingest && ingest.total > 0 && ingest.done < ingest.total

  return (
    <div
      ref={ref}
      data-no-pan
      onMouseEnter={() => {
        triggers.current.hover = true
        syncExpanded()
      }}
      onMouseLeave={() => {
        triggers.current.hover = false
        syncExpanded()
      }}
      onFocus={() => {
        triggers.current.focus = true
        syncExpanded()
      }}
      onBlur={(e) => {
        // Don't collapse if focus just moved to another child of the dock.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        triggers.current.focus = false
        syncExpanded()
      }}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return
        e.preventDefault()
        triggers.current.drag++
        setIsDragOver(true)
        syncExpanded()
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault()
      }}
      onDragLeave={() => {
        triggers.current.drag = Math.max(0, triggers.current.drag - 1)
        if (triggers.current.drag === 0) {
          setIsDragOver(false)
          syncExpanded()
        }
      }}
      onDrop={(e) => {
        e.preventDefault()
        triggers.current.drag = 0
        setIsDragOver(false)
        syncExpanded()
        handleFiles(Array.from(e.dataTransfer.files))
      }}
      style={{
        transform: expanded
          ? "translate3d(0, 0, 0)"
          : `translate3d(0, calc(100% - ${DOCK_PEEK_HEIGHT}px), 0)`,
      }}
      className={cn(
        "absolute right-0 bottom-0 left-0 z-20",
        "border-t border-border/60 bg-popover/85 backdrop-blur-md",
        "transition-[transform,box-shadow] duration-300 ease-out will-change-transform",
        isDragOver && "shadow-[inset_0_0_0_2px_var(--primary)]"
      )}
    >
      <div className="flex items-center justify-between px-4 pt-1.5 pb-1">
        <div className="flex items-center gap-2 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
          <Images className="size-3" />
          photos
          <Separator orientation="vertical" className="h-3" />
          <span className="text-foreground/80 tabular-nums">{count}</span>
          {indexing && (
            <>
              <Separator orientation="vertical" className="h-3" />
              <span className="text-foreground/60 tabular-nums normal-case">
                indexing {ingest!.done}/{ingest!.total}
              </span>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase transition-colors hover:text-foreground"
        >
          + add
        </button>
      </div>

      <div className="relative">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r from-popover/85 to-transparent"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-popover/85 to-transparent"
        />

        <div
          ref={scrollRef}
          onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
          className={cn(
            "overflow-x-auto overflow-y-hidden",
            "[scrollbar-width:thin]",
            "[scrollbar-color:var(--border)_transparent]"
          )}
        >
          {count === 0 ? (
            <div className="px-6 py-3">
              <EmptyHint />
            </div>
          ) : (
            <div
              className="relative"
              style={{ width: trackWidth, height: TRACK_HEIGHT }}
            >
              {visible.map((i) => {
                const p = photos[i]
                return (
                  <div
                    key={p.id}
                    className="absolute"
                    style={{
                      left: TRACK_PAD + i * SLOT,
                      bottom: CARD_BOTTOM,
                    }}
                  >
                    <PolaroidCard
                      photo={p}
                      selected={p.id === selectedId}
                      onClick={() => onSelect(p.id)}
                      onRemove={() => onRemove(p.id)}
                    />
                  </div>
                )
              })}
              <div
                className="absolute"
                style={{ left: TRACK_PAD + count * SLOT, bottom: CARD_BOTTOM }}
              >
                <AddPhotoTile onClick={() => inputRef.current?.click()} />
              </div>
            </div>
          )}
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          handleFiles(Array.from(e.target.files ?? []))
          e.target.value = ""
        }}
      />
    </div>
  )
}

function PolaroidCard({
  photo,
  selected,
  onClick,
  onRemove,
}: {
  photo: Photo
  selected: boolean
  onClick: () => void
  onRemove: () => void
}) {
  return (
    <div
      style={{ rotate: `${photo.rotation}deg` }}
      className={cn(
        "group relative shrink-0 transition-transform duration-200 ease-out",
        "hover:-translate-y-1.5 hover:[rotate:0deg]",
        selected && "-translate-y-2 [rotate:0deg]"
      )}
    >
      <button
        type="button"
        onClick={onClick}
        data-selected={selected}
        className={cn(
          "block bg-white pt-2.5 pr-2.5 pb-6 pl-2.5",
          "shadow-[0_10px_24px_-6px_rgba(0,0,0,0.45)] ring-1 ring-black/5",
          "transition-shadow outline-none",
          "focus-visible:ring-2 focus-visible:ring-ring",
          "data-[selected=true]:ring-2 data-[selected=true]:ring-primary"
        )}
      >
        <div className="relative size-20 overflow-hidden bg-stone-100">
          {photo.thumbUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element -- user-uploaded blob URLs don't benefit from next/image optimization */
            <img
              src={photo.thumbUrl}
              alt={photo.caption}
              className="size-full object-cover"
              loading="lazy"
              decoding="async"
              draggable={false}
            />
          ) : (
            <div
              className={cn(
                "size-full",
                photo.status === "pending"
                  ? "animate-pulse bg-stone-200"
                  : "bg-stone-200"
              )}
            />
          )}
        </div>
        <div className="mt-1.5 w-20 truncate text-center font-mono text-[9px] tracking-wide text-stone-600 italic">
          {photo.caption}
        </div>
      </button>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        aria-label="Remove photo"
        className={cn(
          "absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full",
          "bg-foreground text-background shadow-md",
          "opacity-0 transition-opacity",
          "group-hover:opacity-100 focus-visible:opacity-100"
        )}
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

function AddPhotoTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Add photos"
      className={cn(
        "group grid shrink-0",
        "h-[134px] w-[100px] place-items-center",
        "border border-dashed border-border/80 bg-popover/40",
        "text-muted-foreground transition-colors",
        "hover:border-foreground/60 hover:text-foreground"
      )}
    >
      <div className="flex flex-col items-center gap-1">
        <Plus className="size-4 transition-transform group-hover:scale-110" />
        <span className="font-mono text-[9px] tracking-wider uppercase">add</span>
      </div>
    </button>
  )
}

function EmptyHint() {
  return (
    <div className="flex h-[134px] flex-1 items-center justify-center font-mono text-[11px] tracking-wide text-muted-foreground italic">
      drop photos here, or click + to add
    </div>
  )
}
