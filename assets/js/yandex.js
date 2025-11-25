// map/assets/js/yandex.js
// Trans-Time / Яндекс.Карты — интеллектуальная карта для большегрузов

import { $, $$, toast, fmtDist, fmtTime, escapeHtml } from './core.js';
import { YandexRouter } from './router.js';

let map, multiRoute, viaPoints = [];
let viaMarkers = [];
let viaMode = false;
let activeRouteChangeHandler = null;
let framesToggleStateBeforeCar = null;
let trafficControl = null;
let isBuilding = false;
let apiWatchdog = null;

// === Утилиты ===
function addToMap(obj) {
  if (obj && map && !isOnMap(obj)) {
    map.geoObjects.add(obj);
    obj.__tt_onMap = true;
  }
}
function removeFromMap(obj) {
  if (obj && map && isOnMap(obj)) {
    map.geoObjects.remove(obj);
    obj.__tt_onMap = false;
  }
}
function isOnMap(obj) {
  return !!(obj && obj.__tt_onMap === true);
}

function normalizeCoordPair(pair) {
  if (!Array.isArray(pair) || pair.length < 2) return null;
  let [x, y] = pair;
  const absX = Math.abs(Number(x));
  const absY = Math.abs(Number(y));
  if (!Number.isFinite(absX) || !Number.isFinite(absY)) return null;
  if (absX <= 90 && absY > 90) [x, y] = [y, x];
  return [Number(x), Number(y)];
}

function normalizeGeomCoords(geom) {
  if (!geom || !geom.type) return geom;
  const swap = c => normalizeCoordPair(c);
  const normLine = line => Array.isArray(line) ? line.map(swap).filter(Boolean) : line;
  const normRing = ring => Array.isArray(ring) ? ring.map(swap).filter(Boolean) : ring;
  switch (geom.type) {
    case 'Point':
      geom.coordinates = swap(geom.coordinates);
      break;
    case 'MultiPoint':
      geom.coordinates = Array.isArray(geom.coordinates) ? geom.coordinates.map(swap).filter(Boolean) : geom.coordinates;
      break;
    case 'LineString':
      geom.coordinates = normLine(geom.coordinates);
      break;
    case 'MultiLineString':
      geom.coordinates = Array.isArray(geom.coordinates) ? geom.coordinates.map(normLine) : geom.coordinates;
      break;
    case 'Polygon':
      geom.coordinates = Array.isArray(geom.coordinates) ? geom.coordinates.map(normRing) : geom.coordinates;
      break;
    case 'MultiPolygon':
      geom.coordinates = Array.isArray(geom.coordinates)
        ? geom.coordinates.map(poly => Array.isArray(poly) ? poly.map(normRing) : poly)
        : geom.coordinates;
      break;
    case 'GeometryCollection':
      if (Array.isArray(geom.geometries)) geom.geometries.forEach(g => normalizeGeomCoords(g));
      break;
  }
  return geom;
}

function normalizeFeatureCollectionCoords(fc) {
  if (!fc || !Array.isArray(fc.features)) return fc;
  fc.features.forEach(f => { if (f && f.geometry) normalizeGeomCoords(f.geometry); });
  return fc;
}

function normalizeBBox(rawBBox) {
  if (!Array.isArray(rawBBox) || rawBBox.length < 2) return null;
  const p1 = normalizeCoordPair(rawBBox[0]);
  const p2 = normalizeCoordPair(rawBBox[1]);
  if (!p1 || !p2) return null;
  const [lon1, lat1] = p1;
  const [lon2, lat2] = p2;
  return [
    [Math.min(lon1, lon2), Math.min(lat1, lat2)],
    [Math.max(lon1, lon2), Math.max(lat1, lat2)]
  ];
}

function expandBBox(bbox, margin = 0.02) {
  const norm = normalizeBBox(bbox);
  if (!norm) return null;
  const [[minLon, minLat], [maxLon, maxLat]] = norm;
  return [
    [minLon - margin, minLat - margin],
    [maxLon + margin, maxLat + margin]
  ];
}

