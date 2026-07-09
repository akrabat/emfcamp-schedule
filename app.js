/* EMF 2026 Schedule
 *
 * The guiding principle: every filter is stored in the URL query string, so any
 * view can be bookmarked or shared as a link. Loading a URL restores its filters.
 */

const YEAR = 2026;
const DATA_URL = `https://www.emfcamp.org/schedule/${YEAR}.json`;
const CACHE_KEY = `emf-schedule-${YEAR}`;
const FAVS_KEY = `emf-favs-${YEAR}`;
const TOKEN_KEY = `emf-token-${YEAR}`;
const SYNCED_KEY = `emf-synced-${YEAR}`;
const SAVED_KEY = `emf-saved-${YEAR}`;
const LAST_KEY = `emf-last-${YEAR}`;
const THEME_KEY = 'emf-theme';

// Same-origin relay to emfcamp.org's favourites feed (see nginx.conf). The feed
// itself has no CORS headers, so the browser cannot call it directly.
const FAVS_FEED_URL = '/api/favourites.json';

const TYPE_LABELS = {
  talk: 'Talk',
  workshop: 'Workshop',
  familyworkshop: 'Family workshop',
  performance: 'Performance',
  music: 'Music',
  djset: 'DJ set',
  meetup: 'Meetup',
  film: 'Film',
};

const WEEKDAY_CODE = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* ---------- State ---------- */
let RAW = [];        // raw events from the API
let ITEMS = [];      // flattened per-occurrence rows (one card each)
let DAYS = [];       // [{date, code, label, long, count}]
let TYPES = [];      // [{type, label, count}]
let VENUES = [];     // [{name, count}]

const favs = loadFavs();
let favsUndo = null; // snapshot of favourites before the last import, for one-click undo
let token = loadToken(); // the user's EMF favourites token, kept only in this browser
let syncedAt = loadSyncedAt(); // ISO time the favourites were last adopted from EMF
let savedFilters = loadSaved(); // user's named filter presets: [{ id, name, query }]

// Built-in filters, always present and not deletable. They depend on "today",
// so they are computed at apply time (see applyDefaultFilter) rather than stored.
// type is one event type or an array of them; venue: 'stages' = venues starting
// with "Stage"; 'all' = no venue restriction.
const DEFAULT_FILTERS = [
  { id: 'def-stage-talks', name: 'Stage talks today', type: 'talk', venue: 'stages' },
  { id: 'def-talks', name: 'All talks today', type: 'talk', venue: 'all' },
  { id: 'def-films', name: 'Films today', type: 'film', venue: 'all' },
  { id: 'def-music', name: 'Music today', type: ['music', 'djset'], venue: 'all' },
];

const filters = {
  q: '',
  days: new Set(),
  types: new Set(),
  venues: new Set(),
  family: false,
  favsOnly: false,
};

/* ---------- DOM ---------- */
const $ = (sel) => document.querySelector(sel);
const el = {
  schedule: $('#schedule'),
  count: $('#count'),
  status: $('#status'),
  search: $('#search'),
  savedList: $('#saved-list'),
  defaultList: $('#default-list'),
  savedManage: $('#saved-manage'),
  showAllBtn: $('#show-all-btn'),
  saveFilterPanelBtn: $('#save-filter-panel-btn'),
  favsToggleBtn: $('#favs-toggle-btn'),
  family: $('#family-toggle'),
  favs: $('#favs-toggle'),
  importText: $('#import-text'),
  importBtn: $('#import-btn'),
  importStatus: $('#import-status'),
  tokenInput: $('#token-input'),
  syncBtn: $('#sync-btn'),
  topSyncBtn: $('#top-sync-btn'),
  forgetBtn: $('#forget-token'),
  syncInfo: $('#sync-info'),
  days: $('[data-group="days"]'),
  types: $('[data-group="types"]'),
  venues: $('[data-group="venues"]'),
  filters: $('#filters'),
  syncPanel: $('#sync-panel'),
  syncOpen: $('#sync-open'),
  syncClose: $('#sync-close'),
};

/* ---------- Boot ---------- */
initTheme();
readFiltersFromURL(true);
bindStaticEvents();
initImport();
renderSaved();
load();

async function load() {
  const cached = loadCache();
  if (cached) {
    ingest(cached.data);
    render();
  }
  try {
    const fresh = await fetchData();
    saveCache(fresh);
    ingest(fresh);
    hideStatus();
    render();
  } catch (err) {
    if (cached) {
      showStatus(`Could not reach emfcamp.org, showing saved data from ${formatWhen(cached.savedAt)}.`, false);
    } else {
      showStatus(`Could not load the schedule: ${err.message}. Check your connection and press “⟳ Data”.`, true);
      el.count.textContent = '';
    }
  }
}

async function fetchData() {
  const res = await fetch(DATA_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('unexpected data format');
  return data;
}

/* ---------- Ingest & derive facets ---------- */
function ingest(data) {
  RAW = data;
  ITEMS = [];
  for (const ev of data) {
    for (const occ of ev.occurrences || []) {
      const date = (occ.start_date || '').slice(0, 10);
      ITEMS.push({
        ev,
        occ,
        date,
        // Weekday code drives the day filter; an undated occurrence gets '' so a
        // day filter never matches it (it can't be placed on a weekday).
        code: date ? WEEKDAY_CODE[weekday(date)] : '',
        sort: occ.start_date || '',
        venue: occ.venue || '',
      });
    }
  }
  ITEMS.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : a.venue.localeCompare(b.venue)));

  DAYS = facetDays();
  TYPES = facetTypes();
  VENUES = facetVenues();
  buildFilterPanel();
}

