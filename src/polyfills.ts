// src/polyfills.ts
// Simple polyfill for util.inherits

import { inherits as inheritsFn } from 'util';

// Apply polyfills to global scope
if (typeof globalThis !== 'undefined') {
  if (typeof (globalThis as any).util === 'undefined') {
    (globalThis as any).util = {};
  }
  (globalThis as any).util.inherits = inheritsFn;
}

// Also export for explicit imports if needed
export const inherits = inheritsFn;