function bboxFromPoints(points, margin = 0.05) {
  if (!Array.isArray(points) || points.length === 0) return null;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  points.forEach(pt => {
    const norm = normalizeCoordPair(pt);
    if (!norm) return;
    const [lon, lat] = norm;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  });
  if (!Number.isFinite(minLat) || !Number.isFinite(minLon)) return null;
  return [
    [minLon - margin, minLat - margin],
    [maxLon + margin, maxLat + margin]
  ];
}

// === Параметры ТС ===
function getTruckParams() {
  return {
    weight: parseFloat($('#truckWeight')?.value) || 0,
    height: parseFloat($('#truckHeight')?.value) || 0,
    width:  parseFloat($('#truckWidth')?.value)  || 0,
    length: parseFloat($('#truckLength')?.value)  || 0,
  };
}

function getCurrentVehMode() {
  return document.querySelector('input[name=veh]:checked')?.value || 'truck40';
}

function isCarMode() {
  return getCurrentVehMode() === 'car';
}

// === Слои ===
const LAYERS_BASE = window.TRANSTIME_CONFIG?.layersBase || (location.pathname.replace(/\/[^/]*$/, '') + '/data');
function urlFromBase(name) {
  return `${LAYERS_BASE}/${name}`;
}

async function loadGeoJSON(filename, friendlyName) {
  const url = urlFromBase(filename);
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.status === 404) {
      toast(`Нет данных слоя: ${friendlyName || filename}`);
      return { type: 'FeatureCollection', features: [], __tt_httpStatus: 404 };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && typeof data === 'object') data.__tt_httpStatus = res.status;
    return data;
  } catch (e) {
    toast(`Ошибка загрузки ${friendlyName || filename}: ${e.message}`);
    return { type: 'FeatureCollection', features: [], __tt_httpStatus: -1 };
  }
}

let savedRoutes = [];
function loadSavedRoutes() { try { savedRoutes = JSON.parse(localStorage.getItem('TT_SAVED_ROUTES')) || []; } catch { savedRoutes = []; } }
function writeSavedRoutes() { try { localStorage.setItem('TT_SAVED_ROUTES', JSON.stringify(savedRoutes)); } catch {} }

function renderSavedRoutes() {
  const listEl = $('#savedRoutesList');
  if (!listEl) return;
  listEl.innerHTML = '';
  savedRoutes.forEach((r, index) => {
    const li = document.createElement('li');
    const meta = document.createElement('div');
    meta.className = 'tt-saved-meta';
    const fromTxt = (r.from || '').trim();
    const toTxt = (r.to || '').trim();
    meta.textContent = `${fromTxt} → ${toTxt} (via: ${(r.viaPoints && r.viaPoints.length) || 0})`;

    const loadBtn = document.createElement('button');
    loadBtn.textContent = 'Загрузить';
    loadBtn.addEventListener('click', () => loadSavedRoute(index));

    const delBtn = document.createElement('button');
    delBtn.textContent = 'Удалить';
    delBtn.classList.add('delete');
    delBtn.addEventListener('click', () => deleteSavedRoute(index));

    li.appendChild(meta);
    li.appendChild(loadBtn);
    li.appendChild(delBtn);
    listEl.appendChild(li);
  });
}

