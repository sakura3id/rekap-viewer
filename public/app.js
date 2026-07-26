"use strict";

const analytics = {
  async track(eventName, properties = {}) {
    try {
      await fetch('/api/analytics', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ eventName, properties })
      });
    } catch (e) {
      // Fail silently
    }
  }
};

// ── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG = {
  STICKY_COLUMNS: [1, 2]
};

// ── ELEMENT REFS ─────────────────────────────────────────────────────────
const statusEl = document.getElementById("status");
const filterBarEl = document.getElementById("filter-bar");
const chipGroupEl = document.getElementById("blok-chips");
const paymentChipGroupEl = document.getElementById("payment-chips");
const containerEl = document.getElementById("table-container");
const theadEl = document.getElementById("thead");
const tbodyEl = document.getElementById("tbody");
const rowCountEl = document.getElementById("row-count");
const syncTimeEl = document.getElementById("sync-time");

// ── PANEL COLLAPSE STATE ─────────────────────────────────────────────────
let isCollapsed = false;   // whether Nama/Blok are hidden by user toggle
let toggleBtn = null;    // the ◀/▶ button element
let blokShouldShow = false;   // whether filter state says Blok col should show
let searchTerm = "";     // current normalised search string (lowercase, trimmed)
let selectedNomors = new Set(); // set of selected house numbers (pills)
let nomorIndex = [];     // dynamic list of all unique house numbers
let availableYearKeys = []; // dynamic list of year keys discovered from headers
let summaryKeys = []; // dynamic list of summary column keys ('s24', 's25', ...)
let yearGroups = {}; // dynamic mapping of yearKey -> array of header indices

// ── HELPERS ──────────────────────────────────────────────────────────────

/**
 * Returns the best displayable string for a GViz cell object.
 * Preference: cell.f (formatted) → cell.v → ""
 */
function cellDisplay(val) {
  if (val === null || val === undefined) return "";
  let str = String(val).trim();
  // spec rules
  if (str === "√") return "✓";
  return str;
}

function showLoading() {
  statusEl.className = "loading";
  statusEl.innerHTML =
    '<div class="spinner" aria-hidden="true"></div>' +
    '<span>Mengambil data dari server…</span>';
  statusEl.style.display = "";
}

function hideLoading() { statusEl.style.display = "none"; }

function showError(msg) {
  statusEl.className = "error";
  statusEl.textContent = "⚠️ " + msg;
  statusEl.style.display = "block";
  rowCountEl.textContent = "Error";
}

// ── STICKY COLUMNS ───────────────────────────────────────────────────────
function applyStickyColumns() {
  // 1. Clear previous sticky state entirely
  document.querySelectorAll(".sticky-col").forEach(el => {
    el.classList.remove("sticky-col", "sticky-last");
    el.style.position = "";
    el.style.left = "";
    el.style.zIndex = "";
  });

  // 2. Determine which of the configured sticky columns are currently visible
  const visibleSticky = CONFIG.STICKY_COLUMNS.filter(colIdx => {
    const th = document.querySelector(`#thead [data-col="${colIdx}"]`);
    return th && !th.classList.contains("col-hidden");
  });

  // 3. Apply sticky left-to-right, accumulating offsets
  let leftPx = 0;
  visibleSticky.forEach((colIdx, i) => {
    const isLast = i === visibleSticky.length - 1;
    const th = document.querySelector(`#thead [data-col="${colIdx}"]`);
    if (!th) return;
    const width = th.getBoundingClientRect().width;

    document.querySelectorAll(`[data-col="${colIdx}"]`).forEach(el => {
      el.style.position = "sticky";
      el.style.left = leftPx + "px";
      el.classList.add("sticky-col");
      if (isLast) el.classList.add("sticky-last");
    });

    // Header corner cells need highest z-index to sit above body sticky cells
    document.querySelectorAll(`#thead [data-col="${colIdx}"]`)
      .forEach(el => { el.style.zIndex = isLast ? "6" : "5"; });
    document.querySelectorAll(`#tbody [data-col="${colIdx}"]`)
      .forEach(el => { el.style.zIndex = "2"; });

    leftPx += width;
  });

  // Pin summary columns continuing the same leftPx offset
  const visibleSummaryKeys = summaryKeys.filter(({ key }) => {
    const th = document.querySelector(`#thead [data-col="${key}"]`);
    return th && !th.classList.contains("col-hidden");
  });

  visibleSummaryKeys.forEach(({ key }, i) => {
    const isLast = i === visibleSummaryKeys.length - 1;
    const th = document.querySelector(`#thead [data-col="${key}"]`);
    if (!th) return;
    const width = th.getBoundingClientRect().width;

    document.querySelectorAll(`[data-col="${key}"]`).forEach(el => {
      el.style.position = "sticky";
      el.style.left = leftPx + "px";
      el.classList.add("sticky-col");
      if (isLast) el.classList.add("sticky-last");
    });

    document.querySelectorAll(`#thead [data-col="${key}"]`)
      .forEach(el => { el.style.zIndex = isLast ? "6" : "5"; });
    document.querySelectorAll(`#tbody [data-col="${key}"]`)
      .forEach(el => { el.style.zIndex = "2"; });

    leftPx += width;
  });
}

