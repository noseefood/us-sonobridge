// Interactive versions of paper Fig. 1 (refinement step by step) and Fig. 5 (one view, switch methods).
// Assets: static/interactive/ (tools/export_interactive.py). No autoplay; reduced motion steps without fading.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const fmt = x => (x < 0 ? '−' : '') + Math.abs(x).toFixed(2);

function initBridge(root, manifest) {
  const slider = root.querySelector('.bv-range');
  const play = root.querySelector('.bv-play');
  const stacks = [...root.querySelectorAll('.bv-stack')];
  const readout = { sb: root.querySelector('[data-readout=sb]'), unsb: root.querySelector('[data-readout=unsb]') };
  const stepName = root.querySelector('.bv-step-name');
  const names = ['Simulated image X₀', 'Step 1', 'Step 2', 'Step 3', 'Step 4', 'Output'];
  const contrast = manifest.vessel_contrast;
  const lerp = (arr, v) => {
    const i = Math.min(Math.floor(v), arr.length - 2);
    const f = v - i;
    return arr[i] * (1 - f) + arr[i + 1] * f;
  };
  function render(v) {
    const lo = Math.floor(v);
    const f = reduceMotion.matches ? 0 : v - lo;
    for (const stack of stacks) {
      stack.querySelectorAll('img[data-frame]').forEach(img => {
        const k = Number(img.dataset.frame);
        img.style.opacity = k === lo ? 1 : (k === lo + 1 ? f : 0);
      });
    }
    readout.sb.textContent = fmt(lerp(contrast.sb, v));
    readout.unsb.textContent = fmt(lerp(contrast.unsb, v));
    const nearest = Math.round(v);
    stepName.textContent = names[nearest];
    slider.setAttribute('aria-valuetext', names[nearest]);
  }
  slider.addEventListener('input', () => { stop(); render(Number(slider.value)); });
  let raf = null;
  function stop() {
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
    play.setAttribute('aria-pressed', 'false');
    play.querySelector('span').textContent = 'Play';
  }
  play.addEventListener('click', () => {
    if (raf !== null) return stop();
    play.setAttribute('aria-pressed', 'true');
    play.querySelector('span').textContent = 'Pause';
    let v = Number(slider.value) >= 5 ? 0 : Number(slider.value);
    let last = performance.now();
    const speed = 5 / 4200; // the whole bridge in about 4 s
    const tick = now => {
      const dt = now - last;
      if (reduceMotion.matches) {
        if (dt < 700) { raf = requestAnimationFrame(tick); return; }
        v = Math.min(5, Math.floor(v) + 1);
      } else v = Math.min(5, v + dt * speed);
      last = now;
      slider.value = v;
      render(v);
      if (v >= 5) return stop();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(t => { last = t; tick(t); });
  });
  for (const toggle of root.querySelectorAll('input[data-layer]')) {
    toggle.addEventListener('change', () => {
      root.querySelectorAll(`img.bv-layer-${toggle.dataset.layer}`).forEach(img => { img.hidden = !toggle.checked; });
    });
  }
  render(Number(slider.value));
}

function initCompare(root, views) {
  const base = 'static/interactive/compare/';
  const viewButtons = root.querySelector('.cv-views');
  const methodButtons = root.querySelector('.cv-methods');
  const main = root.querySelector('.cv-main-img');
  const overlay = root.querySelector('.cv-overlay');
  const name = root.querySelector('.cv-name');
  const labels = root.querySelector('.cv-labels-img');
  const ct = root.querySelector('.cv-ct-img');
  const sim = root.querySelector('.cv-sim-img');
  const ref = root.querySelector('.cv-ref-img');
  const overlayToggle = root.querySelector('.cv-overlay-toggle');
  const stage = root.querySelector('.cv-stage');
  const entries = views[0].methods.map(m => ({ key: m.toLowerCase(), label: m }));
  let view = views[0], method = entries[0];
  views.forEach((v, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = v.title.replace(' · ', ': ');
    b.dataset.index = i;
    b.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
    viewButtons.append(b);
  });
  entries.forEach((m, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = m.label;
    b.dataset.key = m.key;
    if (m.key === 'sonobridge') b.classList.add('ours');
    b.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
    methodButtons.append(b);
  });
  const preload = v => v.methods.forEach(m => { const im = new Image(); im.src = `${base}${v.key}/${m.toLowerCase()}.webp`; });
  function show() {
    const dir = `${base}${view.key}/`;
    stage.style.aspectRatio = `${view.size[0]} / ${view.size[1]}`;
    main.src = `${dir}${method.key}.webp`;
    main.alt = `${method.label} output for the ${view.title.toLowerCase()} view`;
    overlay.src = `${dir}labels-overlay.png`;
    name.textContent = method.label;
    name.classList.toggle('ours', method.key === 'sonobridge');
    labels.src = `${dir}labels.webp`;
    ct.src = `${dir}ct.webp`;
    sim.src = `${dir}simulated.webp`;
    ref.src = `${dir}reference.webp`;
    for (const im of [labels, ct, sim, ref]) im.closest('figure').style.aspectRatio = `${view.size[0]} / ${view.size[1]}`;
    viewButtons.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(views[b.dataset.index] === view)));
    methodButtons.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.key === method.key)));
  }
  viewButtons.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    view = views[b.dataset.index];
    preload(view);
    show();
  });
  methodButtons.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    method = entries.find(m => m.key === b.dataset.key);
    show();
  });
  root.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key) || e.target.closest('input')) return;
    const i = entries.indexOf(method);
    method = entries[(i + (e.key === 'ArrowRight' ? 1 : entries.length - 1)) % entries.length];
    show();
    methodButtons.querySelector(`[data-key="${method.key}"]`).focus({ preventScroll: true });
    e.preventDefault();
  });
  overlayToggle.addEventListener('change', () => { overlay.hidden = !overlayToggle.checked; });
  show();
  preload(view);
}

const bridgeRoot = document.getElementById('bridge-viewer');
const compareRoot = document.getElementById('compare-viewer');
fetch('static/interactive/manifest.json?v=8306734452df')
  .then(r => r.json())
  .then(m => {
    if (bridgeRoot) initBridge(bridgeRoot, m.bridge);
    if (compareRoot) initCompare(compareRoot, m.compare);
  })
  .catch(() => {
    for (const r of [bridgeRoot, compareRoot]) r?.classList.add('is-unavailable');
  });
