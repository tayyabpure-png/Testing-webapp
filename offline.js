// ╔══════════════════════════════════════════════════════════════════╗
// ║    SAHI PIZZA — Offline-First Order Engine  (offline.js)        ║
// ║    Drop this <script src="offline.js"> just before </body>      ║
// ╚══════════════════════════════════════════════════════════════════╝

// ────────────────────────────────────────────────────────────────────
//  0. CONFIG
// ────────────────────────────────────────────────────────────────────
const GAS_URL = 'https://script.google.com/macros/s/AKfycbz0y91fi5PYyLN2n_EWUK_AscVD_nTTODZj4qHsPRcthtNoe69j29it4fzEtTd_tebg-A/exec';
const SW_SYNC_TAG = 'sync-pending-orders';
const DB_NAME = 'SahiPizzaDB';
const DB_VERSION = 1;

// ────────────────────────────────────────────────────────────────────
//  1. IndexedDB — open / CRUD helpers
// ────────────────────────────────────────────────────────────────────
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('orders')) {
        const store = db.createObjectStore('orders', { keyPath: 'id', autoIncrement: true });
        store.createIndex('status', 'status', { unique: false });
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = e => reject(e.target.error);
  });
}

async function saveOrderToDB(payload) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('orders', 'readwrite');
    const req = tx.objectStore('orders').add({
      payload,
      status: 'pending',
      savedAt: new Date().toISOString()
    });
    req.onsuccess = e => resolve(e.target.result); // returns generated id
    req.onerror = e => reject(e.target.error);
  });
}

async function getPendingOrders() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('orders', 'readonly');
    const req = tx.objectStore('orders').index('status').getAll('pending');
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function deleteOrderFromDB(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('orders', 'readwrite');
    const req = tx.objectStore('orders').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = e => reject(e.target.error);
  });
}

async function getPendingCount() {
  const orders = await getPendingOrders();
  return orders.length;
}

// ────────────────────────────────────────────────────────────────────
//  2. UI STATUS INDICATOR
//     Injects a floating pill into the DOM automatically.
// ────────────────────────────────────────────────────────────────────
(function injectStatusIndicator() {
  const style = document.createElement('style');
  style.textContent = `
    #pwa-status {
      position: fixed;
      bottom: 90px;         /* sits above the cart bar */
      right: 12px;
      z-index: 9999;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 7px 12px;
      border-radius: 20px;
      font-family: 'Nunito', sans-serif;
      font-size: 11.5px;
      font-weight: 800;
      box-shadow: 0 4px 14px rgba(0,0,0,.22);
      cursor: pointer;
      transition: opacity .3s, transform .3s;
      user-select: none;
      -webkit-tap-highlight-color: transparent;
      max-width: 180px;
      white-space: nowrap;
      overflow: hidden;
    }
    #pwa-status.online {
      background: #16a34a;
      color: #fff;
    }
    #pwa-status.offline {
      background: #dc2626;
      color: #fff;
    }
    #pwa-status.syncing {
      background: #d97706;
      color: #fff;
    }
    #pwa-status .dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: rgba(255,255,255,.85);
      flex-shrink: 0;
      animation: pw-blink 1.6s infinite;
    }
    #pwa-status.online .dot { animation: none; opacity: 1; }
    #pwa-status.syncing .dot { animation: pw-spin 0.8s linear infinite; border-radius: 0; clip-path: none; background: none; border: 2px solid rgba(255,255,255,.6); border-top-color: #fff; }
    @keyframes pw-blink { 0%,100%{opacity:1} 50%{opacity:.3} }
    #pwa-status .badge {
      background: rgba(255,255,255,.28);
      border-radius: 10px;
      padding: 1px 6px;
      font-size: 10.5px;
      font-weight: 900;
    }
    /* Sync tooltip on tap */
    #pwa-status-tip {
      position: fixed;
      bottom: 136px;
      right: 12px;
      z-index: 9998;
      background: rgba(0,0,0,.82);
      color: #fff;
      font-family: 'Nunito', sans-serif;
      font-size: 11px;
      font-weight: 700;
      padding: 6px 11px;
      border-radius: 10px;
      pointer-events: none;
      opacity: 0;
      transition: opacity .25s;
      max-width: 200px;
      text-align: center;
      line-height: 1.5;
    }
    #pwa-status-tip.show { opacity: 1; }
  `;
  document.head.appendChild(style);

  const pill = document.createElement('div');
  pill.id = 'pwa-status';
  pill.innerHTML = `<span class="dot"></span><span id="pwa-status-txt">جانچ رہے ہیں...</span>`;
  pill.title = 'Tap to sync pending orders';
  document.body.appendChild(pill);

  const tip = document.createElement('div');
  tip.id = 'pwa-status-tip';
  document.body.appendChild(tip);

  // Tap: try manual sync
  pill.addEventListener('click', () => {
    manualSync();
    showTip('Syncing pending orders...');
  });
})();