function facetDays() {
  const map = new Map();
  for (const it of ITEMS) {
    if (!it.date) continue;
    if (!map.has(it.date)) {
      const wd = weekday(it.date);
      const dayNum = Number(it.date.slice(8, 10));
      map.set(it.date, {
        date: it.date,
        code: WEEKDAY_CODE[wd],
        label: `${WEEKDAY_LONG[wd].slice(0, 3)} ${dayNum}`,
        long: `${WEEKDAY_LONG[wd]} ${dayNum} July`,
        count: 0,
      });
    }
    map.get(it.date).count++;
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function facetTypes() {
  const map = new Map();
  for (const it of ITEMS) {
    const t = it.ev.type;
    map.set(t, (map.get(t) || 0) + 1);
  }
  return [...map.entries()]
    .map(([type, count]) => ({ type, label: TYPE_LABELS[type] || type, count }))
    .sort((a, b) => b.count - a.count);
}

function facetVenues() {
  const map = new Map();
  for (const it of ITEMS) map.set(it.venue, (map.get(it.venue) || 0) + 1);
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => venueRank(a.name) - venueRank(b.name) || a.name.localeCompare(b.name));
}

// Stages first (A, B, C…), everything else alphabetical after.
function venueRank(name) {
  return /^stage/i.test(name) ? 0 : 1;
}

/* ---------- Filter panel ---------- */
function buildFilterPanel() {
  el.days.innerHTML = DAYS.map((d) =>
    checkRow('day', d.code, `${d.label}`, d.count, filters.days.has(d.code))
  ).join('');

  el.types.innerHTML = TYPES.map((t) =>
    checkRow('type', t.type, t.label, t.count, filters.types.has(t.type), `var(--t-${t.type})`)
  ).join('');

  el.venues.innerHTML = VENUES.map((v) =>
    checkRow('venue', v.name, v.name, v.count, filters.venues.has(v.name))
  ).join('');

  el.search.value = filters.q;
  el.family.checked = filters.family;
  syncFavsControls();
  syncFacetSummaries();
}

// Keep both favourites-only controls (the pane checkbox and the results-bar
// toggle) reflecting filters.favsOnly.
function syncFavsControls() {
  el.favs.checked = filters.favsOnly;
  el.favsToggleBtn.classList.toggle('on', filters.favsOnly);
  el.favsToggleBtn.setAttribute('aria-pressed', String(filters.favsOnly));
}

function setFavsOnly(on) {
  filters.favsOnly = on;
  syncFavsControls();
  render();
}

function checkRow(group, value, label, count, checked, dot) {
  const dotHtml = dot ? `<span class="dot" style="background:${dot}"></span>` : '';
  return `<label class="check">
    <input type="checkbox" data-group="${group}" value="${esc(value)}" ${checked ? 'checked' : ''}>
    ${dotHtml}<span class="name">${esc(label)}</span><span class="num">${count}</span>
  </label>`;
}

function syncFacetSummaries() {
  setFacetCount('day', filters.days.size);
  setFacetCount('type', filters.types.size);
  setFacetCount('venue', filters.venues.size);
}
function setFacetCount(facet, n) {
  const node = document.querySelector(`.facet-count[data-facet="${facet}"]`);
  if (node) node.textContent = n ? `· ${n} selected` : '';
}

// Facet shortcuts: set a facet's selection to exactly the matching values (or
// all / none), unchecking everything else, then reflect it in the checkboxes.
// Day also supports Today / Tomorrow (no-op if that date isn't a schedule day);
// venue supports Stages (name starts with "Stage") and Workshops (name contains
// "Workshop").
function applyFacetPreset(facet, preset) {
  const groupEl = { day: el.days, type: el.types, venue: el.venues }[facet];
  if (!groupEl) return;

  let values;
  switch (preset) {
    case 'none': values = []; break;
    case 'today':
    case 'tomorrow': {
      const day = DAYS.find((d) => d.date === localDateStr(preset === 'today' ? 0 : 1));
      if (!day) return; // today/tomorrow isn't one of the event days: do nothing
      values = [day.code];
      break;
    }
    case 'stages': values = VENUES.filter((v) => /^stage/i.test(v.name)).map((v) => v.name); break;
    case 'workshops': values = VENUES.filter((v) => /workshop/i.test(v.name)).map((v) => v.name); break;
    default: return;
  }

  const set = new Set(values);
  filters[{ day: 'days', type: 'types', venue: 'venues' }[facet]] = set;
  for (const cb of groupEl.querySelectorAll('input[type="checkbox"]')) {
    cb.checked = set.has(cb.value);
  }
  syncFacetSummaries();
  render();
}

/* ---------- Filtering ---------- */
function matches(it) {
  const ev = it.ev;
  if (filters.days.size && !filters.days.has(it.code)) return false;
  if (filters.types.size && !filters.types.has(ev.type)) return false;
  if (filters.venues.size && !filters.venues.has(it.venue)) return false;
  if (filters.family && !ev.family_friendly) return false;
  if (filters.favsOnly && !favs.has(ev.id)) return false;
  if (filters.q) {
    const hay = [ev.title, ev.names, ev.short_description, ev.description, it.venue, TYPE_LABELS[ev.type] || ev.type]
      .join(' ')
      .toLowerCase();
    const terms = filters.q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.every((t) => hay.includes(t))) return false;
  }
  return true;
}

