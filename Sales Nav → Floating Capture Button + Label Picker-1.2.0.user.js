// ==UserScript==
// @name         Sales Nav → Floating Capture Button + Label Picker
// @description  Floating Capture button with searchable label picker (add new options). Sends ONE payload with source = chosen label.
// @version      1.2.0
// @match        https://*.linkedin.com/sales/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const WEBHOOK_URL = 'https://your-webhook.example.com/path'; // <-- set your webhook
  const GATHER_MS = 1000; // wait before sending (DOM settle)
  const LOCAL_KEY = 'sn_capture_labels_v1';
  const DEFAULT_LABELS = ['Prospect','Client','Partner','Candidate','Vendor','Investor','Lead','Warm','Cold'];

  const norm = s => (s || '').replace(/\s+/g, ' ').trim();

  // ---------- Persisted labels ----------
  function getLabels() {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr) && arr.length) return arr.slice(0, 200);
    } catch {}
    return DEFAULT_LABELS.slice();
  }
  function saveLabels(arr) {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(Array.from(new Set(arr)))); } catch {}
  }

  // ---------- Inject floating button ----------
  function ensureButton() {
    if (document.getElementById('sn-floating-capture')) return;
    const btn = document.createElement('button');
    btn.id = 'sn-floating-capture';
    btn.type = 'button';
    btn.textContent = 'Capture';
    Object.assign(btn.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '999999',
      padding: '10px 14px',
      borderRadius: '999px',
      border: 'none',
      boxShadow: '0 4px 12px rgba(0,0,0,.2)',
      background: '#0a66c2',
      color: '#fff',
      fontSize: '14px',
      cursor: 'pointer'
    });
    btn.title = 'Capture hovered card / open profile';
    btn.addEventListener('click', openLabelPicker, true);
    document.body.appendChild(btn);
  }
  new MutationObserver(() => ensureButton()).observe(document.documentElement, { childList: true, subtree: true });
  ensureButton();

  // ---------- Track last element under the mouse ----------
  let lastMouseTarget = null;
  document.addEventListener('mousemove', (e) => { lastMouseTarget = e.target; }, { passive: true });

  // ---------- Card helpers ----------
  const NAME_SEL = [
    '[data-anonymize="person-name"]',
    'a[href*="/sales/people/"]',
    '[data-test-result-name]',
    'h1','h2'
  ].join(',');

  function isCard(el) {
    if (!el || el === document.documentElement) return false;
    return (
      el.hasAttribute?.('data-entity-urn') ||
      el.hasAttribute?.('data-urn') ||
      el.hasAttribute?.('data-li-entity-id') ||
      el.hasAttribute?.('data-test-search-result') ||
      el.hasAttribute?.('data-test-lead-profile-card') ||
      !!el.querySelector?.(NAME_SEL)
    );
  }
  function closestLeadCard(fromEl) {
    let el = fromEl;
    while (el && el !== document.documentElement) {
      if (isCard(el)) return el;
      el = el.parentElement;
    }
    return null;
  }
  function buildSNPeopleUrlFromUrn(urn) {
    if (!urn) return null;
    const m = urn.match(/urn:li:fs_salesProfile:\(([^,)\s]+)/i);
    if (m && m[1]) return `https://www.linkedin.com/sales/people/${encodeURIComponent(m[1])}`;
    return null;
  }

  // ---------- Name helpers (avoid “Actions list” etc.) ----------
  function text(el) { return (el && el.textContent ? el.textContent : '').replace(/\s+/g,' ').trim(); }
  function isLikelyName(s) {
    if (!s) return false;
    const bad = /(^|\b)(action|actions|list|save|saved|message|messages|more|menu|options|lead|view|relationships?|open|close|follow|following)\b/i;
    if (bad.test(s)) return false;
    if (/’s\s+experience$/i.test(s)) return false;
    if (s.length < 2 || s.length > 80) return false;
    const letters = s.replace(/[^A-Za-z\u00C0-\u024F\s'.-]/g,'').trim();
    return letters.length >= 2;
  }
  function getLeadName(container) {
    if (!container) return null;
    const peopleLinks = Array.from(container.querySelectorAll('a[href*="/sales/people/"]'));
    for (const a of peopleLinks) {
      const t = text(a);
      if (isLikelyName(t)) return t;
      const inner = a.querySelector('[data-anonymize="person-name"], span, strong');
      const t2 = text(inner);
      if (isLikelyName(t2)) return t2;
    }
    const anon = container.querySelector('[data-anonymize="person-name"]');
    let t3 = text(anon);
    t3 = t3.replace(/’s\b.*$/,'').trim();
    if (isLikelyName(t3)) return t3;
    const rn = container.querySelector('[data-test-result-name]');
    const t4 = text(rn);
    if (isLikelyName(t4)) return t4;
    const h = container.querySelector('h1, h2, h3');
    const t5 = text(h).replace(/\bactions?\b.*$/i,'').trim();
    if (isLikelyName(t5)) return t5;
    return null;
  }

  // ---------- Basic/profile extraction ----------
  const COMPANY_SEL_LIST = [
    '[data-anonymize="company-name"]',
    '[data-anonymize="current-company"]',
    '[data-test-current-employer]',
    'a[href^="/sales/company/"]',
    '.result-lockup__subtitle',
    '.result-lockup__secondary-subtitle',
    '.company-name',
    '.t-12.t-black--light'
  ];
  function qIn(root, selectors) {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }
  function extractBasicFromCard(container) {
    const name = getLeadName(container);

    const peopleLink = container.querySelector('a[href*="/sales/people/"]');
    const urn =
      container.getAttribute?.('data-entity-urn') ||
      container.getAttribute?.('data-urn') ||
      container.getAttribute?.('data-li-entity-id') ||
      null;

    let profileUrl = peopleLink?.href || buildSNPeopleUrlFromUrn(urn);
    const publicProfileUrl =
      container.querySelector('a[href^="https://www.linkedin.com/in/"]')?.href || null;

    let company = null;
    const companyEl = qIn(container, COMPANY_SEL_LIST);
    if (companyEl) {
      company = norm(companyEl.textContent) || null;
      if (!company && companyEl.getAttribute) {
        const aria = norm(companyEl.getAttribute('aria-label') || '');
        if (aria) company = aria.replace(/^go to\s*/i, '') || null;
      }
    }

    const contactSec = document.querySelector('section[data-sn-view-name="lead-contact-info"]');
    const emailEl = contactSec?.querySelector('a[href^="mailto:"]') || container.querySelector('a[href^="mailto:"]');
    const email = emailEl ? emailEl.href.replace(/^mailto:/, '') : null;

    return { name, profileUrl, publicProfileUrl, urn, company, email };
  }

  // ---------- Current role/company (document-level) ----------
  function extractCurrentRoleAndCompany() {
    const sec = document.querySelector('section[data-sn-view-name="lead-current-role"]');
    if (!sec) return { currentRole: null, currentCompany: null, currentDates: null };
    const ps = Array.from(sec.querySelectorAll('p'));
    let roleP = null;
    for (const p of ps) { if (p.querySelector('[data-anonymize="job-title"]')) { roleP = p; break; } }
    const role = roleP?.querySelector('[data-anonymize="job-title"]');
    const companyA = roleP?.querySelector('a[data-anonymize="company-name"], a[href^="/sales/company/"]');
    let datesP = null;
    if (roleP) {
      let sib = roleP.nextElementSibling;
      while (sib && sib.tagName !== 'P') sib = sib.nextElementSibling;
      datesP = sib || null;
    }
    const datesSpan = datesP?.querySelector('span') || datesP;
    return {
      currentRole: norm(role?.textContent) || null,
      currentCompany: norm(companyA?.textContent) || null,
      currentDates: norm(datesSpan?.textContent) || null
    };
  }

  // ---------- Experience (DOM) ----------
  function findExperienceList() {
    const h2s = Array.from(document.querySelectorAll('h2'));
    let container = null;
    for (const h of h2s) { if (/experience/i.test(h.textContent || '')) { container = h.parentElement; break; } }
    if (!container) container = document;
    return container.querySelector('ul.nXyuBbgYwJArATKxsZrXOhjglhXUUSs') || container.querySelector('ul');
  }
  function extractExperienceFromDOM() {
    const ul = findExperienceList();
    if (!ul) return [];
    const items = Array.from(ul.querySelectorAll('li._experience-entry_1irc72, li'));
    const out = [];
    for (const li of items) {
      const titleEl =
        li.querySelector('h2[data-anonymize="job-title"]') ||
        li.querySelector('[data-anonymize="job-title"], [data-test-title], .experience-title, .result-lockup__highlight, strong');
      const title = norm(titleEl?.textContent) || null;

      const companyPEl = li.querySelector('a[href^="/sales/company/"] p[data-anonymize="company-name"]');
      const companyLink = li.querySelector('a[href^="/sales/company/"]');
      let company = companyPEl ? norm(companyPEl.textContent) : (companyLink ? norm(companyLink.textContent) : null);

      const dateEl =
        li.querySelector('.LawrLgCWnRCQFzkhXgYRWUbQiswmvaDzf') ||
        li.querySelector('[data-test-date-range], .date-range, .experience-date-range, .t-12');
      const dateText = norm(dateEl?.textContent) || null;

      const locationEl = li.querySelector('.UdAySPWooHcMWwjEYFqcULuKitUXFBFCRWtDsg') || li.querySelector('.t-12.t-black--light');
      const location = norm(locationEl?.textContent) || null;

      const blurbEl = li.querySelector('[data-anonymize="person-blurb"]');
      const blurb = norm(blurbEl?.textContent) || null;

      if (title || company || dateText || location || blurb) {
        out.push({ title: title || null, company: company || null, dateText, location, blurb });
      }
      if (out.length >= 12) break;
    }
    return out.filter(e => e.title || e.company);
  }

  // ---------- Webhook send ----------
  function send(payload) {
    const body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      try { navigator.sendBeacon(WEBHOOK_URL, new Blob([body], { type:'application/json' })); return; } catch {}
    }
    fetch(WEBHOOK_URL, { method:'POST', headers:{'Content-Type':'application/json'}, mode:'no-cors', body })
      .catch(()=>{});
  }

  // ==========================================================
  // Label picker UI
  // ==========================================================
  let pickerEl = null, overlayEl = null, searchInput = null, listEl = null, addWrap = null, addInput = null;

  function openLabelPicker() {
    if (pickerEl) { closeLabelPicker(); }
    // overlay
    overlayEl = document.createElement('div');
    Object.assign(overlayEl.style, {
      position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.15)', zIndex: '999998'
    });
    overlayEl.addEventListener('click', closeLabelPicker, { once: true });
    document.body.appendChild(overlayEl);

    // panel
    pickerEl = document.createElement('div');
    pickerEl.id = 'sn-label-picker';
    Object.assign(pickerEl.style, {
      position: 'fixed',
      right: '16px', bottom: '64px',
      width: '280px', maxHeight: '60vh', overflow: 'hidden',
      background: '#fff', borderRadius: '12px',
      boxShadow: '0 12px 28px rgba(0,0,0,.2)',
      zIndex: '999999', display: 'flex', flexDirection: 'column',
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
    });

    const header = document.createElement('div');
    header.textContent = 'Choose a label';
    Object.assign(header.style, { padding: '12px 12px 8px', fontWeight: '600', fontSize: '14px' });

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    Object.assign(closeBtn.style, {
      position:'absolute', top:'6px', right:'10px', border:'none', background:'transparent',
      fontSize:'18px', cursor:'pointer', lineHeight:'18px'
    });
    closeBtn.addEventListener('click', closeLabelPicker);

    const searchWrap = document.createElement('div');
    Object.assign(searchWrap.style, { padding: '0 12px 8px' });
    searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Search labels...';
    Object.assign(searchInput.style, {
      width:'100%', padding:'8px 10px', border:'1px solid #e0e0e0',
      borderRadius:'8px', fontSize:'13px', outline:'none'
    });
    searchWrap.appendChild(searchInput);

    listEl = document.createElement('div');
    Object.assign(listEl.style, { overflow:'auto', padding:'4px 8px', maxHeight:'40vh' });

    addWrap = document.createElement('div');
    Object.assign(addWrap.style, { padding:'8px 12px', borderTop:'1px solid #eee', display:'flex', gap:'6px' });
    addInput = document.createElement('input');
    addInput.type = 'text';
    addInput.placeholder = 'Add new label';
    Object.assign(addInput.style, {
      flex:'1', padding:'8px 10px', border:'1px solid #e0e0e0', borderRadius:'8px', fontSize:'13px'
    });
    const addBtn = document.createElement('button');
    addBtn.textContent = 'Add';
    Object.assign(addBtn.style, {
      padding:'8px 10px', border:'none', borderRadius:'8px', background:'#0a66c2', color:'#fff', cursor:'pointer'
    });
    addBtn.addEventListener('click', () => {
      const val = norm(addInput.value);
      if (!val) return;
      const labels = getLabels();
      if (!labels.includes(val)) {
        labels.unshift(val);
        saveLabels(labels);
        renderLabelList(labels, searchInput.value);
      }
      addInput.value = '';
      searchInput.focus();
    });

    addWrap.appendChild(addInput);
    addWrap.appendChild(addBtn);

    pickerEl.appendChild(header);
    pickerEl.appendChild(closeBtn);
    pickerEl.appendChild(searchWrap);
    pickerEl.appendChild(listEl);
    pickerEl.appendChild(addWrap);
    document.body.appendChild(pickerEl);

    const labels = getLabels();
    renderLabelList(labels, '');
    searchInput.addEventListener('input', () => renderLabelList(getLabels(), searchInput.value));
    setTimeout(() => searchInput.focus(), 0);
  }

  function renderLabelList(labels, query) {
    listEl.innerHTML = '';
    const q = norm(query || '').toLowerCase();
    const filtered = labels.filter(l => !q || l.toLowerCase().includes(q));
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No matches';
      Object.assign(empty.style, { padding:'8px 10px', color:'#888', fontSize:'12px' });
      listEl.appendChild(empty);
      return;
    }
    filtered.forEach(label => {
      const row = document.createElement('button');
      row.type = 'button';
      row.textContent = label;
      Object.assign(row.style, {
        width:'100%', textAlign:'left', padding:'8px 10px',
        border:'none', background:'transparent', borderRadius:'8px', cursor:'pointer', fontSize:'13px'
      });
      row.addEventListener('mouseover', () => row.style.background = '#f3f4f6');
      row.addEventListener('mouseout',  () => row.style.background = 'transparent');
      row.addEventListener('click', () => { closeLabelPicker(); captureAndSend(label); });
      listEl.appendChild(row);
    });
  }

  function closeLabelPicker() {
    if (pickerEl) { pickerEl.remove(); pickerEl = null; }
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  }

  // ---------- Capture + send (uses chosen label as source) ----------
  function captureAndSend(selectedLabel) {
    const hoveredCard = lastMouseTarget ? closestLeadCard(lastMouseTarget) : null;
    const anyCard = hoveredCard || document.querySelector('[data-test-search-result], [data-test-lead-profile-card]');

    const payload = {
      ts: new Date().toISOString(),
      pageUrl: location.href,
      trigger: 'floating-button',   // informational
      source: selectedLabel || 'Unlabeled',
      experience: []
    };

    if (anyCard) Object.assign(payload, extractBasicFromCard(anyCard));
    Object.assign(payload, extractCurrentRoleAndCompany());

    setTimeout(() => {
      const exp = extractExperienceFromDOM();
      if (exp && exp.length) payload.experience = exp;

      console.log('[SN → Webhook][floating]', payload);
      send(payload);
    }, GATHER_MS);
  }
})();
