'use strict';

(function enhanceWardrobePurchase(root) {
  const documentRef = root.document;
  const consumeResult = documentRef?.querySelector('[data-consume-shop-result]');
  if (consumeResult && root.location?.href && root.history?.replaceState && root.URL) {
    const url = new root.URL(root.location.href);
    url.searchParams.delete('result');
    root.history.replaceState(
      root.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
  }

  const consumableOffers = documentRef?.querySelectorAll?.('[data-consumable-offer]') ?? [];
  consumableOffers.forEach((offer) => {
    const quantityInput = offer.querySelector('input[name="quantity"]');
    const button = offer.querySelector('button[type="submit"]');
    const affordability = offer.querySelector('[data-potion-affordability]');
    const unitPrice = Number(offer.getAttribute('data-unit-price'));
    const playerGold = Number(offer.getAttribute('data-player-gold'));
    const stockRemaining = Number(offer.getAttribute('data-stock-remaining'));
    const readyCopy = offer.getAttribute('data-ready-copy');
    if (!quantityInput || !button || !affordability || !readyCopy) return;
    if (![unitPrice, playerGold, stockRemaining].every(Number.isSafeInteger)) return;

    function updateConsumableTotal() {
      if (stockRemaining === 0) {
        button.disabled = true;
        return;
      }
      const selected = Number(quantityInput.value);
      const quantity = Number.isSafeInteger(selected)
        ? Math.max(1, Math.min(3, stockRemaining, selected))
        : 1;
      quantityInput.value = String(quantity);
      const total = unitPrice * quantity;
      const missingGold = Math.max(0, total - playerGold);
      button.textContent = `Buy ${quantity} · ${total.toLocaleString('en-US')}g`;
      button.disabled = stockRemaining === 0 || missingGold > 0;
      if (missingGold > 0) {
        affordability.textContent = `Need ${missingGold.toLocaleString('en-US')}g more for ${quantity}.`;
        affordability.classList.remove('is-ready');
      } else {
        affordability.textContent = readyCopy;
        affordability.classList.add('is-ready');
      }
    }

    quantityInput.addEventListener('input', updateConsumableTotal);
    updateConsumableTotal();
  });

  const forms = documentRef?.querySelectorAll?.('form[data-purchase-effect]') ?? [];
  if (forms.length === 0) return;

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
  forms.forEach((form) => {
    const button = form.querySelector('button');
    if (!button) return;
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
  });
})(globalThis);
