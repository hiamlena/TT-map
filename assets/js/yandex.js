// map/assets/js/yandex.js
// Trans-Time / Яндекс.Карты — интеллектуальная карта с умными кнопками и слоями

import { $, $$, toast, fmtDist, fmtTime, escapeHtml } from './core.js';
import { YandexRouter } from './router.js';

let map, multiRoute, viaPoints = [];
let viaMarkers = [];
let viaMode = false;
let activeRouteChangeHandler = null;
let framesToggleStateBeforeCar = null;
let trafficControl = null;
let isBuilding = false;
let updateUI = () => {};

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
  if (absX <= 90 && absY > 90) {
    [x, y] = [y, x];
  }
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

function expandBBox(bbox, margin = 0) {
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
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  points.forEach(pt => {
    const norm = normalizeCoordPair(pt);
    if (!norm) return;
    const [lon, lat] = norm;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  });
  if (!Number.isFinite(minLat) || !Number.isFinite(minLon) || !Number.isFinite(maxLat) || !Number.isFinite(maxLon)) {
    return null;
  }
  return [
    [minLon - margin, minLat - margin],
    [maxLon + margin, maxLat + margin]
  ];
}

function getCurrentVehMode() {
  return document.querySelector('input[name=veh]:checked')?.value || 'truck40';
}

function isCarMode() {
  return getCurrentVehMode() === 'car';
}

function handleViaMarkerClick(marker) {
  const idx = viaMarkers.indexOf(marker);
  if (idx === -1) return;

  viaMarkers.splice(idx, 1);
  viaPoints.splice(idx, 1);
  removeFromMap(marker);
  toast('Точка по пути удалена', 1200);
  updateUI();
  rebuildRouteIfReady();
}

function createViaMarker(coords) {
  const mark = new ymaps.Placemark(
    coords,
    { hintContent: 'via ' + (viaPoints.length + 1) },
    { preset: 'islands#darkGreenCircleDotIcon' }
  );
  mark.events.add('click', () => handleViaMarkerClick(mark));
  return mark;
}

function addViaPoint(coords, { silent = false } = {}) {
  if (viaPoints.length >= 5) {
    if (!silent) toast('Максимум 5 точек по пути', 1500);
    return false;
  }

  viaPoints.push(coords);
  if (map) {
    const mark = createViaMarker(coords);
    addToMap(mark);
    viaMarkers.push(mark);
  }
  if (!silent) toast(`Добавлена точка по пути (${viaPoints.length})`, 1200);
  updateUI();
  return true;
}

async function rebuildRouteIfReady() {
  const fromVal = $('#from')?.value.trim();
  const toVal = $('#to')?.value.trim();
  if (!fromVal || !toVal) return;
  try {
    await buildRouteWithState();
  } catch (e) {
    toast(typeof e === 'string' ? e : (e.message || 'Ошибка построения маршрута'));
  }
}

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

function loadSavedRoutes() {
  try {
    const data = localStorage.getItem('TT_SAVED_ROUTES');
    savedRoutes = data ? JSON.parse(data) : [];
  } catch {
    savedRoutes = [];
  }
}

function writeSavedRoutes() {
  try { localStorage.setItem('TT_SAVED_ROUTES', JSON.stringify(savedRoutes)); } catch {}
}

function renderSavedRoutes() {
  const listEl = document.getElementById('savedRoutesList');
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
  const fromEl = document.getElementById('from');
  const toEl   = document.getElementById('to');
  if (fromEl) fromEl.value = r.from || '';
  if (toEl)   toEl.value   = r.to   || '';

  if (r.veh) {
    $$('input[name=veh]').forEach(inp => {
      inp.checked = inp.value === r.veh;
      inp.dispatchEvent(new Event('change'));
    });
  }

  viaPoints = [];
  viaMarkers.forEach(removeFromMap);
  viaMarkers = [];

  (r.viaPoints || []).forEach(coords => addViaPoint(coords, { silent: true }));

  fromEl?.dispatchEvent(new Event('input'));
  toEl?.dispatchEvent(new Event('input'));
  await onBuild();
}

