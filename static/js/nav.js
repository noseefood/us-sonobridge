// Sticky nav: shadow once the page scrolls, and highlight the section in view.
document.addEventListener('DOMContentLoaded', function () {
  var nav = document.querySelector('.site-nav');
  if (!nav) return;

  function onScroll() {
    nav.classList.toggle('is-scrolled', window.scrollY > 8);
  }
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  var links = Array.prototype.slice.call(nav.querySelectorAll('.site-nav-links a[href^="#"]'));
  var sections = links
    .map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); })
    .filter(Boolean);
  if (!sections.length || !('IntersectionObserver' in window)) return;

  function setActive(id) {
    links.forEach(function (a) {
      var on = a.getAttribute('href') === '#' + id;
      a.classList.toggle('is-active', on);
      if (on) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    });
  }

  // A section counts as current while it crosses a band just below the nav.
  var visible = {};
  function update() {
    var current = null;
    sections.forEach(function (s) { if (visible[s.id]) current = current || s.id; });
    // Short placeholder sections can share the viewport. Respect the selected
    // anchor while its heading is visible, including when scrolling is clamped.
    var selected = sections.find(function (s) { return '#' + s.id === window.location.hash; });
    if (selected) {
      var top = selected.getBoundingClientRect().top;
      if (top >= nav.offsetHeight && top < window.innerHeight - 48) current = selected.id;
    }
    setActive(current);
  }

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { visible[e.target.id] = e.isIntersecting; });
    update();
  }, { rootMargin: '-15% 0px -70% 0px' });

  sections.forEach(function (s) { observer.observe(s); });
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('hashchange', update);
});