function showTip(msg, duration = 2200) {
  const tip = document.getElementById('pwa-status-tip');
  if (!tip) return;
  tip.textContent = msg;
  tip.classList.add('show');
  setTimeout(() => tip.classList.remove('show'), duration);
}

async function updateStatusUI() {
  const pill = document.getElementById('pwa-status');
  const txt = document.getElementById('pwa-status-txt');
  if (!pill || !txt) return;

  const count = await getPendingCount();
  const online = navigator.onLine;

  if (!online) {
    pill.className = 'offline';
    txt.innerHTML = `Offline ${count > 0 ? `<span class="badge">${count} pending</span>` : ''}`;
  } else if (count > 0) {
    pill.className = 'syncing';
    txt.innerHTML = `Syncing <span class="badge">${count}</span>`;
  } else {
    pill.className = 'online';
    txt.textContent = 'Online ✓';
  }
}

// ────────────────────────────────────────────────────────────────────
//  3. CORE sendOrder() — replaces the original function
//     Detects online/offline, queues to IndexedDB when offline,
//     sends directly when online, triggers sync on reconnect.
// ────────────────────────────────────────────────────────────────────

// This replaces the sendOrder() defined in the original HTML.
// Place this script AFTER the original <script> block so it overrides it.

window.sendOrder = async function sendOrder() {
  var name = document.getElementById('custName').value.trim();
  var phone = document.getElementById('custPhone').value.trim();
  var addr = (document.getElementById('custAddr') || { value: '' }).value.trim();
  var table = (document.getElementById('tableNo') || { value: '' }).value.trim();
  var note = document.getElementById('custNote').value.trim();

  if (!name || !phone) { toast('نام اور فون نمبر لازمی ہے!', 'red'); return; }
  if (typeof orderType !== 'undefined') {
    if (orderType === 'delivery' && !addr) { toast('پتہ لکھنا ضروری ہے!', 'red'); return; }
    if (orderType === 'dine' && !table) { toast('میز نمبر لکھیں!', 'red'); return; }
  }

  var lateNight = typeof isLateNight === 'function' ? isLateNight() : false;
  var sub = cart.reduce(function (s, i) { return s + i.price * i.quantity; }, 0);
  var discounted = typeof discountedTotal === 'function' ? discountedTotal(sub) : sub;
  var discSaving = sub - discounted;
  var disc = typeof isDiscountLive === 'function' ? isDiscountLive() : false;
  var distKm = typeof getEffectiveDistKm === 'function' ? getEffectiveDistKm() : null;
  var fee = (typeof orderType !== 'undefined' && orderType === 'delivery' && typeof calcDeliveryFee === 'function')
    ? calcDeliveryFee(discounted, distKm) : 0;
  var surcharge = lateNight ? (typeof LATE_NIGHT_SURCHARGE !== 'undefined' ? LATE_NIGHT_SURCHARGE : 0) : 0;
  var convFeeSend = typeof calcConvenienceFee === 'function' ? calcConvenienceFee(discounted) : 0;
  var finalTotal = discounted + fee + surcharge + convFeeSend;
  var typeLabel = typeof orderType !== 'undefined'
    ? (orderType === 'delivery' ? '🏠 Delivery' : orderType === 'dine' ? '🍽️ Dine In' : '🛵 Takeaway / Pickup')
    : 'Order';

  // Build WhatsApp message
  var feeMsg = (typeof orderType !== 'undefined' && orderType === 'delivery')
    ? (fee === 0 ? 'FREE 🎉' : 'Rs.' + fee) : 'N/A';
  var waMsg = '🍕 *NEW ORDER — SAHI PIZZA CABIN POINT*\n\n';
  waMsg += '👤 *Name:* ' + name + '\n📱 *Phone:* ' + phone + '\n📦 *Type:* ' + typeLabel + '\n';
  if (lateNight) waMsg += '🌙 *Late Night Window Order (App Only)*\n';
  if (typeof orderType !== 'undefined' && orderType === 'dine' && table) waMsg += '🪑 *Table:* ' + table + '\n';
  if (typeof orderType !== 'undefined' && orderType === 'delivery' && addr) waMsg += '📍 *Address:* ' + addr + '\n';
  waMsg += '\n🛒 *ORDER ITEMS:*\n━━━━━━━━━━━━━━\n';
  cart.forEach(function (i) {
    waMsg += '\n' + i.quantity + 'x *' + i.name + '*' + (i.selectedSize ? ' (' + i.selectedSize + ')' : '') + '\n   Rs.' + i.price + ' × ' + i.quantity + ' = Rs.' + (i.price * i.quantity) + '\n';
  });
  waMsg += '\n━━━━━━━━━━━━━━\n';
  waMsg += '\n💰 Subtotal: Rs.' + sub;
  if (disc) waMsg += '\n🎉 5% Eid Discount: - Rs.' + discSaving;
  if (typeof orderType !== 'undefined' && orderType === 'delivery') waMsg += '\n🚚 Delivery Fee: ' + feeMsg;
  if (lateNight) waMsg += '\n🌙 Late Night Fee: +Rs.' + surcharge;
  waMsg += '\n⚡ Convenience Fee: +Rs.' + convFeeSend;
  waMsg += '\n💵 *TOTAL: Rs.' + finalTotal + '*';
  if (note) waMsg += '\n\n📝 *Note:* ' + note;
  waMsg += '\n\n📍 Near Zabi Ullah Sahi Filter Jesarwala\n📞 052-6300085 / 0305-4266621';

  // Disable submit button
  var btn = document.querySelector('.swa');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span style="font-size:19px">⏳</span> بھیج رہے ہیں...'; }

  // 1. Open WhatsApp immediately (always, online or offline)
  window.open('https://wa.me/923054266621?text=' + encodeURIComponent(waMsg), '_blank');

  // 2. Snapshot cart before clearing
  var sbItemsSnap = cart.map(function (i) {
    return { name: i.name + (i.selectedSize ? ' (' + i.selectedSize + ')' : ''), qty: i.quantity, price: i.price };
  });

  // 3. Clear cart and close sheet
  cart = [];
  if (typeof saveCart === 'function') saveCart();
  if (typeof refreshCartBar === 'function') refreshCartBar();
  if (typeof closeCart === 'function') closeCart();

  // 4. Build order payload
  var orderPayload = {
    customer_name: name,
    customer_phone: phone,
    order_type: (typeof orderType !== 'undefined' ? (orderType === 'takeaway' ? 'pickup' : orderType) : 'unknown'),
    table_no: table || null,
    address: addr || null,
    items: sbItemsSnap,
    subtotal: sub,
    delivery_fee: fee,
    convenience_fee: convFeeSend,
    discount: discSaving,
    total: finalTotal,
    note: note || null,
    status: 'new',
    timestamp: new Date().toISOString()
  };

  // 5. OFFLINE-FIRST ROUTING ──────────────────────────────────────
  if (!navigator.onLine) {
    // ── OFFLINE: Save to IndexedDB queue ──
    try {
      const savedId = await saveOrderToDB(orderPayload);
      toast('📴 آرڈر محفوظ ہو گیا! (Pending #' + savedId + ')', 'orange');
      console.log('[Offline] Order saved to IndexedDB with id:', savedId);
      updateStatusUI();
      // Try to register a Background Sync event for when connectivity returns
      if ('serviceWorker' in navigator && 'SyncManager' in window) {
        const reg = await navigator.serviceWorker.ready;
        await reg.sync.register(SW_SYNC_TAG);
        console.log('[Offline] Background Sync registered:', SW_SYNC_TAG);
      }
    } catch (e) {
      toast('❌ آرڈر محفوظ نہ ہو سکا!', 'red');
      console.error('[Offline] IndexedDB save failed:', e);
    }
  } else {
    // ── ONLINE: Send directly to Google Apps Script ──
    try {
      await fetch(GAS_URL, {
        method: 'POST',
        mode: 'no-cors',
        body: JSON.stringify(orderPayload)
      });
      toast('✅ آرڈر بھیج دیا گیا!', 'green');
      console.log('[Online] Order sent to GAS directly.');
    } catch (e) {
      // Fetch failed despite navigator.onLine being true — save to queue
      console.warn('[Online] Fetch failed, saving to queue:', e);
      try {
        await saveOrderToDB(orderPayload);
        toast('⚠️ نیٹ ورک خرابی — آرڈر محفوظ کر لیا!', 'orange');
      } catch (dbErr) {
        toast('❌ آرڈر بھیجنا ناکام!', 'red');
      }
    }
    updateStatusUI();
  }

  // Re-enable button
  if (btn) { btn.disabled = false; btn.innerHTML = '<span style="font-size:19px">🚀</span> آرڈر بھیجیں'; }
};