function deleteSavedRoute(index) {
  savedRoutes.splice(index, 1);
  writeSavedRoutes();
  renderSavedRoutes();
}

function saveCurrentRoute() {
  const fromVal = document.getElementById('from')?.value.trim();
  const toVal   = document.getElementById('to')?.value.trim();
  if (!fromVal || !toVal) return toast('Заполните адреса для сохранения', 2000);

  const vehChecked = document.querySelector('input[name=veh]:checked');
  const veh = (vehChecked && vehChecked.value) || 'truck40';

  savedRoutes.push({ from: fromVal, to: toVal, viaPoints: viaPoints.slice(), veh });
  writeSavedRoutes();
  renderSavedRoutes();
  toast('Маршрут сохранён', 1600);
}

function encodeSharePayload(data) {
  try {
    const json = JSON.stringify(data);
    const b64  = btoa(unescape(encodeURIComponent(json)));
    return window.location.href.split('#')[0] + '#share=' + b64;
  } catch {
    return '';
  }
}

async function shareCurrentRoute() {
  const fromVal = document.getElementById('from')?.value.trim();
  const toVal   = document.getElementById('to')?.value.trim();
  if (!fromVal || !toVal) return toast('Нет маршрута для создания ссылки', 2000);

  const vehChecked = document.querySelector('input[name=veh]:checked');
  const veh = (vehChecked && vehChecked.value) || 'truck40';

  const link = encodeSharePayload({ from: fromVal, to: toVal, viaPoints: viaPoints.slice(), veh });
  if (!link) return toast('Не удалось создать ссылку', 2000);

  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(link); toast('Ссылка скопирована в буфер обмена', 2000); }
    catch { toast('Ссылка: ' + link, 4000); }
  } else {
    toast('Ссылка: ' + link, 4000);
  }
}

