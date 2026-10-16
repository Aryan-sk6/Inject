import claudeCode from './claude-code/index.js';

/** @type {Record<string, import('./types.js').Adapter>} */
export const adapters = {
  [claudeCode.id]: claudeCode,
};

export const defaultAdapter = claudeCode;