async function loadSavedRoute(index) {
  const r = savedRoutes[index];
  if (!r) return;
  const fromEl = $('#from');
  const toEl   = $('#to');
  if (fromEl) fromEl.value = r.from || '';
  if (toEl)   toEl.value   = r.to   || '';

  if (r.veh) {
    $$('input[name=veh]').forEach(inp => {
      inp.checked = inp.value === r.veh;
      inp.dispatchEvent(new Event('change'));
    });
  }

  $('#truckWeight')?.setAttribute('value', r.weight || '');
  $('#truckHeight')?.setAttribute('value', r.height || '');
  $('#truckWidth')?.setAttribute('value', r.width || '');
  $('#truckLength')?.setAttribute('value', r.length || '');

  viaPoints = [];
  viaMarkers.forEach(removeFromMap);
  viaMarkers = [];

  (r.viaPoints || []).forEach(coords => {
    viaPoints.push(coords);
    if (map) {
      const mark = new ymaps.Placemark(coords, { hintContent: 'via' }, { preset: 'islands#darkGreenCircleDotIcon' });
      addToMap(mark);
      viaMarkers.push(mark);
    }
  });

  fromEl?.dispatchEvent(new Event('input'));
  toEl?.dispatchEvent(new Event('input'));
  await buildRouteWithState();
}

function deleteSavedRoute(index) {
  savedRoutes.splice(index, 1);
  writeSavedRoutes();
  renderSavedRoutes();
}

function saveCurrentRoute() {
  const fromVal = $('#from')?.value.trim();
  const toVal   = $('#to')?.value.trim();
  if (!fromVal || !toVal) return toast('Заполните адреса для сохранения', 2000);

  const vehChecked = document.querySelector('input[name=veh]:checked');
  const veh = (vehChecked && vehChecked.value) || 'truck40';

  const params = getTruckParams();

  savedRoutes.push({ from: fromVal, to: toVal, viaPoints: viaPoints.slice(), veh, ...params });
  writeSavedRoutes();
  renderSavedRoutes();
  toast('Маршрут сохранён', 1600);
}

function shareCurrentRoute() {
  const fromVal = $('#from')?.value.trim();
  const toVal   = $('#to')?.value.trim();
  if (!fromVal || !toVal) return toast('Нет маршрута для создания ссылки', 2000);

  const params = getTruckParams();
  const veh = getCurrentVehMode();

  const link = encodeSharePayload({ from: fromVal, to: toVal, viaPoints: viaPoints.slice(), veh, ...params });
  if (!link) return toast('Не удалось создать ссылку', 2000);

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(link).then(
      () => toast('Ссылка скопирована', 2000),
      () => toast('Ссылка: ' + link, 4000)
    );
  } else {
    toast('Ссылка: ' + link, 4000);
  }
}

function encodeSharePayload(data) {
  try {
    const json = JSON.stringify(data);
    const b64 = btoa(unescape(encodeURIComponent(json)));
    return window.location.href.split('#')[0] + '#share=' + b64;
  } catch (e) {
    console.error('encodeSharePayload failed:', e);
    return '';
  }
}

function openInNavigator() {
  const fromVal = $('#from')?.value.trim();
  const toVal   = $('#to')?.value.trim();
  if (!fromVal || !toVal) return toast('Нет маршрута для открытия', 2000);

  const pts = [];
  if (multiRoute?.getWayPoints) {
    const wps = multiRoute.getWayPoints();
    wps.each(wp => {
      const c = wp.geometry.getCoordinates();
      if (Array.isArray(c)) pts.push(c[1] + ',' + c[0]);
    });
  }

  const url = 'https://yandex.ru/navi/?rtext=' + encodeURIComponent(pts.join('~')) + '&rtt=auto';
  window.open(url, '_blank');
}

// === Слои ===
const layers = {
  frames: null,
  hgvAllowed: null,
  hgvForbidden: null,
  hgvConditional: null,
  federal: null,
  clearance: null
};