function openInNavigator() {
  const fromVal = document.getElementById('from')?.value.trim();
  const toVal   = document.getElementById('to')?.value.trim();
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

function applyFramesBBox(bbox) {
  if (!layers.frames?.objects) return;
  if (!bbox) {
    layers.frames.objects.setFilter?.(null);
    return;
  }
  const expanded = expandBBox(bbox, 0.02);
  if (!expanded) {
    layers.frames.objects.setFilter?.(null);
    return;
  }
  const [[minLon, minLat], [maxLon, maxLat]] = expanded;
  layers.frames.objects.setFilter(obj => {
    const coords = normalizeCoordPair(obj.geometry?.coordinates);
    if (!coords) return false;
    const [lon, lat] = coords;
    return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
  });
}

function collectRouteGeometryPoints(route) {
  const pts = [];
  if (!route) return pts;
  try {
    route.getPaths?.().each(path => {
      path.getSegments?.().each(segment => {
        const coords = segment.getCoordinates?.();
        if (Array.isArray(coords)) {
          coords.forEach(c => { if (Array.isArray(c)) pts.push(c); });
        }
      });
    });
  } catch {}
  return pts;
}

function refreshFramesForActiveRoute(fallbackPoints) {
  if (isCarMode()) {
    removeFromMap(layers.frames);
    layers.frames?.objects?.setFilter?.(null);
    return;
  }
  const framesToggle = $('#toggle-frames');
  if (!framesToggle?.checked) return;

  let bbox = null;
  const activeRoute = multiRoute?.getActiveRoute?.();
  if (activeRoute) {
    bbox = normalizeBBox(activeRoute.properties?.get?.('boundedBy'));
    if (!bbox && activeRoute.model?.getBounds) bbox = normalizeBBox(activeRoute.model.getBounds());
    if (!bbox && activeRoute.getBounds) bbox = normalizeBBox(activeRoute.getBounds());
    if (!bbox) {
      const geomPts = collectRouteGeometryPoints(activeRoute);
      bbox = bboxFromPoints(geomPts);
    }
  }

  if (!bbox && Array.isArray(fallbackPoints) && fallbackPoints.length) {
    bbox = bboxFromPoints(fallbackPoints);
  }

  if (!bbox) {
    const wpPts = [];
    try {
      const wps = multiRoute?.getWayPoints?.();
      wps?.each(wp => {
        const coords = wp.geometry?.getCoordinates?.();
        if (Array.isArray(coords)) wpPts.push(coords);
      });
    } catch {}
    if (!wpPts.length) {
      wpPts.push(...viaPoints);
    }
    bbox = bboxFromPoints(wpPts);
  }

  applyFramesBBox(bbox);
}

function syncFramesLayerVisibility() {
  const manager = layers.frames;
  const framesToggle = $('#toggle-frames');
  if (!framesToggle || !manager) return;
  const car = isCarMode();
  framesToggle.disabled = car;
  if (car) {
    if (framesToggleStateBeforeCar === null) {
      framesToggleStateBeforeCar = framesToggle.checked;
    }
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
    manager.objects?.setFilter?.(null);
  }
}

function renderRouteList(routes) {
  const listEl = document.getElementById('routeList');
  if (!listEl) return;
  if (!routes || routes.getLength() <= 1) {
    listEl.style.display = 'none';
    listEl.innerHTML = '';
    return;
  }
  listEl.innerHTML = '';
  const arr = [];
  routes.each(r => {
    const d  = r.properties.get('distance') || {};
    const tT = r.properties.get('durationInTraffic') || {};
    const t  = r.properties.get('duration') || {};
    const timeVal = Number(tT.value || t.value || 0);
    arr.push({ r, d, tT, t, timeVal });
  });
  arr.sort((a,b)=>a.timeVal - b.timeVal);
  arr.forEach((o, index) => {
    const distTxt = o.d.text || fmtDist(o.d.value || 0);
    const durTxt  = o.tT.text || o.t.text || fmtTime(o.tT.value || o.t.value || 0);
    const div = document.createElement('div');
    div.className = 'tt-route-item';
    div.dataset.index = index;
    div.innerHTML = `<div><strong>Маршрут ${index + 1}</strong></div><div>${distTxt}, ${durTxt}</div>`;
    div.addEventListener('click', () => { try { multiRoute.setActiveRoute(o.r); } catch {} });
    listEl.appendChild(div);
  });
  listEl.style.display = 'block';
  highlightActiveRouteItem();
}

function highlightActiveRouteItem() {
  const listEl = document.getElementById('routeList');
  if (!listEl || !multiRoute?.getActiveRoute) return;
  const active = multiRoute.getActiveRoute();
  const routes = multiRoute.getRoutes && multiRoute.getRoutes();
  let activeIndex = -1;
  if (routes?.getLength) routes.each((r, idx) => { if (r === active) activeIndex = idx; });
  Array.from(listEl.children).forEach((el, idx) => el.classList.toggle('active', idx === activeIndex));
}

const layers = {
  frames: null,
  hgvAllowed: null,
  hgvConditional: null,
  federal: null,
  roadsHgvUfo: null
};

const layerConfigs = {
  frames: {
    filename: 'frames_ready.geojson',
    friendlyName: 'Весовые рамки',
    options: { preset: 'islands#blueCircleDotIcon', zIndex: 220 }
  },
  hgvAllowed: {
    filename: 'hgv_allowed.geojson',
    friendlyName: 'Разрешённый проезд ТС >3,5т',
    options: { preset: 'islands#darkGreenCircleDotIcon', zIndex: 210 }
  },
  hgvConditional: {
    filename: 'hgv_conditional.geojson',
    friendlyName: 'Условно разрешённый проезд ТС >3,5т',
    options: { preset: 'islands#yellowCircleDotIcon', zIndex: 205 }
  },
  federal: {
    filename: 'federal.geojson',
    friendlyName: 'Федеральные трассы',
    options: { preset: 'islands#grayCircleDotIcon', zIndex: 200 }
  },
  roadsHgvUfo: {
    filename: 'roads_ready_ufo_hgv.geojson',
    friendlyName: 'Дороги ЮФО (HGV)',
    options: { preset: 'islands#orangeStrokeIcon', zIndex: 190 }
  }
};

function applyLayerOptions(manager, options = {}) {
  if (!manager?.objects?.options) return;
  Object.entries(options).forEach(([key, value]) => {
    manager.objects.options.set(key, value);
  });
  manager.objects.options.set({
    strokeColor: '#60a5fa',
    strokeWidth: 3,
    strokeOpacity: 0.9,
    fillOpacity: 0.3
  });
}

function decorateFeatureCollection(fc) {
  if (!fc?.features) return;
  fc.features.forEach(f => {
    if (!f) return;
    const p = f.properties || {};
    const g = f.geometry || {};

    const title =
      p.name ||
      p.title ||
      p.comment_human ||
      (p.object_type === 'frame' ? 'Весовая рамка' : 'Объект');

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
        (extra.length
          ? `<div class="small mt6">${extra.map(escapeHtml).join('<br>')}</div>`
          : '')
    };

    if (
      f.properties.object_type === 'segment' &&
      (g.type === 'LineString' || g.type === 'MultiLineString')
    ) {
      let color = '#9ca3af';

      if (f.properties.hgv_access === 'allowed') {
        color = '#16a34a';
      } else if (f.properties.hgv_access === 'conditional') {
        color = '#eab308';
      } else if (f.properties.hgv_access === 'forbidden') {
        color = '#dc2626';
      }

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
    if (f && (f.id === undefined || f.id === null)) {
      f.id = `${prefix}_${i++}`;
    }
  });
}

export function init() {
  const cfg = (window.TRANSTIME_CONFIG && window.TRANSTIME_CONFIG.yandex) || null;
  if (!cfg?.apiKey) return toast('Ошибка конфигурации: нет API-ключа');

  if (window.__TT_YA_LOADING__) return;
  window.__TT_YA_LOADING__ = true;

  const script = document.createElement('script');
  script.src =
    'https://api-maps.yandex.ru/2.1/?apikey=' + encodeURIComponent(cfg.apiKey) +
    '&lang=' + encodeURIComponent(cfg.lang || 'ru_RU') +
    '&csp=true&coordorder=longlat' +
    '&load=package.full';

  script.onload = () => (window.ymaps && typeof ymaps.ready === 'function')
    ? ymaps.ready(setup)
    : toast('Yandex API не инициализировался');

  script.onerror = () => toast('Не удалось загрузить Yandex Maps');
  document.head.appendChild(script);
}

async function toggleLayer(name, on, checkbox) {
  if (!map) return;
  const cfg = layerConfigs[name];
  const manager = layers[name];
  if (!cfg || !manager) return;

  if (on) {
    const fc = await loadGeoJSON(cfg.filename, cfg.friendlyName);
    if (!Array.isArray(fc.features) || fc.features.length === 0) {
      if (fc.__tt_httpStatus !== 404) {
        toast(`Нет данных слоя: ${cfg.friendlyName}`);
      }
      checkbox && (checkbox.checked = false);
      manager.removeAll?.();
      removeFromMap(manager);
      if (name === 'frames') syncFramesLayerVisibility();
      return;
    }

    normalizeFeatureCollectionCoords(fc);
    if (name === 'frames') fc.features = fc.features.filter(f => f?.geometry?.type === 'Point');

    ensureFeatureIds(fc, name);
    decorateFeatureCollection(fc);
    delete fc.__tt_httpStatus;
    manager.removeAll?.();
    manager.add(fc);
    addToMap(manager);
    if (name === 'frames') {
      refreshFramesForActiveRoute();
      syncFramesLayerVisibility();
    }
  } else {
    removeFromMap(manager);
    if (name === 'frames' && manager.objects?.setFilter) manager.objects.setFilter(null);
    if (name === 'frames') syncFramesLayerVisibility();
  }
}

function setup() {
  const cfg = window.TRANSTIME_CONFIG || {};
  const center = (cfg.map && cfg.map.center) || [55.751244, 37.618423];
  const zoom   = (cfg.map && cfg.map.zoom)   || 8;

  if (!document.getElementById('map')) return toast('Не найден контейнер #map', 2500);

  map = new ymaps.Map('map', { center, zoom, controls: ['zoomControl', 'typeSelector'] }, { suppressMapOpenBlock: true });

  try {
    trafficControl = new ymaps.control.TrafficControl({ state: { providerKey: 'traffic#actual', trafficShown: true, infoLayerShown: true } });
    map.controls.add(trafficControl, { float: 'right' });
  } catch {}

  try {
    const key = 'TT_MAP_VIEW';
    const saved = localStorage.getItem(key);
    if (saved) {
      const v = JSON.parse(saved);
      if (Array.isArray(v.center) && typeof v.zoom === 'number') map.setCenter(v.center, v.zoom, { duration: 0 });
    }
    map.events.add('boundschange', ()=>{
      const c = map.getCenter(); const z = map.getZoom();
      localStorage.setItem(key, JSON.stringify({ center: c, zoom: z }));
    });
  } catch {}

  Object.entries(layerConfigs).forEach(([name, cfg]) => {
    const manager = new ymaps.ObjectManager({ clusterize: false });
    layers[name] = manager;
    applyLayerOptions(manager, cfg.options);
  });

  const from = $('#from');
  const to   = $('#to');
  const buildBtn = $('#buildBtn');
  const clearVia = $('#clearVia');
  const vehRadios = $$('input[name=veh]');

  const saveRouteBtn   = $('#saveRouteBtn');
  const shareRouteBtn  = $('#shareRouteBtn');
  const openNavBtn     = $('#openNavBtn');

  loadSavedRoutes();
  renderSavedRoutes();

  saveRouteBtn?.addEventListener('click', saveCurrentRoute);
  shareRouteBtn?.addEventListener('click', shareCurrentRoute);
  openNavBtn?.addEventListener('click', openInNavigator);

  const cFrames    = $('#toggle-frames');
  const cHgvA      = $('#toggle-hgv-allowed');
  const cHgvC      = $('#toggle-hgv-conditional');
  const cFed       = $('#toggle-federal');
  const cTraffic   = $('#toggle-traffic');
  const cEvents    = $('#toggle-events');
  const cRoadsHgv  = $('#toggle-roads-hgv');
  const viaModeBtn = $('#viaModeBtn');

  updateUI = function updateUI() {
    const hasFrom = !!from?.value.trim();
    const hasTo   = !!to?.value.trim();

    if (buildBtn) {
      buildBtn.disabled = !(hasFrom && hasTo);
      buildBtn.title = buildBtn.disabled ? 'Укажите пункты A и B' : '';
      buildBtn.classList.toggle('highlight', !buildBtn.disabled);
    }
    if (clearVia) {
      clearVia.disabled = viaPoints.length === 0;
      clearVia.title = clearVia.disabled ? 'Нет промежуточных точек для сброса' : '';
    }
  };
  function updateVehGroup() {
    vehRadios.forEach(r => r.parentElement.classList.toggle('active', r.checked));
  }
  function handleVehicleChange() {
    updateVehGroup();
    syncFramesLayerVisibility();
  }

  [from, to].forEach(inp => inp?.addEventListener('input', updateUI));
  vehRadios.forEach(radio => radio.addEventListener('change', handleVehicleChange));

  cFrames?.addEventListener('change', e =>
    toggleLayer('frames', e.target.checked, cFrames)
  );
  cHgvA?.addEventListener('change', e =>
    toggleLayer('hgvAllowed', e.target.checked, cHgvA)
  );
  cHgvC?.addEventListener('change', e =>
    toggleLayer('hgvConditional', e.target.checked, cHgvC)
  );
  cFed?.addEventListener('change', e =>
    toggleLayer('federal', e.target.checked, cFed)
  );
  cRoadsHgv?.addEventListener('change', e =>
    toggleLayer('roadsHgvUfo', e.target.checked, cRoadsHgv)
  );

  if (cTraffic) {
    window.__tt_setTraffic = function (on) {
      try { trafficControl?.state.set('trafficShown', !!on); } catch {}
    };
    window.__tt_setTraffic(cTraffic.checked);
    cTraffic.addEventListener('change', () =>
      window.__tt_setTraffic(cTraffic.checked)
    );
  }

  if (cEvents) {
    window.__tt_setEvents = function (on) {
      try { trafficControl?.state.set('infoLayerShown', !!on); } catch {}
    };
    window.__tt_setEvents(cEvents.checked);
    cEvents.addEventListener('change', () =>
      window.__tt_setEvents(cEvents.checked)
    );
  }

  if (cHgvA?.checked)      toggleLayer('hgvAllowed', true, cHgvA);
  if (cFrames?.checked)    toggleLayer('frames', true, cFrames);
  if (cHgvC?.checked)      toggleLayer('hgvConditional', true, cHgvC);
  if (cFed?.checked)       toggleLayer('federal', true, cFed);
  if (cRoadsHgv?.checked)  toggleLayer('roadsHgvUfo', true, cRoadsHgv);

  viaModeBtn?.classList.toggle('active', viaMode);
  viaModeBtn?.addEventListener('click', () => {
    viaMode = !viaMode;
    viaModeBtn.classList.toggle('active', viaMode);
    toast(
      viaMode
        ? 'Режим точек по пути включен. Клик по карте добавит точку'
        : 'Режим точек по пути выключен',
      1800
    );
  });

  map.events.add('click', (e) => {
    if (!viaMode) return;
    const coords = e.get('coords');
    const added = addViaPoint(coords);
    if (added) rebuildRouteIfReady();
  });

  buildBtn?.addEventListener('click', onBuild);
  clearVia?.addEventListener('click', () => {
    viaPoints = [];
    viaMarkers.forEach(removeFromMap);
    viaMarkers = [];
    toast('Точки по пути очищены', 1200);
    updateUI();
    rebuildRouteIfReady();
  });

  updateUI();
  updateVehGroup();
  syncFramesLayerVisibility();
}

async function buildRouteWithState() {
  if (isBuilding) return;
  const buildBtn = document.getElementById('buildBtn');
  buildBtn?.setAttribute('disabled','disabled');
  isBuilding = true;

  try {
    const checked = document.querySelector('input[name=veh]:checked');
    const mode = (checked && checked.value) || 'truck40';
    const opts = { mode: 'truck' };
    if (mode === 'car') opts.mode = 'auto';
    if (mode === 'truck40') opts.weight = 40000;
    if (mode === 'truckHeavy') opts.weight = 55000;

    const fromVal = $('#from')?.value.trim();
    const toVal   = $('#to')?.value.trim();
    if (!fromVal || !toVal) throw new Error('Укажите адреса Откуда и Куда');

    const A = await YandexRouter.geocode(fromVal);
    const B = await YandexRouter.geocode(toVal);
    const points = [A, ...viaPoints, B];

    const res = await YandexRouter.build(points, opts);
    const mr = res.multiRoute;
    const routes = res.routes;

    const prevMultiRoute = multiRoute;
    if (prevMultiRoute) {
      if (activeRouteChangeHandler && prevMultiRoute.events?.remove) {
        try { prevMultiRoute.events.remove('activeroutechange', activeRouteChangeHandler); } catch {}
      }
      removeFromMap(prevMultiRoute);
    }
    multiRoute = mr;
    addToMap(multiRoute);

    if (activeRouteChangeHandler && multiRoute?.events?.remove) {
      try { multiRoute.events.remove('activeroutechange', activeRouteChangeHandler); } catch {}
    }

    renderRouteList(routes);
    highlightActiveRouteItem();
    refreshFramesForActiveRoute(points);

    if (multiRoute?.events?.add) {
      activeRouteChangeHandler = () => {
        highlightActiveRouteItem();
        refreshFramesForActiveRoute(points);
      };
      multiRoute.events.add('activeroutechange', activeRouteChangeHandler);
    } else {
      activeRouteChangeHandler = null;
    }

    toast('Маршрут успешно построен', 1800);
    return mr;
  } finally {
    buildBtn?.removeAttribute('disabled');
    isBuilding = false;
  }
}

async function onBuild() {
  try {
    await buildRouteWithState();
  } catch (e) {
    toast(typeof e === 'string' ? e : (e.message || 'Ошибка построения маршрута'));
  }
}

if (typeof window !== 'undefined') {
  window.buildRouteWithState = buildRouteWithState;
  window.onBuild = onBuild;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { try { init(); } catch (e) { console.error(e); } });
  } else {
    try { init(); } catch (e) { console.error(e); }
  }
}
