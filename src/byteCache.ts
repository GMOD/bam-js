export interface ByteCacheConfig {
  maxBytes: number
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024 // 64MB default

interface CacheEntry {
  data: Uint8Array
  size: number
}

export default class ByteCache {
  private cache = new Map<number, CacheEntry>()
  private accessOrder: number[] = []
  private currentBytes = 0
  private maxBytes: number

  constructor(config?: Partial<ByteCacheConfig>) {
    this.maxBytes = config?.maxBytes ?? DEFAULT_MAX_BYTES
  }

  get(blockPosition: number): Uint8Array | undefined {
    const entry = this.cache.get(blockPosition)
    if (entry) {
      const idx = this.accessOrder.indexOf(blockPosition)
      if (idx !== -1) {
        this.accessOrder.splice(idx, 1)
        this.accessOrder.push(blockPosition)
      }
      return entry.data
    }
    return undefined
  }

  set(blockPosition: number, data: Uint8Array) {
    if (this.cache.has(blockPosition)) {
      return
    }

    const size = data.byteLength

    // Evict until we have room
    while (
      this.currentBytes + size > this.maxBytes &&
      this.accessOrder.length > 0
    ) {
      const oldest = this.accessOrder.shift()
      if (oldest !== undefined) {
        const evicted = this.cache.get(oldest)
        if (evicted) {
          this.currentBytes -= evicted.size
          this.cache.delete(oldest)
        }
      }
    }

    this.cache.set(blockPosition, { data, size })
    this.accessOrder.push(blockPosition)
    this.currentBytes += size
  }

  has(blockPosition: number): boolean {
    return this.cache.has(blockPosition)
  }

  clear() {
    this.cache.clear()
    this.accessOrder = []
    this.currentBytes = 0
  }

  get size() {
    return this.cache.size
  }

  get totalBytes() {
    return this.currentBytes
  }
}
