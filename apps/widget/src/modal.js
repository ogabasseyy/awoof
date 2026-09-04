/**
 * Modal UI – overlay and content container.
 * Renders a simple modal for verification flow and messages.
 */

const CSS = `
  .awoof-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .awoof-modal {
    background: #fff;
    border-radius: 12px;
    max-width: 420px;
    width: 90%;
    max-height: 90vh;
    overflow: auto;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
  }
  .awoof-modal__header {
    padding: 16px 20px;
    border-bottom: 1px solid #eee;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .awoof-modal__title { margin: 0; font-size: 18px; font-weight: 600; }
  .awoof-modal__close {
    background: none;
    border: none;
    font-size: 24px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
    color: #666;
  }
  .awoof-modal__body { padding: 20px; }
  .awoof-modal__message { color: #333; margin: 0 0 16px; }
  .awoof-modal__error { color: #b91c1c; margin: 0 0 16px; }
`;

export function injectStyles() {
  if (document.getElementById('awoof-widget-styles')) return;
  const el = document.createElement('style');
  el.id = 'awoof-widget-styles';
  el.textContent = CSS;
  document.head.appendChild(el);
}

/**
 * @param {Object} opts
 * @param {string} [opts.title='Verify Student Status']
 * @param {string} [opts.message]
 * @param {string} [opts.error]
 * @param {() => void} [opts.onClose]
 * @returns {{ open: () => void, close: () => void, setContent: (html: string) => void, setNode: (node: Node) => void, setError: (msg: string) => void }}
 */
export function createModal(opts = {}) {
  injectStyles();

  const title = opts.title || 'Verify Student Status';
  let overlay = null;

  function open() {
    if (overlay && overlay.parentNode) return;
    overlay = document.createElement('div');
    overlay.className = 'awoof-overlay';
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('role', 'dialog');

    const modal = document.createElement('div');
    modal.className = 'awoof-modal';

    const header = document.createElement('div');
    header.className = 'awoof-modal__header';
    header.innerHTML = `<h2 class="awoof-modal__title">${escapeHtml(title)}</h2>`;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'awoof-modal__close';
    closeBtn.innerHTML = '&times;';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.onclick = () => close();
    header.appendChild(closeBtn);
    modal.appendChild(header);

    const body = document.createElement('div');
    body.className = 'awoof-modal__body';
    if (opts.message) {
      const p = document.createElement('p');
      p.className = 'awoof-modal__message';
      p.textContent = opts.message;
      body.appendChild(p);
    }
    if (opts.error) {
      const p = document.createElement('p');
      p.className = 'awoof-modal__error';
      p.textContent = opts.error;
      body.appendChild(p);
    }
    modal.appendChild(body);

    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    document.body.appendChild(overlay);
  }

  function close() {
    if (overlay && overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
      overlay = null;
    }
    opts.onClose && opts.onClose();
  }

  function setContent(html) {
    if (!overlay) return;
    const body = overlay.querySelector('.awoof-modal__body');
    if (body) body.innerHTML = html;
  }

  function setNode(node) {
    if (!overlay) return;
    const body = overlay.querySelector('.awoof-modal__body');
    if (!body) return;
    body.replaceChildren(node);
  }

  function setError(msg) {
    if (!overlay) return;
    const body = overlay.querySelector('.awoof-modal__body');
    if (!body) return;
    let errEl = body.querySelector('.awoof-modal__error');
    if (!errEl) {
      errEl = document.createElement('p');
      errEl.className = 'awoof-modal__error';
      body.appendChild(errEl);
    }
    errEl.textContent = msg;
  }

  return { open, close, setContent, setNode, setError };
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