// ── COLUMN VISIBILITY ──────────────────────────────────────────────────────
function updateColumnVisibility() {
  const headers = document.querySelectorAll("#thead th");
  const hasNamaCol = Array.from(headers).some(th => th.textContent.trim() === 'Nama');

  // Blok (data-col 1): hidden when collapsed OR when filter doesn't need it
  const showBlok = blokShouldShow && !isCollapsed;
  document.querySelectorAll(`[data-col="1"]`)
    .forEach(el => el.classList.toggle("col-hidden", !showBlok));

  // Nama (data-col 2): hidden when collapsed (only if the "Nama" column exists)
  if (hasNamaCol) {
    document.querySelectorAll(`[data-col="2"]`)
      .forEach(el => el.classList.toggle("col-hidden", isCollapsed));
  }

  // Year columns visibility
  const yearFilterChips = document.getElementById("year-filter-chips");
  const activeYearChips = yearFilterChips ? [...yearFilterChips.querySelectorAll(".chip:not(.chip-all).active")] : [];
  const isAllYears = activeYearChips.length === 0;
  const selectedYears = new Set(activeYearChips.map(c => c.dataset.year));

  availableYearKeys.forEach(yearKey => {
    const show = isAllYears || selectedYears.has(yearKey);

    // Hide/show summary column: key `s${yearKey}`
    document.querySelectorAll(`[data-col="s${yearKey}"]`)
      .forEach(el => el.classList.toggle("col-hidden", !show));

    // Hide/show monthly columns: indices in yearGroups[yearKey]
    const colIndices = yearGroups[yearKey] || [];
    colIndices.forEach(colIdx => {
      document.querySelectorAll(`[data-col="${colIdx}"]`)
        .forEach(el => el.classList.toggle("col-hidden", !show));
    });
  });
}

// ── COLLAPSE / EXPAND ─────────────────────────────────────────────────────
function collapsePanel() {
  isCollapsed = true;
  if (toggleBtn) toggleBtn.textContent = "▶";
  updateColumnVisibility();
  requestAnimationFrame(() => applyStickyColumns());
}

function expandPanel() {
  isCollapsed = false;
  if (toggleBtn) toggleBtn.textContent = "◀";
  updateColumnVisibility();
  requestAnimationFrame(() => applyStickyColumns());
}

