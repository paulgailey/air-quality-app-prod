// global-polyfill.ts
// This file provides a more direct global polyfill that works at the bundling level

import { inherits } from 'util-deprecate';

// Apply the inherits function directly to the global scope
// This ensures it's available even before explicit imports
if (typeof globalThis !== 'undefined') {
  if (typeof (globalThis as any).util === 'undefined') {
    (globalThis as any).util = {};
  }
  
  (globalThis as any).util.inherits = inherits;
}

// Also export for explicit imports
export { inherits };