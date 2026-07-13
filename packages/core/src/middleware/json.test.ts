import { assertJsonSafe } from './json.js';

describe('assertJsonSafe', () => {
  it('permits repeated non-cyclic shared objects', () => {
    const shared = { valid: true };
    expect(() => assertJsonSafe({ first: shared, second: shared })).not.toThrow();
  });

  it('permits null-prototype objects', () => {
    const value = Object.create(null) as Record<string, unknown>;
    value.valid = true;
    expect(() => assertJsonSafe(value)).not.toThrow();
  });

  it('rejects sparse arrays and custom array properties', () => {
    const sparse = Array(1);
    const custom = [1] as number[] & { extra?: number };
    custom.extra = 2;

    expect(() => assertJsonSafe(sparse)).toThrow(/\$\[0\].*sparse/i);
    expect(() => assertJsonSafe(custom)).toThrow(/property.*extra/i);
  });

  it('rejects array symbol and accessor properties', () => {
    const symbolKey = Object.assign([1], { [Symbol('secret')]: true });
    const accessor = Object.defineProperty([1], '0', {
      enumerable: true,
      get() {
        throw new Error('must not run');
      },
    });

    expect(() => assertJsonSafe(symbolKey)).toThrow(/symbol key/i);
    expect(() => assertJsonSafe(accessor)).toThrow(/accessor/i);
  });

  it('rejects symbol keys and accessors without invoking getters', () => {
    let invoked = false;
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        invoked = true;
        return 'value';
      },
    });
    const symbolKey = { [Symbol('secret')]: 'value' };

    expect(() => assertJsonSafe(accessor)).toThrow(/\$\.secret.*accessor/i);
    expect(invoked).toBe(false);
    expect(() => assertJsonSafe(symbolKey)).toThrow(/symbol key/i);
  });

  it('rejects non-enumerable own properties', () => {
    const object = Object.defineProperty({}, 'hidden', { value: 'data' });
    const array = Object.defineProperty([1], '0', { enumerable: false });

    expect(() => assertJsonSafe(object)).toThrow(/hidden.*non-enumerable/i);
    expect(() => assertJsonSafe(array)).toThrow(/\$\[0\].*non-enumerable/i);
  });

  it('rejects non-enumerable toJSON without invoking it', () => {
    let invoked = false;
    const value = Object.defineProperty({}, 'toJSON', {
      value() {
        invoked = true;
        return {};
      },
    });

    expect(() => assertJsonSafe(value)).toThrow(/toJSON.*non-enumerable/i);
    expect(invoked).toBe(false);
  });
});