// ── FILTER ───────────────────────────────────────────────────────────────
function applyFilter() {
  const activeChips = [...chipGroupEl.querySelectorAll(".chip:not(.chip-all).active")];
  const isSemua = activeChips.length === 0;
  const selectedBloks = new Set(activeChips.map(c => c.dataset.blok));

  const activePaymentChips = paymentChipGroupEl ? [...paymentChipGroupEl.querySelectorAll(".chip:not(.chip-all).active")] : [];
  const isPaymentSemua = activePaymentChips.length === 0;

  // Hide/show rows
  let visibleCount = 0;
  const headers = document.querySelectorAll("#thead th");
  const hasNamaCol = Array.from(headers).some(th => th.textContent.trim() === 'Nama');
  const nomorColIdx = hasNamaCol ? 3 : 2;

  document.querySelectorAll("#tbody tr").forEach(tr => {
    const blokCell = tr.querySelector(`[data-col="1"]`);
    const blokVal = blokCell ? blokCell.textContent.trim() : "";
    const nomorText = tr.querySelector(`[data-col="${nomorColIdx}"]`)?.textContent.trim().toLowerCase() ?? "";
    const namaText = hasNamaCol ? (tr.querySelector(`[data-col="2"]`)?.textContent.trim().toLowerCase() ?? "") : "";

    let matchesPayment = true;
    if (!isPaymentSemua) {
      const grouped = new Map();
      activePaymentChips.forEach(chip => {
        const year = chip.dataset.year;
        if (!grouped.has(year)) grouped.set(year, []);
        grouped.get(year).push(chip.dataset.mode);
      });

      matchesPayment = [...grouped.entries()].every(([year, modes]) => {
        const summaryCell = tr.querySelector(`[data-col="s${year}"]`);
        if (!summaryCell) return false;
        const paidCount = parseInt(summaryCell.textContent.trim().split("/")[0], 10);
        if (Number.isNaN(paidCount)) return false;

        return modes.every(mode => {
          if (mode === "lunas") return paidCount === 12;
          if (mode === "belum-lunas") return paidCount < 12;
          return true;
        });
      });
    }

    const matchesBlok = isSemua || selectedBloks.has(blokVal);
    const matchesSearch = selectedNomors.size > 0
      ? selectedNomors.has(nomorText.toUpperCase())
      : (!searchTerm
        || nomorText.includes(searchTerm)
        || (hasNamaCol && namaText.includes(searchTerm)));
    const show = matchesBlok && matchesSearch && matchesPayment;
    tr.classList.toggle("row-hidden", !show);
    if (show) visibleCount++;
  });

  // Update Blok column visibility (respects both filter and collapse state)
  blokShouldShow = activeChips.length > 1;
  updateColumnVisibility();

  // Re-pin sticky columns (offsets may change with col visibility)
  requestAnimationFrame(() => applyStickyColumns());

  rowCountEl.textContent = visibleCount + " warga";

  // Update toggle button badge if on mobile
  const badge = document.getElementById("active-filter-count");
  if (badge) {
    if (activeChips.length > 0) {
      badge.textContent = activeChips.length;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }
}

// ── SEARCH (PILL MULTI-SELECT) ───────────────────────────────────────────
function initSearch() {
  const wrap = document.getElementById("pill-input-wrap");
  const input = document.getElementById("search-input");
  const clearBtn = document.getElementById("search-clear");
  const pillList = document.getElementById("pill-list");
  const suggestionsList = document.getElementById("nomor-suggestions");
  if (!input || !suggestionsList || !pillList) return;

  let activeIndex = -1;
  let currentMatches = [];

  const updatePillsUI = () => {
    pillList.innerHTML = "";
    selectedNomors.forEach(nomor => {
      const tag = document.createElement("div");
      tag.className = "pill-tag";
      tag.textContent = nomor;

      const removeBtn = document.createElement("button");
      removeBtn.className = "pill-tag__remove";
      removeBtn.innerHTML = "×";
      removeBtn.setAttribute("aria-label", `Hapus filter ${nomor}`);
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        selectedNomors.delete(nomor);
        updatePillsUI();
        applyFilter();
        input.focus();
      });

      tag.appendChild(removeBtn);
      pillList.appendChild(tag);
    });

    // Update input placeholder and visibility of clear button
    if (selectedNomors.size > 0) {
      input.placeholder = "Tambah nomor lain…";
      clearBtn.hidden = false;
    } else {
      input.placeholder = "Cari nomor atau nama…";
      clearBtn.hidden = !input.value.trim();
    }
  };

  const renderSuggestions = (matches, query) => {
    suggestionsList.innerHTML = "";
    currentMatches = matches;
    activeIndex = -1;

    if (matches.length === 0) {
      suggestionsList.hidden = true;
      return;
    }

    matches.forEach((item, index) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.setAttribute("id", `opt-${index}`);

      // Highlight matching prefix/substring
      const queryIdx = item.toLowerCase().indexOf(query.toLowerCase());
      if (queryIdx >= 0) {
        const before = item.substring(0, queryIdx);
        const match = item.substring(queryIdx, queryIdx + query.length);
        const after = item.substring(queryIdx + query.length);
        li.innerHTML = `${before}<mark>${match}</mark>${after}`;
      } else {
        li.textContent = item;
      }

      li.addEventListener("click", () => {
        selectNomor(item);
      });
      suggestionsList.appendChild(li);
    });

    suggestionsList.hidden = false;
  };

  const selectNomor = (nomor) => {
    selectedNomors.add(nomor.toUpperCase());
    input.value = "";
    searchTerm = "";
    suggestionsList.hidden = true;
    updatePillsUI();
    applyFilter();
    input.focus();

    analytics.track('filter_selected', {
      filter_type: 'nomor',
      value: nomor
    });
  };

  const handleArrowKeys = (e) => {
    if (suggestionsList.hidden) return;
    const items = suggestionsList.querySelectorAll("li");

    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % items.length;
      highlightItem(items);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
      highlightItem(items);
    } else if (e.key === "Enter") {
      if (activeIndex >= 0 && activeIndex < items.length) {
        e.preventDefault();
        selectNomor(currentMatches[activeIndex]);
      }
    } else if (e.key === "Escape") {
      suggestionsList.hidden = true;
    }
  };

  const highlightItem = (items) => {
    items.forEach((item, idx) => {
      const active = idx === activeIndex;
      item.classList.toggle("active", active);
      if (active) {
        item.setAttribute("aria-selected", "true");
        // Ensure scroll into view
        item.scrollIntoView({ block: "nearest" });
      } else {
        item.removeAttribute("aria-selected");
      }
    });
  };

  let debounceTimer;
  let analyticsTimer;

  input.addEventListener("input", () => {
    const rawVal = input.value;
    const val = rawVal.trim().toLowerCase();

    // Toggle clear button
    clearBtn.hidden = !(val || selectedNomors.size > 0);

    // Show suggestions only for non-empty input
    if (!val) {
      suggestionsList.hidden = true;
      searchTerm = "";
      applyFilter();
      return;
    }

    // Filter index for prefix matches first, then general includes
    const filtered = nomorIndex.filter(item => {
      const lower = item.toLowerCase();
      return lower.includes(val) && !selectedNomors.has(item.toUpperCase());
    });

    // Sort: exact matches first, prefix matches next, then the rest
    filtered.sort((a, b) => {
      const aLower = a.toLowerCase();
      const bLower = b.toLowerCase();
      const aPrefix = aLower.startsWith(val);
      const bPrefix = bLower.startsWith(val);
      if (aPrefix && !bPrefix) return -1;
      if (!aPrefix && bPrefix) return 1;
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });

    renderSuggestions(filtered.slice(0, 8), val);

    // Update search query for free-text fallback
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      searchTerm = val;
      applyFilter();
    }, 200);

    clearTimeout(analyticsTimer);
    analyticsTimer = setTimeout(() => {
      if (val.length >= 2) {
        analytics.track('search_performed', {
          query_length: val.length
        });
      }
    }, 500);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" && !input.value && selectedNomors.size > 0) {
      // Remove last tag
      const arr = Array.from(selectedNomors);
      const last = arr[arr.length - 1];
      selectedNomors.delete(last);
      updatePillsUI();
      applyFilter();
      return;
    }
    handleArrowKeys(e);
  });

  // Close suggestions when clicking outside
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) {
      suggestionsList.hidden = true;
    }
  });

  clearBtn.addEventListener("click", () => {
    input.value = "";
    searchTerm = "";
    selectedNomors.clear();
    suggestionsList.hidden = true;
    clearBtn.hidden = true;
    updatePillsUI();
    input.focus();
    applyFilter();
  });
}

