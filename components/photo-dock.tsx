"use client"

import * as React from "react"
import { Images, Plus, X } from "lucide-react"
import exifr from "exifr"

import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

export type Photo = {
  id: string
  url: string
  rotation: number
  caption: string
}

// How much of the dock peeks above the viewport bottom when collapsed.
// Exported so the canvas can position its floating toolbar to match.
export const DOCK_PEEK_HEIGHT = 32

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

// Format a capture date as a compact MM/DD/YY caption, e.g. "05/28/26".
function formatDateCaption(date: Date) {
  return date.toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
  })
}

// Read a photo's capture date from EXIF metadata, preferring when the shutter
// fired (DateTimeOriginal) and falling back through the other date tags.
// Resolves to a formatted caption, or null when there's no usable date — no
// EXIF, an unsupported format, or a parse failure — so callers keep using the
// filename caption. Runs client-side; exifr reads the file bytes directly.
export async function captionDateFromFile(file: File): Promise<string | null> {
  try {
    const exif = await exifr.parse(file, [
      "DateTimeOriginal",
      "CreateDate",
      "ModifyDate",
    ])
    const raw = exif?.DateTimeOriginal ?? exif?.CreateDate ?? exif?.ModifyDate
    if (!raw) return null
    // exifr revives these tags to Date objects (in local time), but returns the
    // raw string if it can't parse them — coerce and validate either way.
    const date = raw instanceof Date ? raw : new Date(raw)
    if (Number.isNaN(date.getTime())) return null
    return formatDateCaption(date)
  } catch {
    return null
  }
}

export function makePhotoFromFile(file: File, index: number): Photo {
  return {
    id: crypto.randomUUID(),
    url: URL.createObjectURL(file),
    rotation: tiltForIndex(index),
    caption: captionFromFile(file),
  }
}

interface PhotoDockProps {
  ref?: React.Ref<HTMLDivElement>
  photos: Photo[]
  selectedId: string | null
  expanded: boolean
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
  onExpandedChange,
  onAdd,
  onSelect,
  onRemove,
}: PhotoDockProps) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const [isDragOver, setIsDragOver] = React.useState(false)

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
          <span className="text-foreground/80 tabular-nums">
            {photos.length}
          </span>
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
          className={cn(
            "flex items-end gap-4 overflow-x-auto px-6 pt-3 pb-3",
            "snap-x [scrollbar-width:thin]",
            "[scrollbar-color:var(--border)_transparent]"
          )}
        >
          {photos.length === 0 ? (
            <EmptyHint />
          ) : (
            photos.map((p) => (
              <PolaroidCard
                key={p.id}
                photo={p}
                selected={p.id === selectedId}
                onClick={() => onSelect(p.id)}
                onRemove={() => onRemove(p.id)}
              />
            ))
          )}
          <AddPhotoTile onClick={() => inputRef.current?.click()} />
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
        "group relative shrink-0 snap-center transition-transform duration-200 ease-out",
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
          {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded blob URLs don't benefit from next/image optimization */}
          <img
            src={photo.url}
            alt={photo.caption}
            className="size-full object-cover"
            draggable={false}
          />
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
        "group grid shrink-0 snap-center",
        "h-[134px] w-[100px] place-items-center",
        "border border-dashed border-border/80 bg-popover/40",
        "text-muted-foreground transition-colors",
        "hover:border-foreground/60 hover:text-foreground"
      )}
    >
      <div className="flex flex-col items-center gap-1">
        <Plus className="size-4 transition-transform group-hover:scale-110" />
        <span className="font-mono text-[9px] tracking-wider uppercase">
          add
        </span>
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
