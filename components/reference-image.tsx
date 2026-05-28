"use client"

import * as React from "react"
import { ImageUp } from "lucide-react"

import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

export type ReferenceImage = {
  url: string
  name: string
  width: number
  height: number
}

// Load a file into a reference image, reading its natural dimensions so callers
// can letterbox/fit it. Creates a session-scoped object URL; the caller owns
// revoking it (on replace/remove/unmount) to avoid leaks.
export function makeReferenceFromFile(file: File): Promise<ReferenceImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () =>
      resolve({
        url,
        name: file.name,
        width: img.naturalWidth,
        height: img.naturalHeight,
      })
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("Could not read image"))
    }
    img.src = url
  })
}

function firstImage(files: FileList | null): File | null {
  if (!files) return null
  for (const file of Array.from(files)) {
    if (file.type.startsWith("image/")) return file
  }
  return null
}

interface ReferenceEmptyCardProps {
  onSelect: (file: File) => void
}

// Compact empty-state card that lives in the side reference area. Click to
// browse or drop an image onto it (pasting also works, handled by the canvas).
// No forced full-screen prompt.
export function ReferenceEmptyCard({ onSelect }: ReferenceEmptyCardProps) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = React.useState(false)
  // dragenter/leave fire for every child; a depth counter keeps the highlight
  // stable until the pointer actually leaves the card.
  const dragDepth = React.useRef(0)

  return (
    <div data-no-pan>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return
          e.preventDefault()
          dragDepth.current++
          setIsDragOver(true)
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault()
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setIsDragOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          dragDepth.current = 0
          setIsDragOver(false)
          const file = firstImage(e.dataTransfer.files)
          if (file) onSelect(file)
        }}
        aria-label="Add reference image"
        className={cn(
          "group flex w-56 flex-col items-center gap-2 rounded-2xl px-4 py-5 text-center",
          "border-2 border-dashed border-border/70 bg-popover/80 backdrop-blur-md",
          "transition-colors outline-none",
          "hover:border-foreground/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30",
          isDragOver && "border-primary bg-primary/5"
        )}
      >
        <span className="grid size-9 place-items-center rounded-full border border-border/60 bg-background/60 text-muted-foreground transition-colors group-hover:text-foreground">
          <ImageUp className="size-4" />
        </span>
        <span className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
          Reference
        </span>
        <span className="text-xs font-medium">Add reference image</span>
        <span className="font-mono text-[10px] text-muted-foreground/70">
          click, drop, or paste
        </span>
      </button>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = firstImage(e.target.files)
          if (file) onSelect(file)
          e.target.value = ""
        }}
      />
    </div>
  )
}

interface ReferenceCardProps {
  reference: ReferenceImage
  onReplace: (file: File) => void
  onRemove: () => void
}

// Persistent home for the active reference: thumbnail + filename + actions.
export function ReferenceCard({
  reference,
  onReplace,
  onRemove,
}: ReferenceCardProps) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  return (
    <div
      data-no-pan
      className="flex w-56 items-start gap-3 rounded-2xl border border-border/60 bg-popover/85 p-2.5 backdrop-blur-md"
    >
      <div className="size-14 shrink-0 overflow-hidden rounded-md bg-muted ring-1 ring-black/5">
        {/* eslint-disable-next-line @next/next/no-img-element -- object URL, no next/image benefit */}
        <img
          src={reference.url}
          alt={reference.name}
          className="size-full object-cover"
          draggable={false}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
          Reference
        </span>
        <span className="truncate text-xs font-medium" title={reference.name}>
          {reference.name}
        </span>
        <div className="flex items-center gap-2 font-mono text-[10px] tracking-wide uppercase">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="text-primary transition-colors hover:text-primary/80"
          >
            replace
          </button>
          <Separator
            orientation="vertical"
            className="h-3 data-vertical:self-center"
          />
          <button
            type="button"
            onClick={onRemove}
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            remove
          </button>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = firstImage(e.target.files)
          if (file) onReplace(file)
          e.target.value = ""
        }}
      />
    </div>
  )
}