const layerConfigs = {
  frames: {
    filename: 'frames_ready.geojson',
    friendlyName: 'Весовые рамки',
    options: { preset: 'islands#blueCircleDotIcon', zIndex: 220 }
  },
  hgvAllowed: {
    filename: 'hgv_allowed.geojson',
    friendlyName: 'Разрешён проезд ТС >3.5т',
    options: { preset: 'islands#darkGreenCircleDotIcon', zIndex: 210 }
  },
  hgvForbidden: {
    filename: 'hgv_forbidden.geojson',
    friendlyName: 'Запрещён проезд ТС >3.5т',
    options: { preset: 'islands#redCircleDotIcon', zIndex: 208 }
  },
  hgvConditional: {
    filename: 'hgv_conditional.geojson',
    friendlyName: 'Условно разрешён проезд ТС >3.5т',
    options: { preset: 'islands#yellowCircleDotIcon', zIndex: 205 }
  },
  federal: {
    filename: 'federal.geojson',
    friendlyName: 'Федеральные трассы',
    options: { preset: 'islands#grayCircleDotIcon', zIndex: 200 }
  },
  clearance: {
    filename: 'clearance.geojson',
    friendlyName: 'Ограничения (высота/ширина)',
    options: { preset: 'islands#orangeCircleDotIcon', zIndex: 202 }
  }
};

function applyLayerOptions(manager, options = {}) {
  if (!manager?.objects?.options) return;
  Object.entries(options).forEach(([key, value]) => manager.objects.options.set(key, value));
  manager.objects.options.set({ strokeColor: '#60a5fa', strokeWidth: 3, strokeOpacity: 0.9, fillOpacity: 0.3 });
}

function decorateFeatureCollection(fc) {
  if (!fc?.features) return;
  fc.features.forEach(f => {
    if (!f) return;
    const p = f.properties || {};
    const g = f.geometry || {};

    const title = p.name || p.title || p.comment_human || (p.object_type === 'frame' ? 'Весовая рамка' : 'Объект');
    const comment = p.comment_human || p.comment || '';
    const extra = [];
    if (p.frame_state) extra.push('Состояние: ' + p.frame_state);
    if (p.frame_id)    extra.push('ID: ' + p.frame_id);

    f.properties = {
      ...p,
      hintContent: title,
      balloonContent:
        `<b>${escapeHtml(title)}</b>` +
        (comment ? `<div class="mt6">${escapeHtml(comment)}</div>` : '') +
        (extra.length ? `<div class="small mt6">${extra.map(escapeHtml).join('<br>')}</div>` : '')
    };

    if (f.properties.object_type === 'segment' && (g.type === 'LineString' || g.type === 'MultiLineString')) {
      let color = '#9ca3af';
      if (f.properties.hgv_access === 'allowed') color = '#16a34a';
      else if (f.properties.hgv_access === 'conditional') color = '#eab308';
      else if (f.properties.hgv_access === 'forbidden') color = '#dc2626';
      else if (f.properties.height_limit && parseFloat(f.properties.height_limit) < getTruckParams().height) color = '#ef4444';
      else if (f.properties.width_limit && parseFloat(f.properties.width_limit) < getTruckParams().width) color = '#f97316';

      f.options = f.options || {};
      f.options.strokeColor = color;
      f.options.strokeWidth = 3;
      f.options.strokeOpacity = 0.9;
    }
  });
}

function ensureFeatureIds(fc, prefix = 'fc') {
  if (!fc?.features) return;
  let i = 0;
  fc.features.forEach(f => {
    if (f && (f.id === undefined || f.id === null)) f.id = `${prefix}_${i++}`;
  });
}

