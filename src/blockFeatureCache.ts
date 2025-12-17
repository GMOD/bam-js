export interface BlockFeatureCacheConfig {
  maxFeatures: number
}

const DEFAULT_MAX_FEATURES = 50000

interface CacheEntry<T> {
  features: T[]
  featureCount: number
}

export default class BlockFeatureCache<T> {
  private cache = new Map<number, CacheEntry<T>>()
  private accessOrder: number[] = []
  private currentFeatures = 0
  private maxFeatures: number

  constructor(config?: Partial<BlockFeatureCacheConfig>) {
    this.maxFeatures = config?.maxFeatures ?? DEFAULT_MAX_FEATURES
  }

  get(blockPosition: number): T[] | undefined {
    const entry = this.cache.get(blockPosition)
    if (entry) {
      const idx = this.accessOrder.indexOf(blockPosition)
      if (idx !== -1) {
        this.accessOrder.splice(idx, 1)
        this.accessOrder.push(blockPosition)
      }
      return entry.features
    }
    return undefined
  }

  set(blockPosition: number, features: T[]) {
    if (this.cache.has(blockPosition)) {
      return
    }

    const featureCount = features.length

    // Evict until we have room
    while (
      this.currentFeatures + featureCount > this.maxFeatures &&
      this.accessOrder.length > 0
    ) {
      const oldest = this.accessOrder.shift()
      if (oldest !== undefined) {
        const evicted = this.cache.get(oldest)
        if (evicted) {
          this.currentFeatures -= evicted.featureCount
          this.cache.delete(oldest)
        }
      }
    }

    this.cache.set(blockPosition, { features, featureCount })
    this.accessOrder.push(blockPosition)
    this.currentFeatures += featureCount
  }

  clear() {
    this.cache.clear()
    this.accessOrder = []
    this.currentFeatures = 0
  }

  get size() {
    return this.cache.size
  }

  get totalFeatures() {
    return this.currentFeatures
  }

  setMaxFeatures(maxFeatures: number) {
    this.maxFeatures = maxFeatures
    while (
      this.currentFeatures > this.maxFeatures &&
      this.accessOrder.length > 0
    ) {
      const oldest = this.accessOrder.shift()
      if (oldest !== undefined) {
        const evicted = this.cache.get(oldest)
        if (evicted) {
          this.currentFeatures -= evicted.featureCount
          this.cache.delete(oldest)
        }
      }
    }
  }
}