// ── MOBILE TOGGLE ────────────────────────────────────────────────────────
function initFilterToggle() {
  const btn = document.getElementById("filter-toggle-btn");
  const content = document.getElementById("filter-collapse-content");
  if (!btn || !content) return;

  const syncToggleState = (isExpanded) => {
    content.classList.toggle("expanded", isExpanded);
    btn.querySelector(".toggle-arrow").textContent = isExpanded ? "▴" : "▾";
    btn.setAttribute("aria-expanded", isExpanded ? "true" : "false");
  };

  syncToggleState(false);
  btn.addEventListener("click", () => {
    syncToggleState(!content.classList.contains("expanded"));
  });
}

// ── FILTER CHIPS ─────────────────────────────────────────────────────────
function buildFilterChips(rows) {
  const blokSet = new Set();
  rows.slice(1).forEach(row => {
    const val = cellDisplay(row[1]);
    if (val) blokSet.add(val);
  });
  const bloks = [...blokSet].sort();

  const allChip = document.createElement("button");
  allChip.className = "chip chip-all active";
  allChip.textContent = "Semua";
  allChip.dataset.blok = "";
  allChip.setAttribute("aria-pressed", "true");
  chipGroupEl.appendChild(allChip);

  bloks.forEach(blok => {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.textContent = blok;
    chip.dataset.blok = blok;
    chip.setAttribute("aria-pressed", "false");
    chipGroupEl.appendChild(chip);
  });

  filterBarEl.classList.add("visible");
  initSearch();
  initFilterToggle();

  chipGroupEl.addEventListener("click", e => {
    const chip = e.target.closest(".chip");
    if (!chip) return;

    if (chip.classList.contains("chip-all")) {
      chipGroupEl.querySelectorAll(".chip").forEach(c => {
        c.classList.remove("active");
        c.setAttribute("aria-pressed", "false");
      });
      chip.classList.add("active");
      chip.setAttribute("aria-pressed", "true");
    } else {
      chipGroupEl.querySelector(".chip-all").classList.remove("active");
      chipGroupEl.querySelector(".chip-all").setAttribute("aria-pressed", "false");
      chip.classList.toggle("active");
      chip.setAttribute("aria-pressed", chip.classList.contains("active") ? "true" : "false");

      if (chip.classList.contains("active")) {
        analytics.track('filter_selected', {
          filter_type: 'block',
          value: chip.dataset.blok
        });
      }

      const anyActive = [...chipGroupEl.querySelectorAll(".chip:not(.chip-all)")]
        .some(c => c.classList.contains("active"));
      if (!anyActive) {
        const all = chipGroupEl.querySelector(".chip-all");
        all.classList.add("active");
        all.setAttribute("aria-pressed", "true");
      }
    }
    applyFilter();
  });
}