export function init() {
  const cfg = (window.TRANSTIME_CONFIG && window.TRANSTIME_CONFIG.yandex) || null;
  if (!cfg?.apiKey) return toast('Ошибка конфигурации: нет API-ключа');
  if (window.__TT_YA_LOADING__) return;
  window.__TT_YA_LOADING__ = true;

  if (apiWatchdog) {
    clearTimeout(apiWatchdog);
    apiWatchdog = null;
  }

  const script = document.createElement('script');
  script.src =
    'https://api-maps.yandex.ru/2.1/?apikey=' + encodeURIComponent(cfg.apiKey) +
    '&lang=' + encodeURIComponent(cfg.lang || 'ru_RU') +
    '&csp=true&coordorder=longlat' +
    '&load=package.full';
  script.defer = true;
  script.crossOrigin = 'anonymous';
  script.onload = () => {
    if (apiWatchdog) {
      clearTimeout(apiWatchdog);
      apiWatchdog = null;
    }
    if (window.ymaps && typeof ymaps.ready === 'function') {
      ymaps.ready(setup);
    } else {
      window.__TT_YA_LOADING__ = false;
      toast('Yandex Maps API не загружен (проверьте CSP и ошибки bundling)');
      console.error('Yandex Maps API script loaded but ymaps is missing. Возможно, CSP блокирует выполнение или SDK вернул ошибку "Failed to bundle \"full\"".');
    }
  };
  script.onerror = (evt) => {
    window.__TT_YA_LOADING__ = false;
    toast('Не удалось загрузить Yandex Maps (проверьте Referer, API-ключ и директивы CSP для api-maps.yandex.ru)');
    console.error('Yandex Maps API load error:', evt);
  };
  document.head.appendChild(script);

  apiWatchdog = setTimeout(() => {
    if (!window.ymaps || typeof window.ymaps.ready !== 'function') {
      window.__TT_YA_LOADING__ = false;
      toast('Yandex Maps API не ответил. Проверьте корректность ключа, Referer и директивы script-src / script-src-elem.');
    }
  }, 9000);
}

async function toggleLayer(name, on, checkbox) {
  if (!map) return;
  const cfg = layerConfigs[name];
  const manager = layers[name];
  if (!cfg || !manager) return;

  if (on) {
    const fc = await loadGeoJSON(cfg.filename, cfg.friendlyName);
    if (!Array.isArray(fc.features) || fc.features.length === 0) {
      if (fc.__tt_httpStatus !== 404) toast(`Нет данных слоя: ${cfg.friendlyName}`);
      if (checkbox) checkbox.checked = false;
      manager.removeAll?.();
      removeFromMap(manager);
      return;
    }
    normalizeFeatureCollectionCoords(fc);
    ensureFeatureIds(fc, name);
    decorateFeatureCollection(fc);
    delete fc.__tt_httpStatus;
    manager.removeAll?.();
    manager.add(fc);
    addToMap(manager);
  } else {
    removeFromMap(manager);
  }
}

