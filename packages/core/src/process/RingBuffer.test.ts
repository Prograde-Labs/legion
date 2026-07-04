import { RingBuffer } from './RingBuffer.js';

describe('RingBuffer', () => {
  it('starts empty', () => {
    const rb = new RingBuffer(1024);
    expect(rb.byteSize).toBe(0);
    expect(rb.tail(100)).toEqual(Buffer.alloc(0));
  });

  it('stores and returns chunks', () => {
    const rb = new RingBuffer(1024);
    rb.push(Buffer.from('hello '));
    rb.push(Buffer.from('world'));
    expect(rb.tail(100)).toEqual(Buffer.from('hello world'));
  });

  it('tail returns at most requested bytes', () => {
    const rb = new RingBuffer(1024);
    rb.push(Buffer.from('abcdefghij'));
    const result = rb.tail(5);
    expect(result).toEqual(Buffer.from('fghij'));
  });

  it('drops oldest chunks when full', () => {
    // cap = 10 bytes
    const rb = new RingBuffer(10);
    rb.push(Buffer.from('12345')); // 5 bytes, fits
    rb.push(Buffer.from('67890')); // 5 bytes, total 10, fits
    rb.push(Buffer.from('ABCDE')); // 5 bytes, total 15 > 10 → drop oldest
    // After drop: '67890' dropped next if still over, then 'ABCDE' only chunk
    // Actually: drop oldest until byteSize <= maxBytes
    // After adding ABCDE (15 bytes): drop '12345' → 10 bytes (≤ 10, stop)
    expect(rb.byteSize).toBeLessThanOrEqual(10);
    const result = rb.tail(100);
    // '12345' dropped, remaining is '67890ABCDE'
    expect(result).toEqual(Buffer.from('67890ABCDE'));
  });

  it('handles single oversized chunk', () => {
    const rb = new RingBuffer(5);
    rb.push(Buffer.from('123456789')); // 9 bytes > 5 cap
    // Chunk is kept even though it alone exceeds maxBytes (cannot drop itself)
    expect(rb.byteSize).toBe(9);
    expect(rb.tail(100)).toEqual(Buffer.from('123456789'));
  });

  it('tail with bytes larger than content returns all content', () => {
    const rb = new RingBuffer(1024);
    rb.push(Buffer.from('hi'));
    expect(rb.tail(9999)).toEqual(Buffer.from('hi'));
  });
});