// ── PAYMENT CHIPS ────────────────────────────────────────────────────────
function buildLunasChips(yearGroups) {
  if (!paymentChipGroupEl) return;
  paymentChipGroupEl.innerHTML = "";

  const years = Object.keys(yearGroups).sort();
  availableYearKeys = years;

  const headerRow = document.createElement("div");
  // headerRow.className = "payment-status-row payment-header-row";

  const headerStack = document.createElement("div");
  headerStack.className = "payment-header-stack";

  const headerLabel = document.createElement("div");
  headerLabel.className = "payment-status-label payment-header-label";
  headerLabel.textContent = "Status Bayar";
  headerStack.appendChild(headerLabel);
  // headerRow.appendChild(headerStack);
  paymentChipGroupEl.appendChild(headerRow);

  const buildStatusRow = (statusKey, rowLabel) => {
    const row = document.createElement("div");
    row.className = "payment-status-row";

    const label = document.createElement("div");
    label.className = "payment-status-label";
    label.textContent = rowLabel;
    row.appendChild(label);

    const chips = document.createElement("div");
    chips.className = "payment-year-chips";

    years.forEach(year => {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.textContent = year;
      chip.dataset.year = year;
      chip.dataset.mode = statusKey;
      chip.setAttribute("aria-pressed", "false");
      chips.appendChild(chip);
    });

    row.appendChild(chips);
    return row;
  };

  paymentChipGroupEl.appendChild(buildStatusRow("lunas", "Lunas"));
  paymentChipGroupEl.appendChild(buildStatusRow("belum-lunas", "Belum Lunas"));

  paymentChipGroupEl.addEventListener("click", e => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    chip.classList.toggle("active");
    chip.setAttribute("aria-pressed", chip.classList.contains("active") ? "true" : "false");
    applyFilter();
  });
}

// ── YEAR FILTER CHIPS ────────────────────────────────────────────────────
function buildYearFilterChips() {
  const yearFilterGroupEl = document.getElementById("year-filter-chips");
  if (!yearFilterGroupEl) return;
  yearFilterGroupEl.innerHTML = "";

  const currentYearFull = new Date().getFullYear();
  const currentYearKey = String(currentYearFull).slice(-2);
  const hasCurrentYear = availableYearKeys.includes(currentYearKey);

  const allChip = document.createElement("button");
  allChip.className = "chip chip-all" + (hasCurrentYear ? "" : " active");
  allChip.textContent = "Semua";
  allChip.dataset.year = "all";
  allChip.setAttribute("aria-pressed", hasCurrentYear ? "false" : "true");
  yearFilterGroupEl.appendChild(allChip);

  availableYearKeys.forEach(year => {
    const isCurrent = hasCurrentYear && (year === currentYearKey);
    const chip = document.createElement("button");
    chip.className = "chip" + (isCurrent ? " active" : "");
    chip.textContent = "20" + year;
    chip.dataset.year = year;
    chip.setAttribute("aria-pressed", isCurrent ? "true" : "false");
    yearFilterGroupEl.appendChild(chip);
  });

  yearFilterGroupEl.addEventListener("click", e => {
    const chip = e.target.closest(".chip");
    if (!chip) return;

    if (chip.classList.contains("chip-all")) {
      yearFilterGroupEl.querySelectorAll(".chip").forEach(c => {
        c.classList.remove("active");
        c.setAttribute("aria-pressed", "false");
      });
      chip.classList.add("active");
      chip.setAttribute("aria-pressed", "true");
    } else {
      yearFilterGroupEl.querySelector(".chip-all").classList.remove("active");
      yearFilterGroupEl.querySelector(".chip-all").setAttribute("aria-pressed", "false");
      chip.classList.toggle("active");
      chip.setAttribute("aria-pressed", chip.classList.contains("active") ? "true" : "false");

      const anyActive = [...yearFilterGroupEl.querySelectorAll(".chip:not(.chip-all)")]
        .some(c => c.classList.contains("active"));
      if (!anyActive) {
        const all = yearFilterGroupEl.querySelector(".chip-all");
        all.classList.add("active");
        all.setAttribute("aria-pressed", "true");
      }
    }

    updateColumnVisibility();
    applyStickyColumns();
  });
}

