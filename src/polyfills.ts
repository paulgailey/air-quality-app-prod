// src/polyfills.ts
// Polyfill for legacy Node.js APIs
import { inherits } from 'util-deprecate';

// Apply polyfills to global Node.js modules
// This ensures they're available throughout the entire application
const applyPolyfills = () => {
  try {
    // Handle both ESM and CommonJS patterns
    import('util').then(utilModule => {
      const util = utilModule.default || utilModule;
      if (!util.inherits) {
        util.inherits = inherits;
        
        // Also patch the global util for any code that might access it directly
        if (typeof globalThis.util === 'undefined') {
          (globalThis as any).util = {};
        }
        
        if (!(globalThis as any).util.inherits) {
          (globalThis as any).util.inherits = inherits;
        }
      }
    }).catch(() => {
      // Fallback for environments where dynamic import doesn't work as expected
      const util = require('util');
      if (!util.inherits) {
        util.inherits = inherits;
        
        // Also patch the global util
        if (typeof globalThis.util === 'undefined') {
          (globalThis as any).util = {};
        }
        
        if (!(globalThis as any).util.inherits) {
          (globalThis as any).util.inherits = inherits;
        }
      }
    });
  } catch (e) {
    console.warn('Error applying polyfills:', e);
  }
};

// Execute the polyfill application immediately
applyPolyfills();

export { inherits };