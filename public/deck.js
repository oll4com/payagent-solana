// One slide at a time; arrows, space, Home and End move; #3 opens slide 3. Printing shows every slide (deck.css) for a PDF.
const slides = [...document.querySelectorAll('.slide')];
let at = Math.min(Math.max((Number(location.hash.slice(1)) || 1) - 1, 0), slides.length - 1);
const show = (n) => {
  at = Math.min(Math.max(n, 0), slides.length - 1);
  slides.forEach((slide, i) => slide.classList.toggle('active', i === at));
  document.getElementById('counter').textContent = `${at + 1} / ${slides.length}`;
  history.replaceState(null, '', `#${at + 1}`);
};
addEventListener('keydown', (e) => {
  if (['ArrowRight', 'ArrowDown', ' ', 'PageDown'].includes(e.key)) show(at + 1);
  else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) show(at - 1);
  else if (e.key === 'Home') show(0);
  else if (e.key === 'End') show(slides.length - 1);
});
document.getElementById('deck').addEventListener('click', (e) => { if (!e.target.closest('a')) show(at + 1); });
show(at);