// ────────────────────────────────────────────────────────────────────
//  4. CONNECTIVITY MONITOR & AUTO-SYNC
// ────────────────────────────────────────────────────────────────────
window.addEventListener('online', async () => {
  console.log('[Connectivity] Back online — starting sync...');
  updateStatusUI();
  showTip('واپس آنلائن! pending orders sync ہو رہے ہیں...');
  await flushQueue();
});

window.addEventListener('offline', () => {
  console.log('[Connectivity] Went offline.');
  updateStatusUI();
  showTip('آف لائن ہو گئے — آرڈر محفوظ ہوتے رہیں گے');
});

// Flush: send all pending IndexedDB orders to GAS
async function flushQueue() {
  const pill = document.getElementById('pwa-status');
  if (pill) pill.className = 'syncing';

  const pending = await getPendingOrders();
  if (!pending.length) { updateStatusUI(); return; }

  console.log(`[Sync] Flushing ${pending.length} pending order(s)...`);
  let synced = 0;

  for (const record of pending) {
    try {
      await fetch(GAS_URL, {
        method: 'POST',
        mode: 'no-cors',
        body: JSON.stringify({ ...record.payload, synced_from_queue: true })
      });
      await deleteOrderFromDB(record.id);
      synced++;
      console.log(`[Sync] Order #${record.id} synced ✓`);
    } catch (e) {
      console.warn(`[Sync] Failed to sync order #${record.id}:`, e);
    }
  }

  updateStatusUI();
  if (synced > 0) {
    toast(`✅ ${synced} آرڈر sync ہو گئے!`, 'green');
  }
}