function setup() {
  const cfg = window.TRANSTIME_CONFIG || {};
  const center = (cfg.map && cfg.map.center) || [55.751244, 37.618423];
  const zoom = (cfg.map && cfg.map.zoom) || 8;

  if (!document.getElementById('map')) return toast('Не найден контейнер #map', 2500);

  map = new ymaps.Map('map', {
    center,
    zoom,
    controls: ['zoomControl', 'typeSelector']
  }, {
    suppressMapOpenBlock: true
  });

  try {
    trafficControl = new ymaps.control.TrafficControl({
      state: { providerKey: 'traffic#actual', trafficShown: true, infoLayerShown: true }
    });
    map.controls.add(trafficControl, { float: 'right' });
  } catch (e) {
    console.warn('TrafficControl failed:', e);
  }

  try {
    const key = 'TT_MAP_VIEW';
    const saved = localStorage.getItem(key);
    if (saved) {
      const v = JSON.parse(saved);
      if (Array.isArray(v.center) && typeof v.zoom === 'number') {
        map.setCenter(v.center, v.zoom, { duration: 0 });
      }
    }
    map.events.add('boundschange', () => {
      const c = map.getCenter();
      const z = map.getZoom();
      localStorage.setItem(key, JSON.stringify({ center: c, zoom: z }));
    });
  } catch (e) {
    console.warn('Map view save failed:', e);
  }

  Object.entries(layerConfigs).forEach(([name, cfg]) => {
    const manager = new ymaps.ObjectManager({ clusterize: false });
    layers[name] = manager;
    applyLayerOptions(manager, cfg.options);
  });

  const from = $('#from');
  const to = $('#to');
  const buildBtn = $('#buildBtn');
  const clearVia = $('#clearVia');
  const viaModeBtn = $('#viaModeBtn');
  const vehRadios = $$('input[name=veh]');

  const saveRouteBtn = $('#saveRouteBtn');
  const shareRouteBtn = $('#shareRouteBtn');
  const openNavBtn = $('#openNavBtn');

  loadSavedRoutes();
  renderSavedRoutes();

  saveRouteBtn?.addEventListener('click', saveCurrentRoute);
  shareRouteBtn?.addEventListener('click', shareCurrentRoute);
  openNavBtn?.addEventListener('click', openInNavigator);

  const cFrames = $('#toggle-frames');
  const cHgvA = $('#toggle-hgv-allowed');
  const cHgvF = $('#toggle-hgv-forbidden');
  const cHgvC = $('#toggle-hgv-conditional');
  const cFed = $('#toggle-federal');
  const cClearance = $('#toggle-clearance');
  const cTraffic = $('#toggle-traffic');
  const cEvents = $('#toggle-events');

  function updateUI() {
    const hasFrom = !!from?.value.trim();
    const hasTo = !!to?.value.trim();
    if (buildBtn) buildBtn.disabled = !(hasFrom && hasTo);
    if (clearVia) clearVia.disabled = viaPoints.length === 0;
    if (viaModeBtn) viaModeBtn.classList.toggle('active', viaMode);
  }

  function updateVehGroup() {
    vehRadios.forEach(r => r.parentElement.classList.toggle('active', r.checked));
  }

  [from, to].forEach(inp => {
    inp?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        buildRouteWithState();
      }
    });
    inp?.addEventListener('input', updateUI);
  });

  vehRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      updateVehGroup();
      syncFramesLayerVisibility();
      if (from?.value.trim() && to?.value.trim()) buildRouteWithState();
    });
  });

  buildBtn?.addEventListener('click', () => {
    if (from?.value.trim() && to?.value.trim()) {
      buildRouteWithState();
    } else {
      toast('Заполните «Откуда» и «Куда»');
    }
  });

  if (viaModeBtn) {
    viaModeBtn.addEventListener('click', () => {
      viaMode = !viaMode;
      updateUI();
      toast(viaMode ? 'Клик по карте добавит промежуточную точку' : 'Режим добавления точек отключён');
    });
  }

  map.events.add('click', (e) => {
    if (!viaMode) return;
    if (viaPoints.length >= 5) return toast('Максимум 5 промежуточных точек');

    const coords = e.get('coords');
    viaPoints.push(coords);

    const mark = new ymaps.Placemark(coords, {
      hintContent: `Промежуточная точка (${viaPoints.length})`
    }, {
      preset: 'islands#darkGreenCircleDotIcon'
    });

    mark.events.add('click', () => {
      const index = viaMarkers.indexOf(mark);
      if (index !== -1) {
        viaPoints.splice(index, 1);
        viaMarkers.splice(index, 1);
        removeFromMap(mark);
        updateUI();
        if (from?.value.trim() && to?.value.trim()) buildRouteWithState();
      }
    });

    addToMap(mark);
    viaMarkers.push(mark);
    updateUI();
    if (from?.value.trim() && to?.value.trim()) buildRouteWithState();
  });

  clearVia?.addEventListener('click', () => {
    viaPoints = [];
    viaMarkers.forEach(removeFromMap);
    viaMarkers = [];
    updateUI();
    if (from?.value.trim() && to?.value.trim()) buildRouteWithState();
  });

  cFrames?.addEventListener('change', e => toggleLayer('frames', e.target.checked, cFrames));
  cHgvA?.addEventListener('change', e => toggleLayer('hgvAllowed', e.target.checked, cHgvA));
  cHgvF?.addEventListener('change', e => toggleLayer('hgvForbidden', e.target.checked, cHgvF));
  cHgvC?.addEventListener('change', e => toggleLayer('hgvConditional', e.target.checked, cHgvC));
  cFed?.addEventListener('change', e => toggleLayer('federal', e.target.checked, cFed));
  cClearance?.addEventListener('change', e => toggleLayer('clearance', e.target.checked, cClearance));

  if (cTraffic) {
    window.__tt_setTraffic = on => { try { trafficControl?.state.set('trafficShown', !!on); } catch (e) { console.warn(e); } };
    cTraffic.addEventListener('change', () => window.__tt_setTraffic(cTraffic.checked));
    window.__tt_setTraffic(cTraffic.checked);
  }

  if (cEvents) {
    window.__tt_setEvents = on => { try { trafficControl?.state.set('infoLayerShown', !!on); } catch (e) { console.warn(e); } };
    cEvents.addEventListener('change', () => window.__tt_setEvents(cEvents.checked));
    window.__tt_setEvents(cEvents.checked);
  }

  updateUI();
  updateVehGroup();
  syncFramesLayerVisibility();
}

