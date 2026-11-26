// The on-screen keyboard (Android) covers half the screen. A web app cannot change the phone's own keyboard, so this makes the page work WITH it:
//  - the page shrinks to the space above the keyboard (viewport meta: interactive-widget=resizes-content) and the field you tap is scrolled into view,
//  - while the keyboard is open the top bar and the floating + button get out of the way (class "kb-open" on <body>),
//  - a small "Done" button sits just above the keyboard to close it.
(function () {
  const vv = window.visualViewport;
  let done = null, baseH = window.innerHeight;
  const isField = (el) => el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !/^(checkbox|radio|button|submit|file|range|color)$/.test(el.type || '');
  function ensureDone() {
    if (done) return done;
    done = document.createElement('button');
    done.type = 'button'; done.id = 'kb-done'; done.textContent = '⌄ Done';
    done.addEventListener('pointerdown', (e) => { e.preventDefault(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
    document.body.appendChild(done);
    return done;
  }
  function update() {
    const h = vv ? vv.height : window.innerHeight;
    if (!vv && window.innerHeight > baseH) baseH = window.innerHeight;
    const open = (vv ? (window.innerHeight - h) : (baseH - window.innerHeight)) > 120 && isField(document.activeElement);
    document.body.classList.toggle('kb-open', !!open);
    const b = ensureDone();
    b.style.display = open ? 'block' : 'none';
    if (open && vv) b.style.bottom = Math.max(0, window.innerHeight - (vv.offsetTop + vv.height)) + 8 + 'px';
    else if (open) b.style.bottom = '8px';
  }
  function reveal() {
    const el = document.activeElement;
    if (!isField(el) || !el.scrollIntoView) return;
    setTimeout(() => { try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { el.scrollIntoView(); } }, 320);   // after the keyboard has finished opening
  }
  document.addEventListener('focusin', () => { update(); reveal(); });
  document.addEventListener('focusout', () => setTimeout(update, 120));
  if (vv) { vv.addEventListener('resize', () => { update(); reveal(); }); vv.addEventListener('scroll', update); }
  else window.addEventListener('resize', () => { update(); reveal(); });
})();
