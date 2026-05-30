// Persist indexed photos (their thumbnail, color signature, and metadata) in
// IndexedDB so a previously-uploaded library is restored on reload instead of
// being re-uploaded and re-indexed. Cookies/localStorage can't hold this much
// binary data; IndexedDB stores Blobs and typed arrays directly.
//
// Records are keyed by a cheap file identity (name:size:lastModified), so
// re-adding the same file is recognized without reading its bytes.

export type CachedPhoto = {
  fileKey: string
  id: string
  thumb: Blob
  sig: Float32Array
  w: number
  h: number
  caption: string
  dateCaption: string | null
  addedAt: number
}

const DB_NAME = "tapestry"
const STORE = "photos"
const VERSION = 1

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "fileKey" })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// All cache helpers swallow errors (private mode, quota, unsupported) and fall
// back to a no-op so the app works the same with or without persistence.
export async function getAllCachedPhotos(): Promise<CachedPhoto[]> {
  try {
    const db = await openDb()
    return await new Promise<CachedPhoto[]>((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll()
      req.onsuccess = () => resolve(req.result as CachedPhoto[])
      req.onerror = () => reject(req.error)
    })
  } catch {
    return []
  }
}

export async function putCachedPhoto(record: CachedPhoto): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).put(record)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // ignore — persistence is best-effort
  }
}

export async function deleteCachedPhoto(fileKey: string): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).delete(fileKey)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // ignore — persistence is best-effort
  }
}

export async function clearCachedPhotos(): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // ignore — persistence is best-effort
  }
}