async function buildRouteWithState() {
  if (isBuilding) {
    toast('Идёт построение маршрута, подождите...');
    return;
  }
  isBuilding = true;

  try {
    const fromVal = $('#from')?.value.trim();
    const toVal = $('#to')?.value.trim();
    if (!fromVal || !toVal) throw new Error('Укажите «Откуда» и «Куда»');

    const vehMode = getCurrentVehMode();
    const { weight, height, width, length } = getTruckParams();

    const opts = {
      mode: vehMode === 'car' ? 'driving' : 'truck',
      alternatives: 3,
      weight: weight ? weight * 1000 : undefined,
      dimensions: {}
    };

    if (height)  opts.dimensions.height = height;
    if (width)   opts.dimensions.width  = width;
    if (length)  opts.dimensions.length = length;

    const A = await YandexRouter.geocode(fromVal);
    const B = await YandexRouter.geocode(toVal);
    const points = [A, ...viaPoints, B];

    const res = await YandexRouter.build(points, opts);
    const mr = res.multiRoute;

    if (multiRoute) {
      if (activeRouteChangeHandler && multiRoute.events?.remove) {
        multiRoute.events.remove('activeroutechange', activeRouteChangeHandler);
      }
      removeFromMap(multiRoute);
    }

    multiRoute = mr;
    addToMap(multiRoute);

    activeRouteChangeHandler = () => {
      refreshFramesForActiveRoute(points);
      highlightActiveRouteItem();
    };
    multiRoute.events.add('activeroutechange', activeRouteChangeHandler);

    refreshFramesForActiveRoute(points);
    renderRouteList(res.routes);
    highlightActiveRouteItem();

    toast('Маршрут построен');
  } catch (e) {
    console.error('Ошибка построения маршрута:', e);
    toast(e.message || 'Ошибка построения маршрута');
  } finally {
    isBuilding = false;
  }
}

function renderRouteList(routes) {
  const listEl = $('#routeList');
  if (!listEl || !routes || routes.getLength() <= 1) {
    if (listEl) listEl.style.display = 'none';
    return;
  }
  listEl.innerHTML = '';
  const arr = [];
  routes.each(r => {
    const d = r.properties.get('distance') || {};
    const tT = r.properties.get('durationInTraffic') || {};
    const t = r.properties.get('duration') || {};
    arr.push({ r, time: Number(tT.value || t.value || 0) });
  });
  arr.sort((a, b) => a.time - b.time);
  arr.forEach((o, index) => {
    const dist = fmtDist(o.r.properties.get('distance')?.value || 0);
    const dur = fmtTime(o.r.properties.get('durationInTraffic')?.value || o.r.properties.get('duration')?.value || 0);
    const div = document.createElement('div');
    div.className = 'tt-route-item';
    div.dataset.index = index;
    div.innerHTML = `<div><strong>Маршрут ${index + 1}</strong></div><div>${dist}, ${dur}</div>`;
    div.addEventListener('click', () => { try { multiRoute.setActiveRoute(o.r); } catch (e) { console.warn(e); } });
    listEl.appendChild(div);
  });
  listEl.style.display = 'block';
  highlightActiveRouteItem();
}

