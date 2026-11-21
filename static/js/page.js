// Load the viewer near the viewport; the overview video loads only on request.
const demo = document.getElementById('interactive');
let demoStarted = false;
function loadDemo() {
  if (demoStarted) return;
  demoStarted = true;
  import('./demo.js?v=36').catch(() => {
    document.getElementById('demo-status').textContent = 'The demo could not be loaded. Please reload to try again.';
  });
}
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) {
      observer.disconnect();
      loadDemo();
    }
  }, { rootMargin: '64px 0px 220px' });
  const observeViewer = () => observer.observe(demo.querySelector('.viewer-grid'));
  // Let the browser restore the article fragment or scroll position before preloading the viewer.
  if (document.querySelector(':target')?.closest('.project-section') && document.readyState !== 'complete') {
    window.addEventListener('load', () => requestAnimationFrame(observeViewer), { once: true });
  } else observeViewer();
} else loadDemo();
document.querySelectorAll('a[href="#interactive"]').forEach(link => link.addEventListener('click', loadDemo));

const dialog = document.getElementById('video-dialog');
const video = document.getElementById('overview-video');
const error = document.getElementById('video-error');
const chapterMenu = document.getElementById('chapter-menu');
const currentChapter = document.getElementById('current-chapter');
const compactChapters = matchMedia('(max-width: 720px), (max-height: 580px)');
function fitChapterMenu() {
  chapterMenu.open = !compactChapters.matches;
}
fitChapterMenu();
compactChapters.addEventListener('change', fitChapterMenu);
let videoOpener;
function openOverview(event) {
  videoOpener = event.currentTarget;
  document.dispatchEvent(new Event('sonobridge:pause'));
  if (!video.hasAttribute('src') || video.error) {
    const useSmallVideo = matchMedia('(max-width: 720px)').matches || navigator.connection?.saveData;
    video.poster = video.dataset.poster;
    video.src = useSmallVideo ? video.dataset.mobileSrc : video.dataset.src;
  }
  dialog.showModal();
  document.body.classList.add('video-open');
  error.hidden = true;
  video.play().catch(() => { /* Native controls remain available if play is interrupted. */ });
}
for (const button of document.querySelectorAll('[data-open-overview]')) {
  button.addEventListener('click', openOverview);
}
document.getElementById('close-overview').addEventListener('click', () => dialog.close());
for (const overlay of document.querySelectorAll('dialog')) {
  overlay.addEventListener('click', event => {
    if (event.target !== overlay) return;
    const box = overlay.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) overlay.close();
  });
}
dialog.addEventListener('close', () => {
  video.pause();
  document.body.classList.remove('video-open');
  videoOpener?.focus({ preventScroll: true });
});
video.addEventListener('error', () => { error.hidden = false; });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) video.pause();
});

const chapters = [...dialog.querySelectorAll('[data-time]')];
let selectedChapter = chapters.find(button => button.hasAttribute('aria-current'));
let pendingChapterTime = null;
function updateChapter() {
  const active = chapters.filter(button => Number(button.dataset.time) <= video.currentTime + 0.001).at(-1);
  if (active === selectedChapter) return;
  selectedChapter?.removeAttribute('aria-current');
  active?.setAttribute('aria-current', 'true');
  selectedChapter = active;
  if (active) currentChapter.textContent = active.textContent.trim().replace(' ', ' · ');
}
for (const button of chapters) {
  button.addEventListener('click', () => {
    const time = Number(button.dataset.time);
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) video.currentTime = time;
    else pendingChapterTime = time;
    updateChapter();
    if (compactChapters.matches) {
      chapterMenu.open = false;
      chapterMenu.querySelector('summary').focus({ preventScroll: true });
    }
    video.play().catch(() => {});
  });
}
video.addEventListener('loadedmetadata', () => {
  if (pendingChapterTime !== null) {
    video.currentTime = pendingChapterTime;
    pendingChapterTime = null;
  }
  updateChapter();
});
video.addEventListener('timeupdate', updateChapter);
video.addEventListener('seeked', updateChapter);

const figureDialog = document.getElementById('figure-dialog');
const figureStage = document.getElementById('figure-stage');
const figureImage = document.getElementById('figure-image');
const figureScale = document.getElementById('figure-scale');
const figureError = document.getElementById('figure-error');
let figureOpener;

function setFigureScale(actualSize, x = 0, y = 0) {
  figureStage.classList.toggle('actual-size', actualSize);
  figureScale.textContent = actualSize ? 'Fit to view' : 'Actual size';
  figureStage.scrollLeft = actualSize ? figureImage.offsetWidth * x - figureStage.clientWidth / 2 : 0;
  figureStage.scrollTop = actualSize ? figureImage.offsetHeight * y - figureStage.clientHeight / 2 : 0;
}

for (const link of document.querySelectorAll('[data-figure-title]')) {
  link.addEventListener('click', event => {
    if (!figureDialog.showModal || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    figureOpener = link;
    document.dispatchEvent(new Event('sonobridge:pause'));
    document.getElementById('figure-title').textContent = link.dataset.figureTitle;
    document.getElementById('figure-caption').textContent = document.getElementById(link.getAttribute('aria-describedby')).textContent;
    figureImage.alt = link.querySelector('img')?.alt || link.dataset.figureAlt;
    figureError.hidden = true;
    figureError.querySelector('a').href = link.href;
    figureStage.hidden = false;
    setFigureScale(false);
    if (figureImage.src !== link.href || !figureImage.naturalWidth) {
      figureStage.setAttribute('aria-busy', 'true');
      figureScale.disabled = true;
      figureImage.src = link.href;
    }
    figureDialog.showModal();
    document.body.classList.add('figure-open');
  });
}
figureImage.addEventListener('load', () => {
  figureStage.removeAttribute('aria-busy');
  figureScale.disabled = false;
});
figureImage.addEventListener('error', () => {
  figureStage.removeAttribute('aria-busy');
  figureStage.hidden = true;
  figureScale.disabled = true;
  figureError.hidden = false;
});
figureScale.addEventListener('click', () => setFigureScale(!figureStage.classList.contains('actual-size')));
figureImage.addEventListener('click', event => {
  const bounds = figureImage.getBoundingClientRect();
  setFigureScale(!figureStage.classList.contains('actual-size'), (event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height);
});
figureDialog.addEventListener('close', () => {
  document.body.classList.remove('figure-open');
  figureOpener?.focus({ preventScroll: true });
});