/* ---------- Render ---------- */
function render() {
  syncURL();
  highlightActiveFilters();
  const visible = ITEMS.filter(matches);
  renderCount(visible.length);

  if (!visible.length) {
    el.schedule.innerHTML = `<div class="empty">
      <h3>No events match these filters</h3>
      <p>Try removing a filter or clearing the search box.</p>
    </div>`;
    return;
  }

  const byDay = new Map();
  for (const it of visible) {
    if (!byDay.has(it.date)) byDay.set(it.date, []);
    byDay.get(it.date).push(it);
  }

  let html = '';
  for (const day of DAYS) {
    const items = byDay.get(day.date);
    if (!items) continue;
    html += `<section class="day-group">
      <h2 class="day-head">${esc(day.long)} <span class="day-n">${items.length} event${items.length === 1 ? '' : 's'}</span></h2>
      ${items.map(cardHtml).join('')}
    </section>`;
  }

  // Occurrences with no parseable date can't be placed on a day; render them in
  // a trailing group so the cards on screen always match the counted total.
  const undated = byDay.get('');
  if (undated && undated.length) {
    html += `<section class="day-group">
      <h2 class="day-head">Date to be confirmed <span class="day-n">${undated.length} event${undated.length === 1 ? '' : 's'}</span></h2>
      ${undated.map(cardHtml).join('')}
    </section>`;
  }

  el.schedule.innerHTML = html;
}

function renderCount(n) {
  const total = ITEMS.length;
  const active = filtersActive();
  el.count.innerHTML = active
    ? `<strong>${n}</strong> of ${total} events`
    : `<strong>${total}</strong> events`;
}

function cardHtml(it) {
  const ev = it.ev;
  const occ = it.occ;
  const color = `var(--t-${ev.type})`;
  const isFav = favs.has(ev.id);
  const locked = syncLocked();
  const dur = duration(occ.start_time, occ.end_time);

  const speaker = ev.names
    ? `<span class="speaker">${esc(ev.names)}${ev.pronouns ? ` <span class="pronouns">(${esc(ev.pronouns)})</span>` : ''}</span>`
    : '';

  const venue = occ.map_link
    ? `<a class="venue-link" href="${esc(occ.map_link)}" target="_blank" rel="noopener">📍 ${esc(it.venue)}</a>`
    : `<span class="venue-link">📍 ${esc(it.venue)}</span>`;

  const desc = ev.short_description || truncate(ev.description, 180);

  const tags = [];
  if (ev.family_friendly) tags.push(tag('👨‍👧 Family friendly'));
  if (occ.uses_lottery) tags.push(tag('🎟 Lottery', true));
  if (ev.drop_in) tags.push(tag('Drop-in'));
  if (ev.cost && !/^(free|nil|none|no cost|0|£0|-+)$/i.test(ev.cost.trim())) tags.push(tag(`💷 ${esc(ev.cost)}`));
  if (ev.age_range && ev.age_range.trim() && !/^(all|all ages|any age)$/i.test(ev.age_range.trim())) tags.push(tag(`Ages ${esc(ev.age_range)}`));

  return `<article class="card" style="--type-color:${color}" data-start="${esc(it.sort)}">
    <div class="card-time">
      <div class="start">${esc(occ.start_time || '')}</div>
      <div class="end">→ ${esc(occ.end_time || '')}</div>
      ${dur ? `<div class="dur">${dur}</div>` : ''}
    </div>
    <div class="card-body">
      <div class="card-top">
        <h3 class="card-title"><a href="${esc(ev.link)}" target="_blank" rel="noopener">${esc(ev.title)}</a></h3>
        <button class="fav-btn ${isFav ? 'on' : ''}${locked ? ' locked' : ''}" data-fav="${ev.id}" type="button"
          ${locked ? 'disabled' : ''}
          title="${locked ? 'Synced from your EMF account; favourite on emfcamp.org, then sync' : (isFav ? 'Remove favourite' : 'Add favourite')}"
          aria-pressed="${isFav}">★</button>
      </div>
      <div class="card-meta">
        <span class="badge" style="--type-color:${color}">${esc(TYPE_LABELS[ev.type] || ev.type)}</span>
        ${speaker}
        ${venue}
      </div>
      ${desc ? `<p class="card-desc">${esc(desc)}</p>` : ''}
      ${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}
    </div>
  </article>`;
}

function tag(text, warn) {
  return `<span class="tag${warn ? ' warn' : ''}">${text}</span>`;
}

/* ---------- URL <-> filters ---------- */
// On a bare visit to "/", restore the last filter this browser used so a return
// visit lands where you left off. A shared or bookmarked link's own query always
// wins, and back/forward navigation (restoreLast off) is honoured verbatim.
function readFiltersFromURL(restoreLast = false) {
  const qs = location.search.replace(/^\?/, '');
  applyFilterQuery(qs || (restoreLast ? loadLastFilter() : ''));
}

// Set the live filters from a query string (with or without a leading '?').
function applyFilterQuery(qs) {
  Object.assign(filters, parseQuery(qs));
}

// Parse a query string into a fresh filter-state object without touching the
// live filters (used to compare saved presets against the current state). We
// read RAW (still percent-encoded) params rather than using URLSearchParams, so
// a comma-joined list can be split on its literal separator commas BEFORE each
// value is decoded: a comma inside a value is encoded as %2C (see join) and so
// survives the split intact.
function parseQuery(qs) {
  const p = rawParams(qs);
  return {
    q: decodeParam(p.get('q')),
    days: splitParam(p.get('day')),
    types: splitParam(p.get('type')),
    venues: splitParam(p.get('venue')),
    family: p.get('family') === '1',
    favsOnly: p.get('fav') === '1',
  };
}