// Manual sync trigger (called by status pill tap)
window.manualSync = async function () {
  if (!navigator.onLine) {
    showTip('ابھی آف لائن ہیں — کنیکشن آنے پر sync ہوگا');
    return;
  }
  await flushQueue();
};

// Listen for SYNC_COMPLETE message from Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data && event.data.type === 'SYNC_COMPLETE') {
      console.log('[SW Message] Sync complete, refreshing UI...');
      updateStatusUI();
    }
  });
}

// ────────────────────────────────────────────────────────────────────
//  5. SERVICE WORKER REGISTRATION
// ────────────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      console.log('[SW] Registered:', reg.scope);
    } catch (e) {
      console.warn('[SW] Registration failed:', e);
    }
  });
}

// ────────────────────────────────────────────────────────────────────
//  6. BLUETOOTH THERMAL PRINTING (Skeleton)
//     Works offline — communicates directly via BLE GATT
//     Compatible with generic ESC/POS BLE printers
// ────────────────────────────────────────────────────────────────────

/**
 * printOrderViaBluetooth(orderPayload)
 * ─────────────────────────────────────────────────────────────────
 * Uses Web Bluetooth API to send an ESC/POS formatted receipt to
 * a BLE thermal printer (e.g. GOOJPRT, Peripage, Munbyn, etc.)
 *
 * REQUIREMENTS:
 *  - Must be called from a user gesture (button tap)
 *  - Browser: Chrome/Edge on Android (not Safari/Firefox)
 *  - HTTPS required (or localhost)
 *
 * HOW TO USE:
 *   1. Add a "🖨️ Print" button to your order confirmation screen
 *   2. Call: printOrderViaBluetooth(orderPayload)
 *
 * Common BLE Printer Service/Characteristic UUIDs:
 *   Service:        0000ff00-0000-1000-8000-00805f9b34fb
 *   Characteristic: 0000ff02-0000-1000-8000-00805f9b34fb
 * ─────────────────────────────────────────────────────────────────
 */
