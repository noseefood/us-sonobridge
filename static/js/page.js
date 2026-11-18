// Load the viewer near the viewport; the overview video loads only on request.
const demo = document.getElementById('interactive');
let demoStarted = false;
function loadDemo() {
  if (demoStarted) return;
  demoStarted = true;
  import('./demo.js?v=33').catch(() => {
    document.getElementById('demo-status').textContent = 'The demo could not be loaded. Please reload to try again.';
  });
}
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) {
      observer.disconnect();
      loadDemo();
    }
  }, { rootMargin: '220px 0px' });
  observer.observe(demo);
} else loadDemo();
document.querySelectorAll('a[href="#interactive"]').forEach(link => link.addEventListener('click', loadDemo));

const dialog = document.getElementById('video-dialog');
const video = document.getElementById('overview-video');
const trigger = document.getElementById('open-overview');
const error = document.getElementById('video-error');
trigger.addEventListener('click', () => {
  document.dispatchEvent(new Event('sonobridge:pause'));
  if (!video.hasAttribute('src')) {
    video.poster = video.dataset.poster;
    video.src = video.dataset.src;
  }
  dialog.showModal();
  document.body.classList.add('video-open');
  error.hidden = true;
  video.play().catch(() => { /* Native controls remain available if play is interrupted. */ });
});
document.getElementById('close-overview').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const box = dialog.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
});
dialog.addEventListener('close', () => {
  video.pause();
  document.body.classList.remove('video-open');
  trigger.focus({ preventScroll: true });
});
video.addEventListener('error', () => { error.hidden = false; });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) video.pause();
});

const chapters = [...dialog.querySelectorAll('[data-time]')];
let selectedChapter;
function updateChapter() {
  const active = chapters.filter(button => Number(button.dataset.time) <= video.currentTime).at(-1);
  if (active === selectedChapter) return;
  selectedChapter?.removeAttribute('aria-current');
  active?.setAttribute('aria-current', 'true');
  selectedChapter = active;
}
for (const button of chapters) {
  button.addEventListener('click', () => {
    video.currentTime = Number(button.dataset.time);
    updateChapter();
    video.play().catch(() => {});
  });
}
video.addEventListener('timeupdate', updateChapter);
