import { describe, expect, it } from 'vitest';
import { isPuterDesktopEnvironment } from '../src/storage/backends.js';

describe('storage environment selection', () => {
  it('uses Puter cloud only in the native Puter desktop container', () => {
    expect(isPuterDesktopEnvironment('app')).toBe(true);
    expect(isPuterDesktopEnvironment('web')).toBe(false);
    expect(isPuterDesktopEnvironment(undefined)).toBe(false);
    expect(isPuterDesktopEnvironment('browser')).toBe(false);
  });
});
