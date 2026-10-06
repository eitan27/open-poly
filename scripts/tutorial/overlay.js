// Injected into the page before the app loads (Playwright addInitScript). Draws
// what a screen recording of a real person would show and a headless-driven one
// doesn't: a cursor, click ripples, keystroke badges — plus the video's own
// captions, spotlights and title/end cards. Everything is pointer-events:none so
// it never intercepts the clicks it illustrates.
(() => {
  const css = `
  #tut-root{position:fixed;inset:0;pointer-events:none;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif}
  #tut-cursor{position:fixed;left:0;top:0;width:26px;height:26px;transform:translate(-3px,-2px);transition:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.55));z-index:5}
  .tut-ripple{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #4f9cff;background:rgba(79,156,255,.25);animation:tut-rip .55s ease-out forwards;z-index:4}
  @keyframes tut-rip{from{transform:scale(.3);opacity:1}to{transform:scale(1.25);opacity:0}}
  #tut-keys{position:fixed;left:50%;bottom:118px;transform:translateX(-50%);display:flex;gap:8px;z-index:3}
  .tut-key{display:flex;gap:6px;align-items:center;padding:8px 16px;border-radius:12px;background:rgba(20,22,28,.92);border:1px solid rgba(255,255,255,.18);color:#fff;font-size:24px;font-weight:600;box-shadow:0 6px 20px rgba(0,0,0,.45);transition:opacity .35s}
  .tut-key kbd{font:inherit;min-width:26px;text-align:center;padding:2px 8px;border-radius:7px;background:#2c313c;border-bottom:3px solid #161a20}
  /* Above .tut-card (z-index 6): the title and end cards hold for whole lines,
     and a burned-in caption that the card covers is a caption nobody reads. */
  #tut-cap{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);max-width:820px;width:max-content;padding:10px 20px;border-radius:12px;background:rgba(12,14,18,.82);color:#f3f5f8;font-size:21px;line-height:1.35;text-align:center;opacity:0;transition:opacity .25s;z-index:7}
  .tut-spot{position:fixed;border:3px solid #ffcc33;border-radius:12px;box-shadow:0 0 0 9999px rgba(0,0,0,.38),0 0 24px rgba(255,204,51,.7);opacity:0;transition:opacity .35s;z-index:2}
  .tut-card{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;color:#fff;text-align:center;background:radial-gradient(1200px 700px at 50% 40%,#1f3b6e 0%,#0d1422 60%,#080b12 100%);opacity:0;transition:opacity .7s;z-index:6}
  .tut-card h1{margin:0;font-size:88px;letter-spacing:-2px;font-weight:800}
  .tut-card h1 span{color:#4f9cff}
  .tut-card h2{margin:0;font-size:32px;font-weight:500;color:#c9d6ea}
  .tut-card .tut-tags{display:flex;gap:12px;margin-top:10px}
  .tut-card .tut-tags div{padding:8px 16px;border:1px solid rgba(255,255,255,.25);border-radius:999px;font-size:19px;color:#dfe7f3;background:rgba(255,255,255,.06)}
  .tut-card .tut-url{margin-top:24px;font-size:22px;color:#9fb4d4;font-family:ui-monospace,Menlo,monospace}
  .tut-card .tut-next{font-size:22px;letter-spacing:3px;text-transform:uppercase;color:#4f9cff;font-weight:700}
  .tut-toast{position:fixed;right:22px;bottom:104px;display:flex;gap:12px;align-items:center;padding:14px 20px;border-radius:12px;background:#f4f6fa;color:#111;font-size:19px;box-shadow:0 10px 30px rgba(0,0,0,.5);opacity:0;transform:translateY(12px);transition:opacity .35s,transform .35s;z-index:3}
  .tut-toast b{font-weight:700}
  `;
  const CURSOR = `<svg viewBox="0 0 26 26" width="26" height="26"><path d="M3 2 L3 21 L8 16.5 L11.6 24 L15 22.5 L11.5 15.2 L18 15.2 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

  function mount() {
    if (document.getElementById("tut-root")) return;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    const root = document.createElement("div");
    root.id = "tut-root";
    root.innerHTML = `<div id="tut-cursor">${CURSOR}</div><div id="tut-keys"></div><div id="tut-cap"></div>`;
    document.body.appendChild(root);
    const cursor = root.querySelector("#tut-cursor");
    cursor.style.left = "-100px";
    const move = (e) => {
      cursor.style.left = e.clientX + "px";
      cursor.style.top = e.clientY + "px";
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("mousemove", move, true);
    window.addEventListener(
      "pointerdown",
      (e) => {
        const r = document.createElement("div");
        r.className = "tut-ripple";
        r.style.left = e.clientX + "px";
        r.style.top = e.clientY + "px";
        if (e.button === 2) r.style.borderColor = "#ffb84f";
        root.appendChild(r);
        setTimeout(() => r.remove(), 600);
      },
      true,
    );
    // Keystroke badges for shortcuts — not for text typed into an input.
    const keys = root.querySelector("#tut-keys");
    const label = (e) => {
      const k = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (["Shift", "Meta", "Control", "Alt"].includes(e.key)) return null;
      const parts = [];
      if (e.metaKey) parts.push("⌘");
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.shiftKey && k !== "?") parts.push("⇧");
      parts.push(k === "Enter" ? "↵" : k === "Escape" ? "Esc" : k);
      return parts;
    };
    window.addEventListener(
      "keydown",
      (e) => {
        const t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        const parts = label(e);
        if (!parts) return;
        const el = document.createElement("div");
        el.className = "tut-key";
        el.innerHTML = parts.map((p) => `<kbd>${p}</kbd>`).join("");
        keys.innerHTML = "";
        keys.appendChild(el);
        setTimeout(() => (el.style.opacity = "0"), 1300);
        setTimeout(() => el.remove(), 1700);
      },
      true,
    );
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);

  const root = () => document.getElementById("tut-root");
  window.__tut = {
    caption(text) {
      const c = document.getElementById("tut-cap");
      if (!text) {
        c.style.opacity = "0";
        return;
      }
      c.textContent = text;
      c.style.opacity = "1";
    },
    spot(rect, ms = 2500, pad = 6) {
      const s = document.createElement("div");
      s.className = "tut-spot";
      Object.assign(s.style, {
        left: rect.x - pad + "px",
        top: rect.y - pad + "px",
        width: rect.width + 2 * pad + "px",
        height: rect.height + 2 * pad + "px",
      });
      root().appendChild(s);
      requestAnimationFrame(() => (s.style.opacity = "1"));
      setTimeout(() => (s.style.opacity = "0"), ms);
      setTimeout(() => s.remove(), ms + 400);
    },
    card(html, id) {
      const c = document.createElement("div");
      c.className = "tut-card";
      c.id = id;
      c.innerHTML = html;
      root().appendChild(c);
      requestAnimationFrame(() => requestAnimationFrame(() => (c.style.opacity = "1")));
    },
    hideCard(id) {
      const c = document.getElementById(id);
      if (!c) return;
      c.style.opacity = "0";
      setTimeout(() => c.remove(), 800);
    },
    toast(html, ms = 3500) {
      const t = document.createElement("div");
      t.className = "tut-toast";
      t.innerHTML = html;
      root().appendChild(t);
      requestAnimationFrame(() => {
        t.style.opacity = "1";
        t.style.transform = "none";
      });
      setTimeout(() => (t.style.opacity = "0"), ms);
      setTimeout(() => t.remove(), ms + 400);
    },
  };
})();