// ── RENDER ───────────────────────────────────────────────────────────────
function render(rows) {
  if (!rows || rows.length === 0) {
    showError("Data tidak tersedia.");
    return;
  }

  const headers = rows[0];
  const hasNamaCol = headers.some(cell => typeof cell === 'string' && cell.trim() === 'Nama');
  const identityColCount = hasNamaCol ? 3 : 2;
  CONFIG.STICKY_COLUMNS = hasNamaCol ? [1, 2, 3] : [1, 2];

  // Extract all unique house numbers (Nomor) from rows
  const nomorSet = new Set();
  rows.slice(1).forEach(row => {
    const val = cellDisplay(row[identityColCount]);
    if (val) nomorSet.add(val.toUpperCase());
  });
  nomorIndex = Array.from(nomorSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  yearGroups = {};
  headers.forEach((text, i) => {
    if (i <= identityColCount) return;
    const match = text.match(/[- /](\d{2,4})$/);
    if (match) {
      const year = match[1];
      const yearKey = year.length === 4 ? year.slice(-2) : year;
      if (!yearGroups[yearKey]) yearGroups[yearKey] = [];
      yearGroups[yearKey].push(i);
    }
  });

  const theadRow = document.createElement("tr");
  headers.forEach((text, i) => {
    if (i === 0) return;
    const th = document.createElement("th");
    th.textContent = text;
    th.dataset.col = i;
    if (text && text.trim() === "Nama") {
      th.classList.add("col-nama");
    }
    theadRow.appendChild(th);
  });

  // Inject ◀/▶ toggle button in the Nomor <th> to collapse identity columns
  const nomorTh = theadRow.querySelector(`[data-col="${identityColCount}"]`);
  if (nomorTh && hasNamaCol) {
    nomorTh.classList.add("has-toggle");
    toggleBtn = document.createElement("button");
    toggleBtn.className = "col-toggle-btn";
    toggleBtn.setAttribute("aria-label", "Toggle info columns");
    toggleBtn.textContent = isCollapsed ? "▶" : "◀";
    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isCollapsed) {
        expandPanel();
      } else {
        collapsePanel();
      }
    });
    nomorTh.appendChild(toggleBtn);
  }

  theadEl.appendChild(theadRow);

  summaryKeys = Object.keys(yearGroups).sort().map(yearKey => ({
    key: `s${yearKey}`,
    label: `'${yearKey}`,
    yearKey,
    full: parseInt(yearKey.length === 2 ? `20${yearKey}` : yearKey, 10)
  }));

  const nomorThInDom = theadEl.querySelector(`[data-col="${identityColCount}"]`);
  if (nomorThInDom) {
    [...summaryKeys].reverse().forEach(({ key, label }) => {
      const th = document.createElement("th");
      th.textContent = label;
      th.dataset.col = key;
      th.classList.add("sum-th", "sum-col");
      nomorThInDom.insertAdjacentElement("afterend", th);
    });
  }

  const dataRows = rows.slice(1);
  const fragment = document.createDocumentFragment();

  dataRows.forEach(row => {
    const tr = document.createElement("tr");
    const normalizedRow = [...row];
    while (normalizedRow.length < headers.length) {
      normalizedRow.push("");
    }

    const cellsByCol = {};
    normalizedRow.forEach((val, i) => {
      if (i === 0) return;
      const td = document.createElement("td");
      td.textContent = cellDisplay(val);
      td.dataset.col = i;
      if (headers[i] && headers[i].trim() === "Nama") {
        td.classList.add("col-nama");
      }
      tr.appendChild(td);
      cellsByCol[i] = td;
    });

    for (const [year, colIndices] of Object.entries(yearGroups)) {
      if (colIndices.length === 12) {
        const isComplete = colIndices.every(idx => {
          const val = row[idx];
          return val && val.trim() !== "";
        });

        if (isComplete) {
          const yearNum = parseInt(year);
          const isOdd = (yearNum % 2) !== 0;
          const className = isOdd ? "status-full-odd" : "status-full-even";

          colIndices.forEach(idx => {
            if (cellsByCol[idx]) cellsByCol[idx].classList.add(className);
          });
        }
      }
    }
    const nomorTd = cellsByCol[identityColCount];
    if (nomorTd) {
      [...summaryKeys].reverse().forEach(({ key, yearKey, full }) => {
        const colIndices = yearGroups[yearKey] || [];
        const paidCount = colIndices.filter(idx => {
          const val = row[idx];
          return val && val.trim() !== "";
        }).length;

        const td = document.createElement("td");
        td.dataset.col = key;
        td.classList.add("sum-col");

        if (colIndices.length === 0) {
          td.textContent = "—";
          td.style.color = "var(--text-muted)";
        } else {
          td.textContent = paidCount + "/12";
          if (paidCount === 12) {
            const isOdd = full % 2 !== 0;
            td.classList.add(isOdd ? "status-full-odd" : "status-full-even");
          } else if (paidCount > 0) {
            td.classList.add("sum-partial");
          }
        }
        nomorTd.insertAdjacentElement("afterend", td);
      });
    }
    fragment.appendChild(tr);
  });
  tbodyEl.appendChild(fragment);

  containerEl.classList.add("visible");
  rowCountEl.textContent = (rows.length - 1) + " warga";
  buildFilterChips(rows);
  buildLunasChips(yearGroups);
  buildYearFilterChips();

  requestAnimationFrame(() => {
    updateColumnVisibility();
    applyStickyColumns();
    if (window.innerWidth < 640 && hasNamaCol) collapsePanel();
  });
}