function highlightActiveRouteItem() {
  const listEl = $('#routeList');
  if (!listEl || !multiRoute?.getActiveRoute) return;
  const active = multiRoute.getActiveRoute();
  const routes = multiRoute.getRoutes?.();
  let activeIndex = -1;
  if (routes?.getLength) routes.each((r, idx) => { if (r === active) activeIndex = idx; });
  Array.from(listEl.children).forEach((el, idx) => el.classList.toggle('active', idx === activeIndex));
}

function collectRouteGeometryPoints(route) {
  const pts = [];
  try {
    route.getPaths?.().each(path => {
      path.getSegments?.().each(segment => {
        const coords = segment.getCoordinates?.();
        if (Array.isArray(coords)) coords.forEach(c => Array.isArray(c) && pts.push(c));
      });
    });
  } catch (e) {
    console.warn('Ошибка при сборе точек маршрута:', e);
  }
  return pts;
}

function refreshFramesForActiveRoute(fallbackPoints) {
  if (isCarMode()) return;
  const framesToggle = $('#toggle-frames');
  if (!framesToggle?.checked) return;

  let bbox = null;
  const activeRoute = multiRoute?.getActiveRoute?.();
  if (activeRoute) {
    bbox = normalizeBBox(activeRoute.properties?.get?.('boundedBy'));
    if (!bbox) bbox = bboxFromPoints(collectRouteGeometryPoints(activeRoute));
  }
  if (!bbox && Array.isArray(fallbackPoints)) bbox = bboxFromPoints(fallbackPoints);
  applyFramesBBox(bbox);
}

function applyFramesBBox(bbox) {
  if (!layers.frames?.objects) return;
  if (!bbox) return layers.frames.objects.setFilter(null);
  const expanded = expandBBox(bbox);
  if (!expanded) return layers.frames.objects.setFilter(null);
  const [[minLon, minLat], [maxLon, maxLat]] = expanded;
  layers.frames.objects.setFilter(obj => {
    const coords = normalizeCoordPair(obj.geometry?.coordinates);
    if (!coords) return false;
    const [lon, lat] = coords;
    return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
  });
}

function syncFramesLayerVisibility() {
  const manager = layers.frames;
  const framesToggle = $('#toggle-frames');
  if (!framesToggle || !manager) return;
  framesToggle.disabled = isCarMode();
  if (isCarMode()) {
    if (framesToggleStateBeforeCar === null) framesToggleStateBeforeCar = framesToggle.checked;
    framesToggle.checked = false;
    removeFromMap(manager);
    manager.objects?.setFilter?.(null);
    return;
  }
  if (framesToggleStateBeforeCar !== null) {
    framesToggle.checked = framesToggleStateBeforeCar;
    framesToggleStateBeforeCar = null;
  }
  if (framesToggle.checked) {
    addToMap(manager);
    refreshFramesForActiveRoute();
  } else {
    removeFromMap(manager);
  }
}

// === Экспорт для boot.js ===
window.onBuild = buildRouteWithState;

// === Глобальная обработка ошибок (для отладки) ===
window.addEventListener('error', (e) => {
  console.error('JS Error:', e.error || e.message, 'at', e.filename, e.lineno);
}, true);

// === Дополнительная защита ===
window.addEventListener('unhandledrejection', (e) => {
  console.error('Unhandled promise rejection:', e.reason);
});

// === ЗАПУСК ИНИЦИАЛИЗАЦИИ КАРТЫ === ✅ ЭТА СТРОКА БЫЛА ДОБАВЛЕНА
init();