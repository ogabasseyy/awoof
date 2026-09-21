/**
 * Application logger
 * Use instead of console.* in app code. In production, only errors are logged to stdout.
 * All output is neutralized for log injection (CWE-117): every sink goes
 * through safeMessage(), which strips newlines/control chars via neutralize().
 */

import { config } from '../config/env.js';

const isProd = config.isProduction;

/** Neutralize newlines and control chars (plain-text log injection). */
function neutralize(s: string): string {
  return s.replace(/[\r\n\x00-\x1f]/g, ' ');
}

function toLogString(arg: unknown): string {
  if (typeof arg === 'string') return neutralize(arg);
  if (arg instanceof Error) return neutralize(arg.message);
  if (Array.isArray(arg)) return arg.map(toLogString).join(' ');
  if (arg !== null && typeof arg === 'object') return neutralize(JSON.stringify(arg));
  return String(arg);
}

/** Build a single safe string from args; final output neutralized for log injection. */
function safeMessage(args: unknown[]): string {
  const joined = args.map(toLogString).join(' ');
  return neutralize(joined);
}

export const appLogger = {
  info: (...args: unknown[]) => {
    if (!isProd) {
      const msg = safeMessage(args);
      // msg is neutralized by safeMessage/neutralize (CWE-117); the sanitizer
      // is unmodeled so the finding is dismissed as a false positive.
      console.log(msg);
    }
  },
  warn: (...args: unknown[]) => {
    if (!isProd) {
      const msg = safeMessage(args);
      console.warn(msg);
    }
  },
  error: (...args: unknown[]) => {
    const msg = safeMessage(args);
    console.error(msg);
  },
  debug: (...args: unknown[]) => {
    if (!isProd) {
      const msg = safeMessage(args);
      console.debug(msg);
    }
  },
};
