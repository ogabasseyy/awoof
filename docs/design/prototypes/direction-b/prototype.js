// Direction-b v1 (2026-09-21): minimal progressive enhancement.
// Only behaviour: collapsible mobile navigation. Without JS the full nav
// stays visible, and FAQ uses native <details>. No tracking, no network calls.
(function () {
  "use strict";

  var toggle = document.querySelector(".menu-toggle");
  var nav = document.getElementById("site-nav");
  if (!toggle || !nav) return;

  // Reveal the toggle only when JS runs; otherwise nav stays expanded.
  toggle.hidden = false;
  nav.setAttribute("data-collapsed", "true");
  toggle.setAttribute("aria-expanded", "false");

  function setOpen(open) {
    nav.setAttribute("data-collapsed", open ? "false" : "true");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function isOpen() {
    return nav.getAttribute("data-collapsed") === "false";
  }

  toggle.addEventListener("click", function () {
    setOpen(!isOpen());
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && isOpen()) {
      setOpen(false);
      toggle.focus();
    }
  });

  // Keep nav usable across viewport changes: wide layout shows nav via CSS.
  window.addEventListener("resize", function () {
    if (window.matchMedia("(min-width: 60rem)").matches) {
      nav.removeAttribute("data-collapsed");
      toggle.setAttribute("aria-expanded", "true");
    } else if (!nav.hasAttribute("data-collapsed")) {
      nav.setAttribute("data-collapsed", "true");
      toggle.setAttribute("aria-expanded", "false");
    }
  });
})();
