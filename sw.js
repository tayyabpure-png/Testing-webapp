// ╔══════════════════════════════════════════════════════════════════╗
// ║         SAHI PIZZA CABIN POINT — Service Worker v1.0            ║
// ║         Offline-First PWA with Background Sync                  ║
// ╚══════════════════════════════════════════════════════════════════╝

const CACHE_NAME = 'sahi-pizza-v1';
const SYNC_TAG = 'sync-pending-orders';

// Assets to pre-cache on install
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  // Google Fonts are cached at runtime (see fetch handler below)
];

// ── INSTALL: Pre-cache shell assets ──────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_ASSETS);
    }).then(() => self.skipWaiting()) // Activate immediately
  );
});

// ── ACTIVATE: Clean up old caches ────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim()) // Take control of all open tabs
  );
});

// ── FETCH: Serve from cache, fall back to network ────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Don't intercept AppScript POSTs — let IndexedDB handle those
  if (url.href.includes('script.google.com')) return;

  // Don't intercept non-GET requests
  if (request.method !== 'GET') return;

  // Strategy: Cache-First for same-origin assets, Network-First for Google Fonts
  if (url.origin === location.origin || url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (!response || response.status !== 200 || response.type === 'error') {
            return response;
          }
          // Cache a clone for future offline use
          const toCache = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, toCache));
          return response;
        }).catch(() => {
          // Offline & not in cache — return the main HTML shell as fallback
          if (request.destination === 'document') {
            return caches.match('/index.html') || caches.match('/');
          }
        });
      })
    );
  }
});

// ── BACKGROUND SYNC: Flush pending orders when online ────────────────
self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(flushPendingOrders());
  }
});

// ── MESSAGE: Manual sync trigger from the page ───────────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'MANUAL_SYNC') {
    flushPendingOrders().then(() => {
      // Notify all clients that sync is complete
      self.clients.matchAll().then(clients =>
        clients.forEach(c => c.postMessage({ type: 'SYNC_COMPLETE' }))
      );
    });
  }
});

// ── FLUSH: Read IndexedDB and POST each pending order ─────────────────
async function flushPendingOrders() {
  const GAS_URL = 'https://script.google.com/macros/s/AKfycbxZzXp30LvCS2HJO3VpPH0h6HoY2hcNlQcw5CHvSV6AQRi4svIpAo3_ESDleMWBIoBmWg/exec';

  let db;
  try {
    db = await openDB();
  } catch (e) {
    console.warn('[SW] IndexedDB unavailable, skipping sync:', e);
    return;
  }

  const pendingOrders = await getAllPending(db);
  if (!pendingOrders.length) return;

  console.log(`[SW] Syncing ${pendingOrders.length} pending order(s)...`);

  for (const order of pendingOrders) {
    try {
      var url = GAS_URL + '?data=' + encodeURIComponent(JSON.stringify({ ...order.payload, synced_from_queue: true }));
      await fetch(url, { method: 'GET', mode: 'no-cors' });
      // Mark as synced — remove from IndexedDB
      await deleteOrder(db, order.id);
      console.log(`[SW] Order #${order.id} synced ✓`);
    } catch (e) {
      console.warn(`[SW] Failed to sync order #${order.id}:`, e);
      // Leave it pending — will retry on next sync event
    }
  }

  // Notify clients to refresh their pending count
  self.clients.matchAll().then(clients =>
    clients.forEach(c => c.postMessage({ type: 'SYNC_COMPLETE' }))
  );
}

// ── IndexedDB helpers (Service Worker scope) ──────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('SahiPizzaDB', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('orders')) {
        const store = db.createObjectStore('orders', { keyPath: 'id', autoIncrement: true });
        store.createIndex('status', 'status', { unique: false });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function getAllPending(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('orders', 'readonly');
    const index = tx.objectStore('orders').index('status');
    const req = index.getAll('pending');
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function deleteOrder(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('orders', 'readwrite');
    const req = tx.objectStore('orders').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = e => reject(e.target.error);
  });
}
