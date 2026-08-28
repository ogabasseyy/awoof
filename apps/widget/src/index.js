/**
 * Awoof Widget – entry point.
 * Exposes Awoof on window for script-tag usage and as default export for bundlers.
 */

import Awoof from './widget.js';

if (typeof window !== 'undefined') {
  window.Awoof = Awoof;
}

export default Awoof;
