// Library API.
export { compress, DEFAULT_LEVEL, MAX_LEVEL, headerLine } from './compress.js';
export { detect, TYPES } from './detect.js';
export { estimateTokens } from './tokens.js';
export { openStore, defaultDataDir, hashText } from './store.js';
export { parseHandle, findMarkers, sliceSpan, HandleError } from './handles.js';

import { parseHandle } from './handles.js';

// Expand a handle (marker text, ts:id, or ts:id:120-480) to the exact original span.
export function expand(handle, { store }) {
  if (!store) throw new Error('expand needs a store');
  return store.expand(parseHandle(handle)).text;
}
