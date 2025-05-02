// src/polyfills.ts
import { inherits } from 'util-deprecate';
import * as util from 'util';

// Type-safe polyfill assignment
Object.defineProperty(util, 'inherits', {
  value: inherits,
  writable: true,
  configurable: true
});