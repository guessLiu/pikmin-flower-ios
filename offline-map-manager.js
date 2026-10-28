(function () {
  'use strict';

  const META_KEY = 'pikmin-flower-ios-map-profiles-v1';
  const ACTIVE_KEY = 'pikmin-flower-ios-active-map-v1';
  const SPOTS_PREFIX = 'pikmin-flower-ios-spots-v2-';
  const DB_NAME = 'pikmin-flower-ios-offline-maps-v1';
  const DB_VERSION = 1;
  const STORE_NAME = 'datasets';
  const MAX_MAPS = 3;
  const MAX_DATA_BYTES = 15 * 1024 * 1024;
  const DEFAULT_ID = 'default';
  const DEFAULT_CENTER = [25.005022, 121.514369];
  const DEFAULT_BOUNDS = [[24.986, 121.491], [25.024, 121.537]];
  const LEGACY_SPOT_KEYS = [
    'pikmin-flower-ios-spots-v1',
    'pikmin-flower-spots-v2',
    'pikmin-flower-route-v1'
  ];
  const ALLOWED_TAGS = new Set([
    'name', 'name:zh', 'highway', 'railway', 'waterway', 'natural',
    'landuse', 'leisure', 'bridge', 'tunnel'
  ]);

  class OfflineMapManager {
    constructor(options = {}) {
      this.builtInData = options.builtInData || null;
      this.profiles = [];
      this.activeMapId = DEFAULT_ID;
      this._dbPromise = null;
    }

    async initialize() {
      this.profiles = this._loadProfiles();
      this.activeMapId = localStorage.getItem(ACTIVE_KEY) || DEFAULT_ID;
      if (!this.profiles.some(profile => profile.id === this.activeMapId)) {
        this.activeMapId = DEFAULT_ID;
      }
      this._migrateLegacySpots();
      this._saveProfiles();
      localStorage.setItem(ACTIVE_KEY, this.activeMapId);
      return this.activeProfile;
    }

    get activeProfile() {
      return this.profiles.find(profile => profile.id === this.activeMapId) || this.profiles[0];
    }

    get defaultProfile() {
      return this.profiles.find(profile => profile.id === DEFAULT_ID);
    }

    get canAddMap() {
      return this.profiles.length < MAX_MAPS;
    }

    get replaceableProfiles() {
      return this.profiles.filter(profile => !profile.builtIn);
    }

    async getMapData(mapId) {
      const profile = this.profiles.find(item => item.id === mapId);
      if (!profile) throw new Error('找不到指定的離線地圖。');
      if (profile.builtIn) {
        if (!this.builtInData) throw new Error('找不到原始離線地圖資料。');
        return this.builtInData;
      }
      const data = await this._getDataset(mapId);
      if (!data) throw new Error('這組離線地圖資料已遺失，請刪除後重新下載。');
      return data;
    }

    getSpots(mapId = this.activeMapId) {
      try {
        const value = JSON.parse(localStorage.getItem(this._spotKey(mapId)) || '[]');
        return Array.isArray(value) ? value : [];
      } catch {
        return [];
      }
    }

    saveSpots(spots, mapId = this.activeMapId) {
      localStorage.setItem(this._spotKey(mapId), JSON.stringify(spots));
    }

    setActive(mapId) {
      if (!this.profiles.some(profile => profile.id === mapId)) {
        throw new Error('找不到指定的離線地圖。');
      }
      this.activeMapId = mapId;
      localStorage.setItem(ACTIVE_KEY, mapId);
      return this.activeProfile;
    }

    saveView(mapId, center, zoom) {
      const profile = this.profiles.find(item => item.id === mapId);
      if (!profile || !Array.isArray(center)) return;
      profile.viewCenter = [Number(center[0]), Number(center[1])];
      profile.zoom = Math.max(14, Math.min(19, Number(zoom) || 16));
      profile.lastUsedAt = Date.now();
      this._saveProfiles();
    }

    async createMap({ name, lat, lng, radiusKm = 3, replaceId = null, onStatus = () => {} }) {
      lat = Number(lat);
      lng = Number(lng);
      radiusKm = Number(radiusKm);
      if (!validLatLng(lat, lng)) throw new Error('請輸入正確的中心經緯度。');
      if (![2, 3, 4].includes(radiusKm)) throw new Error('離線範圍只支援 2、3 或 4 公里。');
      if (!this.canAddMap) {
        const replacement = this.profiles.find(profile => profile.id === replaceId && !profile.builtIn);
        if (!replacement) throw new Error('已達三組上限，請選擇要取代的自訂地圖。');
      }

      const bounds = boundsFor(lat, lng, radiusKm);
      onStatus('正在向地圖服務取得資料，通常需要 10～60 秒…');
      const data = await this._downloadMapData(bounds);
      const serialized = JSON.stringify(data);
      const sizeBytes = new Blob([serialized]).size;
      if (!data.features.length) throw new Error('這個範圍沒有取得可用地圖資料，請稍後再試。');
      if (sizeBytes > MAX_DATA_BYTES) {
        throw new Error(`地圖資料 ${formatBytes(sizeBytes)} 太大，請改選較小範圍。`);
      }

      onStatus(`已取得 ${data.features.length.toLocaleString()} 個圖徵，正在儲存離線地圖…`);
      const id = makeId('map');
      const now = Date.now();
      const profile = {
        id,
        name: String(name || '').trim().slice(0, 20) || `地圖 ${this.profiles.length + 1}`,
        center: [lat, lng],
        viewCenter: [lat, lng],
        bounds,
        radiusKm,
        zoom: 16,
        builtIn: false,
        sizeBytes,
        featureCount: data.features.length,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: now
      };

      await this._putDataset(id, data);
      const oldProfiles = [...this.profiles];
      const oldActive = this.activeMapId;
      let replaced = null;
      try {
        if (this.canAddMap) {
          this.profiles = [...this.profiles, profile];
        } else {
          const index = this.profiles.findIndex(item => item.id === replaceId && !item.builtIn);
          if (index < 0) throw new Error('找不到要取代的自訂地圖。');
          replaced = this.profiles[index];
          this.profiles = this.profiles.map((item, itemIndex) => itemIndex === index ? profile : item);
        }
        this.activeMapId = id;
        this._saveProfiles();
        localStorage.setItem(ACTIVE_KEY, id);
      } catch (error) {
        this.profiles = oldProfiles;
        this.activeMapId = oldActive;
        await this._deleteDataset(id).catch(() => {});
        throw error;
      }

      if (replaced) {
        await this._deleteDataset(replaced.id).catch(() => {});
        localStorage.removeItem(this._spotKey(replaced.id));
      }
      this._requestPersistence();
      return profile;
    }

    async deleteMap(mapId) {
      const profile = this.profiles.find(item => item.id === mapId);
      if (!profile) return this.activeProfile;
      if (profile.builtIn) throw new Error('原始地圖是離線備用地圖，不能刪除。');
      this.profiles = this.profiles.filter(item => item.id !== mapId);
      if (this.activeMapId === mapId) this.activeMapId = DEFAULT_ID;
      this._saveProfiles();
      localStorage.setItem(ACTIVE_KEY, this.activeMapId);
      await this._deleteDataset(mapId).catch(() => {});
      localStorage.removeItem(this._spotKey(mapId));
      return this.activeProfile;
    }

    async storageEstimate() {
      if (!navigator.storage?.estimate) return null;
      try {
        const estimate = await navigator.storage.estimate();
        return { usage: Number(estimate.usage) || 0, quota: Number(estimate.quota) || 0 };
      } catch {
        return null;
      }
    }

    _loadProfiles() {
      let stored = [];
      try {
        const value = JSON.parse(localStorage.getItem(META_KEY) || '[]');
        if (Array.isArray(value)) stored = value.map(normalizeProfile).filter(Boolean);
      } catch {}

      const custom = stored.filter(profile => !profile.builtIn && profile.id !== DEFAULT_ID).slice(0, MAX_MAPS - 1);
      const existingDefault = stored.find(profile => profile.id === DEFAULT_ID);
      const defaultProfile = {
        id: DEFAULT_ID,
        name: '原始地圖',
        center: [...DEFAULT_CENTER],
        viewCenter: existingDefault?.viewCenter || [...DEFAULT_CENTER],
        bounds: DEFAULT_BOUNDS.map(point => [...point]),
        radiusKm: 2,
        zoom: existingDefault?.zoom || 16,
        builtIn: true,
        sizeBytes: 0,
        featureCount: Number(this.builtInData?.features?.length) || 0,
        createdAt: existingDefault?.createdAt || Date.now(),
        updatedAt: existingDefault?.updatedAt || Date.now(),
        lastUsedAt: existingDefault?.lastUsedAt || Date.now()
      };
      return [defaultProfile, ...custom];
    }

    _migrateLegacySpots() {
      const target = this._spotKey(DEFAULT_ID);
      if (localStorage.getItem(target) !== null) return;
      for (const key of LEGACY_SPOT_KEYS) {
        try {
          const value = JSON.parse(localStorage.getItem(key) || 'null');
          if (Array.isArray(value)) {
            localStorage.setItem(target, JSON.stringify(value));
            return;
          }
        } catch {}
      }
      localStorage.setItem(target, '[]');
    }

    _saveProfiles() {
      localStorage.setItem(META_KEY, JSON.stringify(this.profiles));
    }

    _spotKey(mapId) {
      return `${SPOTS_PREFIX}${mapId}`;
    }

    async _downloadMapData(bounds) {
      const [[south, west], [north, east]] = bounds;
      const bbox = `${south},${west},${north},${east}`;
      const query = `[out:json][timeout:90];(\n` +
        `way["highway"](${bbox});\n` +
        `way["railway"](${bbox});\n` +
        `way["waterway"](${bbox});\n` +
        `way["natural"="water"](${bbox});\n` +
        `way["landuse"~"grass|recreation_ground|forest|cemetery"](${bbox});\n` +
        `way["leisure"~"park|pitch|playground|garden"](${bbox});\n` +
        `);out geom;`;
      const endpoint = window.PIKMIN_OVERPASS_ENDPOINT || 'https://overpass-api.de/api/interpreter';
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);
      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: `data=${encodeURIComponent(query)}`,
          signal: controller.signal
        });
      } catch (error) {
        if (error?.name === 'AbortError') throw new Error('下載超過兩分鐘，請稍後再試或縮小範圍。');
        throw new Error('無法連上地圖下載服務，請確認網路後再試。');
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) throw new Error(`地圖下載服務暫時無法使用（${response.status}）。`);
      let source;
      try {
        source = JSON.parse(await response.text());
      } catch {
        throw new Error('下載的地圖資料格式不正確，請稍後再試。');
      }
      return overpassToGeoJson(source);
    }

    async _openDb() {
      if (!('indexedDB' in window)) throw new Error('此瀏覽器不支援離線地圖儲存。');
      if (this._dbPromise) return this._dbPromise;
      this._dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('無法開啟離線地圖資料庫。'));
      });
      return this._dbPromise;
    }

    async _getDataset(id) {
      const db = await this._openDb();
      return new Promise((resolve, reject) => {
        const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    }

    async _putDataset(id, data) {
      const db = await this._openDb();
      return new Promise((resolve, reject) => {
        const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(data, id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error || new Error('離線地圖儲存失敗。'));
      });
    }

    async _deleteDataset(id) {
      const db = await this._openDb();
      return new Promise((resolve, reject) => {
        const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }

    _requestPersistence() {
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    }
  }

  function normalizeProfile(value) {
    const center = Array.isArray(value?.center) ? value.center.map(Number) : [];
    const bounds = Array.isArray(value?.bounds) ? value.bounds.map(point => point.map(Number)) : [];
    if (!value?.id || !validLatLng(center[0], center[1]) || bounds.length !== 2) return null;
    return {
      id: String(value.id),
      name: String(value.name || '離線地圖').slice(0, 20),
      center,
      viewCenter: Array.isArray(value.viewCenter) && validLatLng(Number(value.viewCenter[0]), Number(value.viewCenter[1]))
        ? value.viewCenter.map(Number) : [...center],
      bounds,
      radiusKm: Number(value.radiusKm) || 3,
      zoom: Math.max(14, Math.min(19, Number(value.zoom) || 16)),
      builtIn: Boolean(value.builtIn),
      sizeBytes: Number(value.sizeBytes) || 0,
      featureCount: Number(value.featureCount) || 0,
      createdAt: Number(value.createdAt) || Date.now(),
      updatedAt: Number(value.updatedAt) || Date.now(),
      lastUsedAt: Number(value.lastUsedAt) || Date.now()
    };
  }

  function overpassToGeoJson(source) {
    const features = [];
    for (const element of source?.elements || []) {
      const geometry = Array.isArray(element.geometry) ? element.geometry : [];
      if (geometry.length < 2) continue;
      const coordinates = geometry
        .map(point => [Number(point.lon), Number(point.lat)])
        .filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
      if (coordinates.length < 2) continue;
      const tags = element.tags || {};
      const properties = {};
      for (const [key, value] of Object.entries(tags)) {
        if (ALLOWED_TAGS.has(key)) properties[key] = value;
      }
      properties.osm_id = element.id;
      const first = coordinates[0];
      const last = coordinates[coordinates.length - 1];
      const closed = first[0] === last[0] && first[1] === last[1];
      const isArea = closed && ['natural', 'landuse', 'leisure'].some(key => key in tags);
      features.push({
        type: 'Feature',
        properties,
        geometry: {
          type: isArea ? 'Polygon' : 'LineString',
          coordinates: isArea ? [coordinates] : coordinates
        }
      });
    }
    return { type: 'FeatureCollection', features };
  }

  function boundsFor(lat, lng, radiusKm) {
    const latDelta = radiusKm / 111.32;
    const cosLat = Math.max(0.2, Math.cos(lat * Math.PI / 180));
    const lngDelta = radiusKm / (111.32 * cosLat);
    return [
      [roundCoord(lat - latDelta), roundCoord(lng - lngDelta)],
      [roundCoord(lat + latDelta), roundCoord(lng + lngDelta)]
    ];
  }

  function validLatLng(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  }

  function roundCoord(value) {
    return Number(value.toFixed(6));
  }

  function makeId(prefix) {
    const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${id}`;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '內建';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  OfflineMapManager.MAX_MAPS = MAX_MAPS;
  OfflineMapManager.DEFAULT_ID = DEFAULT_ID;
  OfflineMapManager.DEFAULT_CENTER = DEFAULT_CENTER;
  OfflineMapManager.DEFAULT_BOUNDS = DEFAULT_BOUNDS;
  OfflineMapManager.boundsFor = boundsFor;
  OfflineMapManager.formatBytes = formatBytes;
  window.OfflineMapManager = OfflineMapManager;
})();
