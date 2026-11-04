export * from './config.js';
export * from './domain.js';
export * from './errors.js';
export * from './glob.js';
export * from './hooks.js';
export * from './ids.js';
export * from './layout.js';
export * from './logger.js';
export * from './paths.js';
export * from './redact.js';
export * from './text.js';

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export const MINDLY_VERSION = '0.1.2';
