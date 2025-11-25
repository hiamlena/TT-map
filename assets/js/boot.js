/**
 * boot.js — основной модуль приложения Trans-Time
 * Инициализирует карту, обработчики, маршрут и слой весовых рамок
 */

// Глобальная переменная для хранения карты
window.ttMap = null;
// Функция построения маршрута (заглушка, будет определена ниже)
window.buildRoute = null;

/**
 * Загружает и отображает весовые рамки на карте, если включён слой #toggle-frames
 * Использует GeoJSON из /data/frames.geojson
 * Автоматически перезагружает при изменении чекбокса или построении маршрута
 */
let ttFramesLayer = null;

function loadWeightFrames() {
  // Удаляем предыдущий слой, если он есть
  if (ttFramesLayer) {
    window.ttMap.geoObjects.remove(ttFramesLayer);
    ttFramesLayer = null;
  }

  // Получаем чекбокс
  const checkbox = document.getElementById('toggle-frames');
  if (!checkbox || !checkbox.checked) return; // Если выключен — не загружаем

  // Асинхронная загрузка GeoJSON
  fetch('./data/frames.geojson')
    .then(response => {
      if (!response.ok) throw new Error('Не удалось загрузить frames.geojson');
      return response.json();
    })
    .then(data => {
      // Создаём коллекцию объектов
      ttFramesLayer = new ymaps.GeoObjectCollection(null, {
        preset: 'islands#redTruckIcon',
        iconCaptionMaxWidth: '120'
      });

      // Добавляем каждую точку
      data.features.forEach(feature => {
        const coords = feature.geometry.coordinates; // [lon, lat]
        const props = feature.properties || {};
        const obj = new ymaps.Placemark(coords, {
          balloonContent: props.balloonContent || '',
          iconCaption: props.iconCaption || ''
        });
        ttFramesLayer.add(obj);
      });

      // Добавляем слой на карту
      window.ttMap.geoObjects.add(ttFramesLayer);
    })
    .catch(err => {
      console.error('Ошибка при загрузке весовых рамок:', err);
    });
}

// Подписываемся на изменение чекбокса
document.addEventListener('DOMContentLoaded', () => {
  const framesToggle = document.getElementById('toggle-frames');
  if (framesToggle) {
    framesToggle.addEventListener('change', loadWeightFrames);
  }

  // Кнопка "Построить маршрут"
  const buildBtn = document.getElementById('buildBtn');
  if (buildBtn) {
    buildBtn.addEventListener('click', () => {
      // Проверим, определена ли buildRoute, или вызовем клик по костылю
      if (typeof window.onBuild === 'function') {
        window.onBuild();
      } else {
        // Имитируем построение, если нет своей логики
        buildRoute();
      }
    });
  }

  // Поля ввода
  ['from', 'to'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', () => {
        const from = document.getElementById('from').value.trim();
        const to = document.getElementById('to').value.trim();
        document.getElementById('buildBtn').disabled = !(from && to);
      });
    }
  });
});

// Инициализация карты после загрузки API
ymaps.ready(init);

function init() {
  // Создаём карту
  window.ttMap = new ymaps.Map('map', {
    center: window.TRANSTIME_CONFIG.map.center,
    zoom: window.TRANSTIME_CONFIG.map.zoom,
    controls: ['zoomControl', 'fullscreenControl']
  });

  // Инициализация подсказок
  if (document.getElementById('from')) {
    new ymaps.SuggestView('from');
  }
  if (document.getElementById('to')) {
    new ymaps.SuggestView('to');
  }

  // Назначаем функцию построения маршрута
  window.buildRoute = function () {
    const from = document.getElementById('from').value.trim();
    const to = document.getElementById('to').value.trim();

    if (!from || !to) {
      alert('Введите "Откуда" и "Куда"');
      return;
    }

    // Параметры в зависимости от типа ТС
    const veh = document.querySelector('input[name="veh"]:checked')?.value || 'car';
    const isTruck = veh === 'truck40' || veh === 'truckHeavy';

    const routingMode = isTruck ? 'truck' : 'auto';
    const params = {
      routingMode: routingMode,
      results: 3,
      requestTimeout: 10000,
      avoidTrafficJams: true,
      strictBounds: false
    };

    if (isTruck) {
      params.vehicleHeight = parseFloat(document.getElementById('truckHeight')?.value) || 4.0;
      params.vehicleWidth = parseFloat(document.getElementById('truckWidth')?.value) || 2.55;
      params.vehicleLength = parseFloat(document.getElementById('truckLength')?.value) || 16;
      params.vehicleWeight = parseFloat(document.getElementById('truckWeight')?.value) || 40;
    }

    // Удаляем старый маршрут
    if (window.ttRoute) {
      window.ttMap.geoObjects.remove(window.ttRoute);
    }

    // Строим маршрут
    ymaps.route([from, to], params).then(route => {
      window.ttRoute = route;
      window.ttMap.geoObjects.add(route);

      // Центрируем на маршрут
      window.ttMap.setBounds(route.getBounds(), {
        checkZoomRange: true,
        duration: 500
      });

      // ✅ После построения маршрута — загружаем весовые рамки
      loadWeightFrames();

      // Показываем информацию (если нужно)
      showRouteInfo(route);
    }).catch(err => {
      alert('Ошибка построения маршрута: ' + err.message);
    });
  };

  // Первоначальная загрузка рамок, если чекбокс уже включён
  if (document.getElementById('toggle-frames')?.checked) {
    loadWeightFrames();
  }
}

// Пример вывода информации о маршруте (опционально)
function showRouteInfo(route) {
  const activeRoute = route.getRoutes()[0];
  const duration = Math.round(activeRoute.properties.get('duration').value / 60);
  const durationWithTraffic = Math.round(activeRoute.properties.get('durationWithTraffic').value / 60);
  const distance = (activeRoute.properties.get('distance').value / 1000).toFixed(1);

  const routeList = document.getElementById('routeList');
  routeList.style.display = 'block';
  routeList.innerHTML = `
    <div class="tt-route-item tt-route-active">
      <div class="tt-route-header">Маршрут построен</div>
      <div class="tt-route-summary">
        🕒 <b>${durationWithTraffic} мин</b> (с пробками)<br>
        🚗 ${duration} мин (без пробок)<br>
        🛣️ ${distance} км
      </div>
    </div>
  `;
}