// Raw query params with values left percent-encoded; first occurrence wins, as
// URLSearchParams.get would. Accepts a query string with or without a '?'.
function rawParams(qs) {
  const map = new Map();
  for (const pair of (qs || '').replace(/^\?/, '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const val = eq === -1 ? '' : pair.slice(eq + 1);
    if (!map.has(key)) map.set(key, val);
  }
  return map;
}

// Percent-decode one raw value ('+' means space in a query string), tolerating
// a malformed escape rather than throwing.
function decodeParam(v) {
  if (!v) return '';
  try { return decodeURIComponent(v.replace(/\+/g, ' ')); } catch { return v; }
}

function splitParam(v) {
  return new Set(v ? v.split(',').map((s) => decodeParam(s).trim()).filter(Boolean) : []);
}

// Build a compact, human-readable query string (no leading '?'). Commas are kept
// literal; each value is percent-encoded so spaces and symbols round-trip.
function serializeFilters() {
  const parts = [];
  if (filters.q) parts.push('q=' + encodeURIComponent(filters.q));
  if (filters.days.size) parts.push('day=' + join(filters.days));
  if (filters.types.size) parts.push('type=' + join(filters.types));
  if (filters.venues.size) parts.push('venue=' + join(filters.venues));
  if (filters.family) parts.push('family=1');
  if (filters.favsOnly) parts.push('fav=1');
  return parts.join('&');
}

function syncURL() {
  const qs = serializeFilters();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  saveLastFilter(qs); // remember it, to restore on a later bare visit to "/"
}

function join(set) {
  return [...set].map(encodeURIComponent).join(',');
}

function filtersActive() {
  return !!(filters.q || filters.days.size || filters.types.size || filters.venues.size || filters.family || filters.favsOnly);
}

// Order-independent identity for a filter state: set values are sorted, so a
// filter built by clicking checkboxes in any order still matches its saved copy.
function filterKey(state) {
  const setPart = (name, set) => (set.size ? `${name}=${[...set].sort().join(',')}` : '');
  return [
    state.q ? 'q=' + state.q : '',
    setPart('day', state.days),
    setPart('type', state.types),
    setPart('venue', state.venues),
    state.family ? 'family=1' : '',
    state.favsOnly ? 'fav=1' : '',
  ].filter(Boolean).join('&');
}

/* ---------- Saved filters ---------- */
function saveCurrentFilter() {
  const name = (prompt('Name this filter:', defaultFilterName()) || '').trim();
  if (!name) return; // cancelled or left blank
  savedFilters.push({ id: newId(), name, query: serializeFilters() });
  saveSaved();
  renderSaved();
}

function applySavedFilter(id) {
  const def = DEFAULT_FILTERS.find((d) => d.id === id);
  if (def) { applyDefaultFilter(def); return; }
  const item = savedFilters.find((s) => s.id === id);
  if (!item) return;
  applyFilterQuery(item.query);
  buildFilterPanel();
  render();
}

// The live filter state a built-in default expands to: day = today's weekday,
// plus its type and venue rule. Pure, so it drives both applying the default and
// testing whether the current filters already match it.
function defaultFilterState(def) {
  return {
    q: '',
    days: new Set([WEEKDAY_CODE[weekday(localDateStr(0))]]),
    types: new Set([].concat(def.type)), // def.type may be one type or an array
    venues: def.venue === 'stages'
      ? new Set(VENUES.filter((v) => /^stage/i.test(v.name)).map((v) => v.name))
      : new Set(), // 'all' = no venue restriction
    family: false,
    favsOnly: false,
  };
}

function applyDefaultFilter(def) {
  Object.assign(filters, defaultFilterState(def));
  buildFilterPanel();
  render();
}

function renameSavedFilter(id) {
  const item = savedFilters.find((s) => s.id === id);
  if (!item) return;
  const name = (prompt('Rename filter:', item.name) || '').trim();
  if (!name) return;
  item.name = name;
  saveSaved();
  renderSaved();
}

function deleteSavedFilter(id) {
  const item = savedFilters.find((s) => s.id === id);
  if (!item) return;
  if (!confirm(`Delete saved filter “${item.name}”?`)) return;
  savedFilters = savedFilters.filter((s) => s.id !== id);
  saveSaved();
  renderSaved();
}

function renderSaved() {
  // Main-screen chips: user saved filters on their own row, built-in defaults
  // on a separate row below. Apply only, no management controls to mis-tap.
  const chip = (s) => `
    <li class="saved-item">
      <button class="saved-apply" data-id="${esc(s.id)}" title="Apply this filter">${esc(s.name)}</button>
    </li>`;
  el.savedList.hidden = savedFilters.length === 0;
  el.savedList.innerHTML = savedFilters.map(chip).join('');
  el.defaultList.innerHTML = DEFAULT_FILTERS.map(chip).join('');

  // Filter pane: rename and delete (delete asks for confirmation). The section
  // stays visible even with no saved filters so its "Save current filter"
  // button is always reachable.
  el.savedManage.innerHTML = savedFilters.map((s) => `
    <li class="saved-manage-item">
      <button class="saved-apply" data-id="${esc(s.id)}" title="Apply this filter">${esc(s.name)}</button>
      <button class="saved-rename" data-id="${esc(s.id)}" title="Rename" aria-label="Rename ${esc(s.name)}">✎</button>
      <button class="saved-del" data-id="${esc(s.id)}" title="Delete" aria-label="Delete ${esc(s.name)}">×</button>
    </li>`).join('');

  const countNode = document.querySelector('.facet-count[data-facet="saved"]');
  if (countNode) countNode.textContent = savedFilters.length ? `· ${savedFilters.length}` : '';

  highlightActiveFilters();
}

// Mark the saved/default chips whose criteria equal the current filters, so the
// preset in effect reads as selected in both the results bar and the pane. Runs
// on every render (state changes) and whenever the chips are rebuilt.
function highlightActiveFilters() {
  const cur = filterKey(filters);
  const active = new Set();
  for (const s of savedFilters) if (filterKey(parseQuery(s.query)) === cur) active.add(s.id);
  for (const d of DEFAULT_FILTERS) if (filterKey(defaultFilterState(d)) === cur) active.add(d.id);
  for (const btn of document.querySelectorAll('.saved-apply[data-id]')) {
    const on = active.has(btn.dataset.id);
    btn.classList.toggle('active', on);
    if (on) btn.setAttribute('aria-current', 'true');
    else btn.removeAttribute('aria-current');
  }
}

// A short, readable default name summarising the active filters, e.g.
// "“radio” · Talks · Sat" or "Stage A · Favourites". Facets that select
// everything are omitted (they don't narrow anything).
function defaultFilterName() {
  const parts = [];
  if (filters.q) parts.push(`“${filters.q}”`);
  if (filters.days.size && filters.days.size < DAYS.length) {
    parts.push(labelList([...filters.days].map(dayCodeLabel), 'days'));
  }
  if (filters.types.size && filters.types.size < TYPES.length) {
    parts.push(labelList([...filters.types].map((t) => TYPE_LABELS[t] || t), 'types'));
  }
  if (filters.venues.size && filters.venues.size < VENUES.length) {
    const names = [...filters.venues];
    if (names.length === 1) {
      parts.push(names[0]);
    } else {
      const word = commonWord(names);
      parts.push(word ? pluralize(capitalize(word)) : `${names.length} venues`);
    }
  }
  if (filters.favsOnly) parts.push('Favourites');
  if (filters.family) parts.push('Family');
  return truncate(parts.join(' · ') || 'All events', 40);
}

// Up to two items listed literally; more collapse to a count ("3 days").
function labelList(items, noun) {
  return items.length <= 2 ? items.join(', ') : `${items.length} ${noun}`;
}

// The most specific word (>= 3 letters, not a stop word) shared by every one of
// `names`, lower-cased; '' if there is none. Lets a venue selection be named
// "Stages" / "Workshops" instead of "4 venues".
const NAME_STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'of', 'on', 'in', 'at', 'to', 'by']);
function commonWord(names) {
  const wordSets = names.map((n) =>
    new Set((n.toLowerCase().match(/[a-z]+/g) || []).filter((w) => w.length >= 3 && !NAME_STOP_WORDS.has(w)))
  );
  if (!wordSets.length) return '';
  let common = [...wordSets[0]];
  for (const s of wordSets.slice(1)) common = common.filter((w) => s.has(w));
  common.sort((a, b) => b.length - a.length); // prefer the most specific (longest)
  return common[0] || '';
}

