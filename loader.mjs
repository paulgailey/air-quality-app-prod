import { pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@augmentos/sdk') {
    return {
      url: pathToFileURL(
        process.cwd() + '\\node_modules\\@augmentos\\sdk\\dist\\index.js'
      ).href,
      format: 'module'
    };
  }
  return nextResolve(specifier);
}
