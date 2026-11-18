// The short placeholder sections share the bottom of the page. When an anchor
// scroll reaches that limit, its own link should remain selected.
const nav = document.querySelector('.site-nav');
const links = [...nav.querySelectorAll('.site-nav-links a')];
const sections = links.map(link => document.getElementById(link.hash.slice(1)));
let activeSection, pending = false;
function updateNavigation() {
  pending = false;
  nav.classList.toggle('is-scrolled', scrollY > 8);
  const headingLine = nav.offsetHeight + 24;
  let selected = sections[0];
  for (const section of sections) {
    if (section.getBoundingClientRect().top <= headingLine) selected = section;
  }
  const atEnd = scrollY > 0 && scrollY + innerHeight >= document.documentElement.scrollHeight - 2;
  if (atEnd) {
    const requested = sections.find(section => '#' + section.id === location.hash);
    selected = requested && requested.getBoundingClientRect().top >= 0 ? requested : sections.at(-1);
  }
  if (selected === activeSection) return;
  activeSection = selected;
  links.forEach((link,i) => {
    const active = sections[i] === selected;
    link.classList.toggle('is-active',active);
    if (active) link.setAttribute('aria-current','location');
    else link.removeAttribute('aria-current');
  });
}
function scheduleNavigation() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(updateNavigation);
}
for (const event of ['scroll','resize','hashchange','pageshow']) window.addEventListener(event,scheduleNavigation,{passive:true});
updateNavigation();