function capitalize(w) { return w ? w.charAt(0).toUpperCase() + w.slice(1) : w; }
function pluralize(w) { return /s$/i.test(w) ? w : w + 's'; }

function dayCodeLabel(code) {
  const i = WEEKDAY_CODE.indexOf(code);
  return i >= 0 ? WEEKDAY_LONG[i].slice(0, 3) : code;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ---------- Events ---------- */
function bindStaticEvents() {
  el.search.addEventListener('input', debounce(() => {
    filters.q = el.search.value.trim();
    render();
  }, 180));

  el.family.addEventListener('change', () => { filters.family = el.family.checked; render(); });
  el.favs.addEventListener('change', () => setFavsOnly(el.favs.checked));
  el.favsToggleBtn.addEventListener('click', () => setFavsOnly(!filters.favsOnly));

  // Facet checkboxes (delegated across all three groups).
  for (const group of [el.days, el.types, el.venues]) {
    group.addEventListener('change', (e) => {
      const cb = e.target.closest('input[type="checkbox"]');
      if (!cb) return;
      const set = filters[{ day: 'days', type: 'types', venue: 'venues' }[cb.dataset.group]];
      cb.checked ? set.add(cb.value) : set.delete(cb.value);
      syncFacetSummaries();
      render();
    });
  }

  // Facet shortcut presets (venue: Stages / Workshops / all / none; type: all / none).
  for (const bar of document.querySelectorAll('.facet-shortcuts')) {
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-preset]');
      if (btn) applyFacetPreset(bar.dataset.facet, btn.dataset.preset);
    });
  }

  // Favourite stars (delegated on the schedule).
  el.schedule.addEventListener('click', (e) => {
    const btn = e.target.closest('.fav-btn');
    if (!btn) return;
    if (syncLocked()) return; // favourites are managed by EMF sync; stars are read-only
    const id = Number(btn.dataset.fav);
    favs.has(id) ? favs.delete(id) : favs.add(id);
    saveFavs();
    // A manual change supersedes the last import: drop its undo snapshot, and
    // since the local favourites no longer mirror an adopted set, clear the
    // "Synced" indicator so it can't claim a mirror that no longer holds.
    favsUndo = null;
    el.importStatus.hidden = true;
    if (syncedAt) { syncedAt = ''; saveSyncedAt(''); updateSyncInfo(); }
    updateImportSummary();
    const on = favs.has(id);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('title', on ? 'Remove favourite' : 'Add favourite');
    if (filters.favsOnly && !on) render();
  });

  el.importBtn.addEventListener('click', importFavs);
  el.syncBtn.addEventListener('click', syncFavs);
  el.topSyncBtn.addEventListener('click', () => doSync(token, el.topSyncBtn));
  el.forgetBtn.addEventListener('click', forgetToken);
  // Enter in the token field triggers a sync.
  el.tokenInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') syncFavs(); });

  // Saved filters: the results-page bar has a "Show everything" reset link;
  // saving the current filter lives only in the filter pane. Apply from either
  // list; rename/delete only from the management list in the filter pane.
  el.showAllBtn.addEventListener('click', resetFilters);
  el.saveFilterPanelBtn.addEventListener('click', saveCurrentFilter);
  const onSavedClick = (e) => {
    const btn = e.target.closest('button[data-id]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.classList.contains('saved-apply')) applySavedFilter(id);
    else if (btn.classList.contains('saved-rename')) renameSavedFilter(id);
    else if (btn.classList.contains('saved-del')) deleteSavedFilter(id);
  };
  el.savedList.addEventListener('click', onSavedClick);
  el.defaultList.addEventListener('click', onSavedClick);
  el.savedManage.addEventListener('click', onSavedClick);

  $('#reset-btn').addEventListener('click', resetFilters);
  $('#refresh-btn').addEventListener('click', refresh);
  $('#now-btn').addEventListener('click', scrollToNow);
  $('#theme-toggle').addEventListener('click', cycleTheme);

  // Mobile filter drawer. The results-bar Filters button opens it; the in-panel
  // Done button (always visible at the top of the drawer) closes it. The open
  // drawer covers the Filters button, so closing relies on the in-panel Done,
  // not on a control that iOS Safari's bottom chrome could hide.
  const filtersToggle = $('#filters-toggle');
  const setDrawer = (open) => el.filters.classList.toggle('open', open);
  filtersToggle.addEventListener('click', () => setDrawer(!el.filters.classList.contains('open')));
  $('#filters-close').addEventListener('click', () => setDrawer(false));

  // The results-bar link button reveals the Sync favourites panel. On mobile the
  // panel is a full-screen drawer: opening forces the <details> open (its summary
  // is hidden there) and adds the .open class that slides it in; the in-panel Done
  // button closes it. On desktop the panel lives in the sidebar, so instead we
  // open it (if collapsed) and scroll it into view.
  const setSyncDrawer = (open) => {
    if (open) el.syncPanel.open = true;
    el.syncPanel.classList.toggle('open', open);
  };
  const mobileDrawer = window.matchMedia('(max-width: 820px)');
  el.syncOpen.addEventListener('click', () => {
    if (mobileDrawer.matches) {
      setSyncDrawer(true);
    } else {
      el.syncPanel.open = true;
      el.syncPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
  el.syncClose.addEventListener('click', () => setSyncDrawer(false));

  // Back/forward navigation restores filters.
  window.addEventListener('popstate', () => {
    readFiltersFromURL();
    buildFilterPanel();
    render();
  });
}

function resetFilters() {
  filters.q = '';
  filters.days.clear();
  filters.types.clear();
  filters.venues.clear();
  filters.family = false;
  filters.favsOnly = false;
  buildFilterPanel();
  render();
}


async function refresh() {
  const btn = $('#refresh-btn');
  btn.disabled = true;
  btn.classList.add('busy');
  let ok = false;
  try {
    const fresh = await fetchData();
    saveCache(fresh);
    ingest(fresh);
    hideStatus();
    render();
    ok = true;
  } catch (err) {
    showStatus(`Refresh failed: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
    flashButton(btn, ok);
  }
}

/* ---------- Jump to now ---------- */
// Scroll the schedule to the first visible event that hasn't started yet (the one
// nearest "now"); if everything on screen is already over, jump to the last. Works
// within the current filter, since only visible events are rendered as cards.
function scrollToNow() {
  const cards = el.schedule.querySelectorAll('.card[data-start]');
  if (!cards.length) return;
  // Round "now" down to the previous 10-minute mark (e.g. 14:37 -> 14:30) so an
  // event that began earlier in the current slot still counts as current.
  const mark = new Date();
  mark.setMinutes(Math.floor(mark.getMinutes() / 10) * 10, 0, 0);
  const cutoff = mark.getTime();
  let target = null;
  for (const card of cards) {
    // start_date is local wall-clock ("2026-07-17 19:00:00"); normalise the space
    // to 'T' so every browser parses it as a local Date.
    const t = new Date(card.dataset.start.replace(' ', 'T')).getTime();
    if (!Number.isNaN(t) && t >= cutoff) { target = card; break; }
  }
  (target || cards[cards.length - 1]).scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- Sync / import favourites ---------- */
// Favourites live in your EMF account. Two ways to bring them into this browser,
// both of which REPLACE the local set (the previous set is kept for one Undo):
//   • Sync: fetch your personal favourites feed through this site's own relay
//     (/api/favourites.json -> emfcamp.org), authenticated by your token.
//   • Paste: when the relay isn't available (e.g. local dev), paste the JSON.
function initImport() {
  updateImportSummary();
  updateTokenUI();
  updateSyncInfo();
}

// Pull favourites from the EMF feed using a token, via the same-origin relay so
// the feed's missing CORS headers don't matter. Shared by the sidebar panel and
// the top-bar quick-sync button; `flashBtn` (if given) is flashed with the
// outcome, since the sidebar status line may be collapsed or off-screen.
async function doSync(rawToken, flashBtn) {
  const t = normalizeToken(rawToken);
  if (!t) { showImportStatus('Enter your EMF favourites token or URL first.', true); return; }

  setSyncBusy(true);
  let ok = false;
  try {
    const res = await fetch(`${FAVS_FEED_URL}?token=${encodeURIComponent(t)}`, {
      headers: { Accept: 'application/json' },
    });
    if (res.status === 401) throw new Error('EMF rejected that token — check you copied all of it.');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ids = extractFavIds(await res.text());
    if (!ids.length) {
      showImportStatus('That token works, but your EMF account has no favourites yet.', true);
    } else {
      token = t;
      saveToken(t);
      updateTokenUI();
      applyImportedFavs(ids, 'Synced');
      ok = true;
    }
  } catch (err) {
    const offline = /Failed to fetch|NetworkError|Load failed/i.test(err.message);
    showImportStatus(
      offline
        ? 'Could not reach the sync relay. It runs on the deployed site, not `make dev`; use paste below instead.'
        : `Sync failed: ${err.message}`,
      true
    );
  } finally {
    setSyncBusy(false);
    if (flashBtn) flashButton(flashBtn, ok);
  }
}

// Sidebar "Sync now": use whatever is in the token field.
function syncFavs() { doSync(el.tokenInput.value); }

function setSyncBusy(busy) {
  el.syncBtn.disabled = busy;
  el.syncBtn.textContent = busy ? 'Syncing…' : 'Sync now';
  el.topSyncBtn.disabled = busy;
  el.topSyncBtn.classList.toggle('busy', busy);
}

// A results-bar action button keeps its label fixed (so the bar never reflows);
// its leading icon carries the state: it spins while busy, then flashes ✓/✕ with
// a green/red tint for the outcome before reverting to ⟳.
function flashButton(btn, ok) {
  const ico = btn.querySelector('.spin-ico');
  if (ico) ico.textContent = ok ? '✓' : '✕';
  btn.classList.toggle('copied', ok);
  btn.classList.toggle('sync-failed', !ok);
  setTimeout(() => {
    if (ico) ico.textContent = '⟳';
    btn.classList.remove('copied', 'sync-failed');
  }, 1600);
}

function importFavs() {
  const text = el.importText.value.trim();
  if (!text) { showImportStatus('Paste your favourites JSON first.', true); return; }

  let ids;
  try {
    ids = extractFavIds(text);
  } catch (err) {
    showImportStatus(`Could not read that: ${err.message}`, true);
    return;
  }
  if (!ids.length) {
    showImportStatus('No favourites found in that text. Make sure you were logged in on emfcamp.org when you copied it.', true);
    return;
  }
  applyImportedFavs(ids, 'Replaced');
  el.importText.value = '';
}

// Replace the local favourites with `ids`, so the app mirrors your EMF account
// exactly (a favourite removed on EMF disappears here on the next sync). Keep a
// one-Undo snapshot, then report what changed. `verb` leads the status line.
function applyImportedFavs(ids, verb) {
  const prev = new Set(favs);
  const incoming = new Set(ids);
  const added = ids.filter((id) => !prev.has(id)).length;
  const removed = [...prev].filter((id) => !incoming.has(id)).length;

  favsUndo = prev; // snapshot for Undo before we overwrite
  favs.clear();
  for (const id of ids) favs.add(id);
  saveFavs();
  syncedAt = nowStamp();
  saveSyncedAt(syncedAt);
  updateImportSummary();
  updateSyncInfo();
  render();

  const known = new Set(RAW.map((e) => e.id));
  const unmatched = ids.filter((id) => !known.has(id)).length;
  const bits = [];
  if (added) bits.push(`${added} added`);
  if (removed) bits.push(`${removed} removed`);
  let msg = `${verb} your favourites with ${favs.size} from EMF`;
  if (bits.length) msg += ` (${bits.join(', ')})`;
  msg += '.';
  if (unmatched) msg += ` ${unmatched} not in the ${YEAR} schedule.`;
  showImportStatus(msg, false, removed > 0);
}

// Accept the token itself or anything containing token=… (the feed URL or the
// webcal:// subscription link).
function normalizeToken(raw) {
  const s = (raw || '').trim();
  const m = s.match(/token=([^&\s]+)/i);
  return m ? decodeURIComponent(m[1]) : s;
}

function forgetToken() {
  token = '';
  saveToken('');
  el.tokenInput.value = '';
  updateTokenUI();
  render(); // favourites are local again, so re-enable the star buttons
  showImportStatus('Token forgotten, it is no longer stored in this browser.', false);
}

// While a sync token is stored the favourites mirror your EMF account exactly:
// every sync replaces the local set, so the stars are read-only here (toggling
// one would just be wiped by the next sync). Favourite on emfcamp.org and
// re-sync, or Forget the token to manage favourites locally again.
function syncLocked() { return !!token; }

function updateTokenUI() {
  el.forgetBtn.hidden = !token;
  el.topSyncBtn.hidden = !token; // top-bar quick-sync only when a token is stored
  if (token && !el.tokenInput.value) el.tokenInput.value = token;
}

function updateSyncInfo() {
  if (!syncedAt) {
    el.syncInfo.hidden = true;
    el.syncInfo.textContent = '';
    return;
  }
  el.syncInfo.textContent = `✓ Synced ${relativeWhen(syncedAt)}`;
  el.syncInfo.title = `Last synced ${formatWhen(syncedAt)}`;
  el.syncInfo.hidden = false;
}

function undoImport() {
  if (!favsUndo) return;
  favs.clear();
  for (const id of favsUndo) favs.add(id);
  favsUndo = null;
  saveFavs();
  // Undo reverts the adoption, so the last-synced time no longer describes the
  // current favourites; clear the indicator.
  syncedAt = '';
  saveSyncedAt('');
  updateImportSummary();
  updateSyncInfo();
  render();
  showImportStatus('Import undone: your previous favourites are back.', false);
}

// Accept either a favourites feed ([{id, is_fave, …}, …]) or a bare list of ids
// ([123, 456]). For a feed we take only rows flagged is_fave; if the flag is
// absent entirely (older API) we fall back to every id present, which is exactly
// the favourites for the favourites.json / ?is_favourite=True endpoints.
function extractFavIds(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('expected a JSON array');
  const ids = new Set();
  for (const item of data) {
    if (typeof item === 'number') { ids.add(item); continue; }
    if (item && typeof item === 'object' && 'id' in item) {
      if ('is_fave' in item && item.is_fave !== true) continue;
      const n = Number(item.id);
      if (Number.isFinite(n)) ids.add(n);
    }
  }
  return [...ids];
}

function updateImportSummary() {
  const node = document.querySelector('.facet-count[data-facet="import"]');
  if (node) node.textContent = favs.size ? `· ${favs.size} saved` : '';
}

function showImportStatus(msg, isError, withUndo) {
  el.importStatus.textContent = msg;
  el.importStatus.classList.toggle('error', !!isError);
  if (withUndo) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'text-btn undo-btn';
    btn.textContent = 'Undo';
    btn.addEventListener('click', undoImport);
    el.importStatus.append(' ', btn);
  }
  el.importStatus.hidden = false;
}

/* ---------- Theme ---------- */
/* Icon-only toggle: the glyph itself signals the mode, since the tooltip is
   hover-only and so invisible on touch. ☀/☾ carry a text-presentation selector
   (U+FE0E) so they render as flat glyphs, not colourful emoji, matching the
   other monochrome header icons. */
function renderThemeToggle(mode) {
  const btn = $('#theme-toggle');
  if (!btn) return;
  const icons = { auto: '◐', light: '☀︎', dark: '☾︎' };
  btn.textContent = icons[mode] || icons.auto;
  const label = `Theme: ${mode} (tap to change)`;
  btn.title = label;
  btn.setAttribute('aria-label', label);
}
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) document.documentElement.dataset.theme = saved;
  renderThemeToggle(document.documentElement.dataset.theme || 'auto');
}
function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const cur = document.documentElement.dataset.theme || 'auto';
  const next = order[(order.indexOf(cur) + 1) % order.length];
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
  renderThemeToggle(next);
}

/* ---------- Persistence ---------- */
function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return Array.isArray(obj.data) ? obj : null;
  } catch { return null; }
}
function saveCache(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: nowStamp(), data })); } catch { /* quota */ }
}
function loadFavs() {
  try { return new Set(JSON.parse(localStorage.getItem(FAVS_KEY) || '[]')); } catch { return new Set(); }
}
function saveFavs() {
  try { localStorage.setItem(FAVS_KEY, JSON.stringify([...favs])); } catch { /* quota */ }
}
function loadToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
function saveToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* quota / disabled storage */ }
}
function loadSyncedAt() {
  try { return localStorage.getItem(SYNCED_KEY) || ''; } catch { return ''; }
}
function saveSyncedAt(iso) {
  try {
    if (iso) localStorage.setItem(SYNCED_KEY, iso);
    else localStorage.removeItem(SYNCED_KEY);
  } catch { /* quota / disabled storage */ }
}
function loadSaved() {
  try {
    const a = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
    return Array.isArray(a) ? a.filter((s) => s && s.id && typeof s.name === 'string') : [];
  } catch { return []; }
}
function saveSaved() {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(savedFilters)); } catch { /* quota */ }
}
function loadLastFilter() {
  try { return localStorage.getItem(LAST_KEY) || ''; } catch { return ''; }
}
function saveLastFilter(qs) {
  try {
    if (qs) localStorage.setItem(LAST_KEY, qs);
    else localStorage.removeItem(LAST_KEY); // no filter to restore; clear it
  } catch { /* quota / disabled storage */ }
}

/* ---------- Status ---------- */
function showStatus(msg, isError) {
  el.status.textContent = msg;
  el.status.classList.toggle('error', !!isError);
  el.status.hidden = false;
}
function hideStatus() { el.status.hidden = true; }

/* ---------- Helpers ---------- */
function weekday(dateStr) {
  // Parse as UTC midnight so the weekday never shifts with the local timezone.
  const d = new Date(dateStr + 'T00:00:00Z');
  return isNaN(d) ? 0 : d.getUTCDay();
}

// Local calendar date (YYYY-MM-DD) offset by `offsetDays`, for matching the
// schedule's day dates against "today"/"tomorrow" where the visitor is.
function localDateStr(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function duration(start, end) {
  if (!start || !end) return '';
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let mins = eh * 60 + em - (sh * 60 + sm);
  if (mins <= 0) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}

function truncate(str, n) {
  if (!str) return '';
  const clean = str.replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n).trimEnd() + '…' : clean;
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function nowStamp() {
  return new Date().toISOString();
}
function formatWhen(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch { return iso; }
}

// Compact "how long ago" for the sync indicator, falling back to an absolute
// date once it is more than a week old.
function relativeWhen(iso) {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return 'recently';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return `on ${formatWhen(iso)}`;
}