window.printOrderViaBluetooth = async function (orderPayload) {
  if (!('bluetooth' in navigator)) {
    toast('❌ اس براؤزر میں Bluetooth سپورٹ نہیں', 'red');
    console.warn('[BT] Web Bluetooth not supported');
    return;
  }

  try {
    toast('🔍 پرنٹر تلاش ہو رہا ہے...', '');

    // 1. Scan & connect
    const device = await navigator.bluetooth.requestDevice({
      // Accept any BLE device (shows picker to user)
      acceptAllDevices: true,
      optionalServices: [
        '000018f0-0000-1000-8000-00805f9b34fb', // Generic Serial
        '0000ff00-0000-1000-8000-00805f9b34fb', // Common thermal printer service
        'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // BTPrint service
      ]
    });

    const server = await device.gatt.connect();
    toast('🖨️ پرنٹر کنیکٹ ہو گیا!', 'green');

    // 2. Get service & characteristic
    // Try common UUIDs — adjust based on your printer model
    let characteristic;
    const serviceUUIDs = [
      '000018f0-0000-1000-8000-00805f9b34fb',
      '0000ff00-0000-1000-8000-00805f9b34fb',
      'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    ];
    const charUUIDs = [
      '00002af1-0000-1000-8000-00805f9b34fb',
      '0000ff02-0000-1000-8000-00805f9b34fb',
      'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
    ];

    for (const svcUUID of serviceUUIDs) {
      try {
        const service = await server.getPrimaryService(svcUUID);
        for (const charUUID of charUUIDs) {
          try {
            characteristic = await service.getCharacteristic(charUUID);
            break;
          } catch (_) { /* try next */ }
        }
        if (characteristic) break;
      } catch (_) { /* try next service */ }
    }

    if (!characteristic) {
      toast('❌ پرنٹر سروس نہیں ملی', 'red');
      console.error('[BT] No writable characteristic found');
      return;
    }

    // 3. Build ESC/POS receipt bytes
    const receiptBytes = buildESCPOSReceipt(orderPayload);

    // 4. Write in 20-byte chunks (BLE MTU limit)
    const CHUNK_SIZE = 20;
    for (let i = 0; i < receiptBytes.length; i += CHUNK_SIZE) {
      const chunk = receiptBytes.slice(i, i + CHUNK_SIZE);
      await characteristic.writeValue(chunk);
    }

    toast('✅ پرنٹ ہو گیا!', 'green');
    console.log('[BT] Receipt printed successfully');

    device.gatt.disconnect();

  } catch (e) {
    if (e.name === 'NotFoundError') {
      toast('پرنٹر منتخب نہیں کیا', '');
    } else {
      toast('❌ پرنٹ ناکام: ' + e.message, 'red');
      console.error('[BT] Print error:', e);
    }
  }
};

/**
 * buildESCPOSReceipt(order)
 * Converts an order object into raw ESC/POS byte array for thermal printing.
 */
function buildESCPOSReceipt(order) {
  const encoder = new TextEncoder();
  const ESC = 0x1B, GS = 0x1D, LF = 0x0A;
  const cmds = [];

  const cmd = (...bytes) => bytes.forEach(b => cmds.push(b));
  const text = str => encoder.encode(str).forEach(b => cmds.push(b));
  const line = str => { text(str); cmd(LF); };
  const divider = () => line('--------------------------------');

  // Init printer
  cmd(ESC, 0x40);         // Initialize
  cmd(ESC, 0x61, 0x01);   // Center align

  // Header
  cmd(ESC, 0x21, 0x30);   // Double size
  line('SAHI PIZZA');
  cmd(ESC, 0x21, 0x00);   // Normal size
  line('Cabin Point, Jesarwala');
  line('052-6300085 / 0305-4266621');
  divider();

  // Order info
  cmd(ESC, 0x61, 0x00);   // Left align
  line('Name  : ' + (order.customer_name || ''));
  line('Phone : ' + (order.customer_phone || ''));
  line('Type  : ' + (order.order_type || ''));
  if (order.table_no) line('Table : ' + order.table_no);
  if (order.address) line('Addr  : ' + order.address);
  line('Time  : ' + new Date().toLocaleTimeString('en-PK'));
  divider();

  // Items
  cmd(ESC, 0x21, 0x08);   // Bold
  line('ITEM                  QTY  PRICE');
  cmd(ESC, 0x21, 0x00);   // Normal

  (order.items || []).forEach(item => {
    const name = item.name.substring(0, 20).padEnd(22);
    const qty = String(item.qty).padStart(3);
    const price = String(item.price * item.qty).padStart(6);
    line(name + qty + price);
  });

  divider();

  // Totals
  const fmt = (label, val) => {
    const l = label.padEnd(22);
    const v = ('Rs.' + val).padStart(10);
    line(l + v);
  };

  fmt('Subtotal:', order.subtotal || 0);
  if (order.discount > 0) fmt('Discount:', '-' + order.discount);
  if (order.delivery_fee > 0) fmt('Delivery:', order.delivery_fee);
  if (order.convenience_fee > 0) fmt('Conv. Fee:', order.convenience_fee);
  divider();

  cmd(ESC, 0x21, 0x30); // Double size
  line('TOTAL   Rs.' + (order.total || 0));
  cmd(ESC, 0x21, 0x00);

  if (order.note) { divider(); line('NOTE: ' + order.note); }

  // Footer
  cmd(ESC, 0x61, 0x01);   // Center
  divider();
  line('Thank You!');
  line('Taste jo Dil Jeet le :)');
  cmd(LF, LF, LF);

  // Cut paper (if supported)
  cmd(GS, 0x56, 0x41, 0x03);

  return new Uint8Array(cmds);
}

// ────────────────────────────────────────────────────────────────────
//  7. INIT on page load
// ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  updateStatusUI();
  // If we're back online and have pending orders, auto-flush
  if (navigator.onLine) {
    getPendingCount().then(count => {
      if (count > 0) {
        console.log(`[Init] Found ${count} pending orders — syncing on load...`);
        flushQueue();
      }
    });
  }
});
