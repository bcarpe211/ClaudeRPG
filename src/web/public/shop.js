'use strict';

(function enhanceWardrobePurchase(root) {
  const documentRef = root.document;
  const form = documentRef?.querySelector('form[data-purchase-effect]');
  const button = form?.querySelector('button');
  if (!form || !button) return;

  const assets = [
    '/static/landing/potion.png',
    '/static/landing/sword.png',
    '/static/landing/shield.png',
    '/static/landing/coins.png',
    '/static/landing/gem_purple.png',
  ];
  const flights = [
    { x: '-124px', y: '-156px', r: '-28deg', delay: '0ms' },
    { x: '112px', y: '-182px', r: '42deg', delay: '45ms' },
    { x: '-166px', y: '-72px', r: '-18deg', delay: '90ms' },
    { x: '154px', y: '-82px', r: '34deg', delay: '135ms' },
    { x: '18px', y: '-214px', r: '22deg', delay: '180ms' },
  ];
  let forging = false;

  function submitNatively() {
    root.HTMLFormElement.prototype.submit.call(form);
  }

  form.addEventListener('submit', function onPurchase(event) {
    event.preventDefault();
    if (forging) return;
    forging = true;

    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Forging…';
    button.classList.add('purchase-forging-button');

    const reducedMotion = typeof root.matchMedia === 'function'
      && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
      submitNatively();
      return;
    }

    form.closest?.('.bazaar-product')?.classList.add('purchase-forging-card');
    const bounds = button.getBoundingClientRect();
    const layer = documentRef.createElement('div');
    layer.classList.add('purchase-burst');
    layer.setAttribute('aria-hidden', 'true');

    assets.forEach((src, index) => {
      const sprite = documentRef.createElement('img');
      const flight = flights[index];
      sprite.classList.add('purchase-burst-sprite', 'px');
      sprite.src = src;
      sprite.alt = '';
      sprite.setAttribute('aria-hidden', 'true');
      sprite.style.setProperty('--burst-left', `${bounds.left + bounds.width / 2}px`);
      sprite.style.setProperty('--burst-top', `${bounds.top + bounds.height / 2}px`);
      sprite.style.setProperty('--burst-x', flight.x);
      sprite.style.setProperty('--burst-y', flight.y);
      sprite.style.setProperty('--burst-r', flight.r);
      sprite.style.setProperty('--burst-delay', flight.delay);
      layer.appendChild(sprite);
    });

    documentRef.body.appendChild(layer);
    root.setTimeout(submitNatively, 1200);
  });
})(globalThis);
