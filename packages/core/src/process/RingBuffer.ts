export const DEFAULT_RING_BYTES = 1024 * 1024; // 1 MiB

export class RingBuffer {
  private chunks: Buffer[] = [];
  private _byteSize = 0;

  constructor(private readonly maxBytes: number = DEFAULT_RING_BYTES) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this._byteSize += chunk.length;
    // Drop oldest chunks until within cap, but never drop the only chunk
    while (this._byteSize > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this._byteSize -= dropped.length;
    }
  }

  tail(bytes: number): Buffer {
    if (this.chunks.length === 0) return Buffer.alloc(0);
    const full = Buffer.concat(this.chunks);
    if (full.length <= bytes) return full;
    return full.subarray(full.length - bytes);
  }

  get byteSize(): number {
    return this._byteSize;
  }
}