// ── FETCH & PARSE ────────────────────────────────────────────────────────
function displaySyncTime(isoString) {
  if (!syncTimeEl) return;
  if (!isoString) {
    syncTimeEl.textContent = "";
    return;
  }
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) {
      syncTimeEl.textContent = "";
      return;
    }
    const day = String(d.getDate()).padStart(2, '0');
    const months = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agt", "Sep", "Okt", "Nov", "Des"];
    const month = months[d.getMonth()];
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    syncTimeEl.textContent = `Synced at: ${day} ${month} ${year} ${hours}:${minutes}`;
  } catch (e) {
    console.error("[rekap] Error formatting sync time:", e);
    syncTimeEl.textContent = "";
  }
}

async function loadData() {
  showLoading();
  try {
    const res = await fetch("/api/rekap");
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData?.error || "Gagal memuat data (HTTP " + res.status + ")");
    }

    // Extract last update timestamp from headers
    const syncTimeHeader = res.headers.get("X-Cache-Updated-At");
    displaySyncTime(syncTimeHeader);

    const data = await res.json();
    hideLoading();

    if (!data.values || data.values.length === 0) {
      showError("Data tidak tersedia atau sheet kosong.");
      return;
    }
    render(data.values);
    analytics.track('page_viewed', { page: 'rekap_viewer' });
  } catch (err) {
    hideLoading();
    showError(err.message);
    console.error("[rekap] Load error:", err);
  }
}

