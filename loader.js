// loader.js
import { pathToFileURL } from 'url';
import { createRequire } from 'module';

export function resolve(specifier, context, nextResolve) {
  if (specifier === '@augmentos/sdk') {
    return {
      url: pathToFileURL(
        require.resolve('@augmentos/sdk')
      ).href
    };
  }
  return nextResolve(specifier);
}