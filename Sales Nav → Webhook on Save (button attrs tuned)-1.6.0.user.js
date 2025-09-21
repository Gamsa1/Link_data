// ==UserScript==
// @name         Sales Nav → Webhook on Save (button attrs tuned)
// @description  Fire ONLY when the real Save-lead button is clicked; scope to that card
// @version      1.6.0
// @match        https://*.linkedin.com/sales/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const WEBHOOK_URL = 'https://your-webhook.example.com/path'; // <-- put your webhook here
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();

  // Button matcher: accepts the exact Save-lead control you shared
  function getSaveButton(node) {
    if (!(node instanceof HTMLElement)) return null;
    const btn = node.closest('button');
    if (!btn) return null;

    // Match by the attributes present in your HTML
    const matchesAttrs = btn.matches(
      'button[data-x--lead-save-cta], button[data-anchor-save-lead-or-account], button[data-x--save-menu-trigger]'
    );

    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
    const txt  = norm(btn.textContent).toLowerCase();
    const looksSave =
      matchesAttrs ||
      (aria.includes('save') && aria.includes('lead')) ||
      txt === 'save' || txt.includes('save lead');

    return looksSave ? btn : null;
  }

  // Find a container that holds the person info (name/link) AND this button
  const NAME_SEL = [
    '[data-anonymize="person-name"]',
    'a[href*="/sales/people/"]',
    '[data-test-result-name]',
    'h1','h2'
  ].join(',');

  const COMPANY_SEL = [
    '[data-anonymize="company-name"]',
    'a[href*="/sales/company/"]',
    '[data-test-current-employer]'
  ].join(',');

  function closestLeadCard(fromEl) {
    let el = fromEl;
    while (el && el !== document.documentElement) {
      if (el.querySelector && el.querySelector(NAME_SEL)) return el; // has a name inside
      // prefer typical wrappers if present
      if (
        el.hasAttribute?.('data-entity-urn') ||
        el.hasAttribute?.('data-urn') ||
        el.hasAttribute?.('data-li-entity-id') ||
        el.hasAttribute?.('data-test-search-result') ||
        el.hasAttribute?.('data-test-lead-profile-card')
      ) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function extractFrom(container) {
    const q = sel => container.querySelector(sel);

    const nameEl = q(NAME_SEL);
    const name = norm(nameEl?.textContent) || null;

    const peopleLink = q('a[href*="/sales/people/"]');

    const urn =
      container.getAttribute?.('data-entity-urn') ||
      container.getAttribute?.('data-urn') ||
      container.getAttribute?.('data-li-entity-id') ||
      null;

    let profileUrl = null;
    if (peopleLink?.href) {
      profileUrl = peopleLink.href;
    } else if (urn && urn.includes('urn:li:fs_salesProfile:')) {
      const m = urn.match(/fs_salesProfile:\(([^,)\s]+)/);
      const id = m?.[1];
      if (id) profileUrl = `https://www.linkedin.com/sales/people/${encodeURIComponent(id)}`;
    }

    const publicProfileUrl = q('a[href^="https://www.linkedin.com/in/"]')?.href || null;

    const companyEl = q(COMPANY_SEL);
    const company = norm(companyEl?.textContent) || null;

    const emailEl = q('a[href^="mailto:"]');
    const email = emailEl ? emailEl.href.replace(/^mailto:/,'') : null;

    return { name, profileUrl, publicProfileUrl, urn, company, email };
  }

  function send(payload) {
    const body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      try { navigator.sendBeacon(WEBHOOK_URL, new Blob([body], { type:'application/json' })); return; } catch {}
    }
    fetch(WEBHOOK_URL, { method:'POST', headers:{'Content-Type':'application/json'}, mode:'no-cors', body })
      .catch(()=>{});
  }

  // Click-only handler (no MutationObserver)
  document.addEventListener('click', (e) => {
    if (e.button !== 0) return; // left click only

    const path = e.composedPath ? e.composedPath() : (function p(n){const a=[];while(n){a.push(n);n=n.parentNode;}a.push(window);return a;})(e.target);
    // Find the exact Save-lead button using your attributes/text
    const btn = (() => {
      for (const n of path) {
        const hit = getSaveButton(n);
        if (hit) return hit;
      }
      return null;
    })();
    if (!btn) return;

    // Find THIS button’s card only
    const card = closestLeadCard(btn);
    if (!card) {
      console.log('[SN → Webhook] Save clicked, but no card with a name found near the button.');
      return;
    }

    // Small delay for any micro re-render, then extract & send
    setTimeout(() => {
      const data = extractFrom(card);
      const payload = { ts: new Date().toISOString(), pageUrl: location.href, source: 'click', ...data };
      console.log('[SN → Webhook]', payload);
      send(payload);
    }, 120);
  }, true);

  console.log('[SN Capture] loaded (tuned to Save button attributes)');
})();