// ── USER PROFILE ─────────────────────────────────────────────────────────
async function fetchUser() {
  try {
    const res = await fetch("/api/me");
    if (res.ok) {
      const user = await res.json();

      // Configure and show portal button
      const portalUrl = (window.location.hostname === 'rekap.localtest.me' || window.location.hostname === 'rekap.lvh.me' || window.location.hostname === 'localhost')
        ? 'http://portal.localtest.me:5173'
        : window.location.hostname.endsWith('.sakura3.my.id')
          ? 'https://portal.sakura3.my.id'
          : window.location.hostname.endsWith('.sakura3.id')
            ? 'https://portal.sakura3.id'
            : 'https://portal.veryresto.com';
      const portalBtn = document.getElementById("portal-btn");
      if (portalBtn) {
        portalBtn.href = portalUrl;
        portalBtn.style.display = "flex";
      }

      const initials = (user.name ? user.name.substring(0, 2) : user.email.substring(0, 2)).toUpperCase();
      document.getElementById("user-initials").textContent = initials;
      document.getElementById("user-initials-large").textContent = initials;

      document.getElementById("user-name").textContent = user.name || user.email;
      document.getElementById("user-email").textContent = user.email;

      if (user.avatar_url) {
        document.getElementById("user-avatar-btn").innerHTML = `<img src="${user.avatar_url}" alt="Avatar" />`;
        document.getElementById("user-avatar-large").innerHTML = `<img src="${user.avatar_url}" alt="Avatar" />`;
      }

      const tagsContainer = document.getElementById("user-tags");
      const headerTagsContainer = document.getElementById("header-tags");

      if (tagsContainer) {
        tagsContainer.innerHTML = "";
      }
      if (headerTagsContainer) {
        headerTagsContainer.innerHTML = "";
      }

      // Generate resident/non-resident tag
      if (user.profile && tagsContainer) {
        const type = user.profile.participant_type;
        const subtype = user.profile.resident_subtype;
        const affiliation = user.profile.requested_affiliation;

        let profileLabel = "";
        let profileClass = "";

        if (type === "resident") {
          profileClass = "tag-resident";
          if (subtype === "owner") {
            profileLabel = "Warga (Pemilik)";
          } else if (subtype === "renter") {
            profileLabel = "Warga (Penyewa)";
          } else {
            profileLabel = "Warga";
          }
        } else if (type === "non_resident") {
          profileClass = "tag-nonresident";
          if (affiliation === "security") {
            profileLabel = "Non-Warga (Keamanan)";
          } else if (affiliation === "secretariat") {
            profileLabel = "Non-Warga (Sekretariat)";
          } else if (affiliation === "vendor") {
            profileLabel = "Non-Warga (Mitra)";
          } else if (affiliation === "assistant") {
            profileLabel = "Non-Warga (Asisten)";
          } else {
            profileLabel = "Non-Warga";
          }
        }

        if (profileLabel) {
          const badge = document.createElement("span");
          badge.className = `tag-badge ${profileClass}`;
          badge.textContent = profileLabel;
          tagsContainer.appendChild(badge);
        }
      }

      // Generate global roles tags
      if (user.roles && Array.isArray(user.roles)) {
        user.roles.forEach(role => {
          let roleLabel = "";
          let roleClass = "";

          if (role === "admin") {
            roleLabel = "Global Admin";
            roleClass = "tag-admin";
          } else if (role === "resident_verifier") {
            roleLabel = "Verifier";
            roleClass = "tag-verifier";
          } else if (role === "platform_moderator") {
            roleLabel = "Moderator";
            roleClass = "tag-moderator";
          }

          if (roleLabel) {
            // Dropdown tag
            if (tagsContainer) {
              const badge = document.createElement("span");
              badge.className = `tag-badge ${roleClass}`;
              badge.textContent = roleLabel;
              tagsContainer.appendChild(badge);
            }

            // Header tag
            if (headerTagsContainer) {
              const badge = document.createElement("span");
              badge.className = `tag-badge ${roleClass}`;
              badge.textContent = roleLabel;
              headerTagsContainer.appendChild(badge);
            }
          }
        });
      }
    }
  } catch (err) {
    console.error("[rekap] User profile error:", err);
  }
}

// ── DROPDOWN & LOGOUT EVENTS ──────────────────────────────────────────────
function initUserDropdown() {
  const btn = document.getElementById("user-menu-btn");
  const dropdown = document.getElementById("user-dropdown");
  const signoutBtn = document.getElementById("sign-out-btn");

  if (!btn || !dropdown) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isExpanded = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", !isExpanded);
    dropdown.classList.toggle("show");
  });

  document.addEventListener("click", (e) => {
    if (!dropdown.contains(e.target) && e.target !== btn) {
      dropdown.classList.remove("show");
      btn.setAttribute("aria-expanded", "false");
    }
  });

  signoutBtn.addEventListener("click", async () => {
    try {
      // Call the backend endpoint to log out globally from Supabase and clear the cookie
      await fetch('/api/logout', { method: 'POST' });
    } catch (e) {
      console.error('Logout request failed:', e);
    }

    // Determine the portal URL based on the environment
    const isLocal = window.location.hostname.endsWith('.localtest.me') ||
      window.location.hostname.endsWith('.lvh.me') ||
      window.location.hostname === 'localhost';

    const portalUrl = isLocal
      ? 'http://portal.localtest.me:5173'
      : window.location.hostname.endsWith('.sakura3.my.id')
        ? 'https://portal.sakura3.my.id'
        : window.location.hostname.endsWith('.sakura3.id')
          ? 'https://portal.sakura3.id'
          : 'https://portal.veryresto.com';

    window.location.href = portalUrl;
  });
}

async function fetchBuildInfo() {
  try {
    const res = await fetch("/generated/build-info.json");
    if (res.ok) {
      const buildInfo = await res.json();
      const versionEl = document.getElementById("app-version");
      if (versionEl && buildInfo.version) {
        versionEl.textContent = `v${buildInfo.version}`;
        versionEl.title = `Branch: ${buildInfo.gitBranch}\nCommit: ${buildInfo.gitCommitSha}\nBuilt: ${new Date(buildInfo.buildTimestamp).toLocaleString()}\nEnv: ${buildInfo.environment}`;
        versionEl.style.display = "inline";
      }
    }
  } catch (err) {
    console.error("[rekap] Build info error:", err);
  }
}

fetchUser();
initUserDropdown();
loadData();
fetchBuildInfo();
