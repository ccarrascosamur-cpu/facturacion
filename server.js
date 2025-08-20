// server.js — Shopify <-> Bsale en Render (Webhook + Sync SKUs) con ENV check
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const cron = require('node-cron');

const app = express();

// ======================= ENV (declarar SOLO una vez) =======================
const {
  SHOPIFY_SHOP,
  SHOPIFY_TOKEN,
  SHOPIFY_WEBHOOK_SECRET,
  BSALE_TOKEN,
  PORT
} = process.env;

const SHOP = SHOPIFY_SHOP;                 // p.ej. ugachile.myshopify.com
const ADMIN_TOKEN = SHOPIFY_TOKEN;         // shpat_...
const WEBHOOK_SECRET = SHOPIFY_WEBHOOK_SECRET;

// Diagnóstico en logs
console.log('ENV CHECK -> SHOPIFY_SHOP:', SHOP || '(MISSING)');
console.log('ENV CHECK -> SHOPIFY_TOKEN:', ADMIN_TOKEN ? 'OK' : '(MISSING)');
console.log('ENV CHECK -> SHOPIFY_WEBHOOK_SECRET:', WEBHOOK_SECRET ? 'OK' : '(MISSING)');
console.log('ENV CHECK -> BSALE_TOKEN:', BSALE_TOKEN ? 'OK' : '(MISSING)');

function hasAllEnv() {
  return Boolean(SHOP && ADMIN_TOKEN && WEBHOOK_SECRET && BSALE_TOKEN);
}

// Construcción condicional de URLs (evita “undefined”)
const GQL = hasAllEnv() ? `https://${SHOP}/admin/api/2025-07/graphql.json` : null;
const BSALE_API = 'https://api.bsale.cl/v1';

// Headers fijos
const SHOPIFY_HEADERS = hasAllEnv()
  ? { 'X-Shopify-Access-Token': ADMIN_TOKEN, 'Content-Type': 'application/json' }
  : null;
const BSALE_HEADERS = BSALE_TOKEN
  ? { 'access_token': BSALE_TOKEN, 'Content-Type': 'application/json' }
  : null;

// ======================= Rutas básicas =======================
app.get('/', (_req, res) => res.send('OK'));

// JSON global excepto webhook (usa RAW)
app.use((req, res, next) => {
  if (req.path === '/webhooks/orders-paid') return next();
  express.json({ type: '*/*' })(req, res, next);
});

// ======================= Shopify helpers =======================
async function gql(query, variables = {}) {
  if (!GQL) throw new Error('GQL URL not ready (missing ENV)');
  const r = await fetch(GQL, {
    method: 'POST',
    headers: SHOPIFY_HEADERS,
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

async function findVariantBySKU(sku) {
  const q = `
    query($q:String!){
      productVariants(first:50, query:$q){
        edges{ node{ id sku barcode product{ id title } } }
      }
    }`;
  const d = await gql(q, { q: `sku:${JSON.stringify(sku)}` });
  return d.productVariants.edges.map(e => e.node);
}

async function findVariantByBarcode(barcode) {
  const q = `
    query($q:String!){
      productVariants(first:50, query:$q){
        edges{ node{ id sku barcode product{ id title } } }
      }
    }`;
  const d = await gql(q, { q: `barcode:${JSON.stringify(barcode)}` });
  return d.productVariants.edges.map(e => e.node);
}

async function updateVariantSKU(variantId, newSKU) {
  const m = `
    mutation($id:ID!, $sku:String!){
      productVariantUpdate(input:{id:$id, sku:$sku}){
        productVariant{ id sku }
        userErrors{ field message }
      }
    }`;
  const d = await gql(m, { id: variantId, sku: newSKU });
  const errs = d.productVariantUpdate.userErrors;
  if (errs && errs.length) throw new Error(errs.map(e => e.message).join('; '));
  return d.productVariantUpdate.productVariant;
}

// ======================= Bsale helpers =======================
async function fetchBsaleVariants(offset = 0, limit = 50) {
  if (!BSALE_HEADERS) throw new Error('BSALE headers not ready (missing token)');
  const url = `${BSALE_API}/variants.json?limit=${limit}&offset=${offset}&fields=[id,code,barCode,description,product]`;
  const r = await fetch(url, { headers: BSALE_HEADERS });
  if (!r.ok) throw new Error(`Bsale variants ${r.status}`);
  return r.json(); // { items, count, limit, offset }
}

async function createBsaleDocument({ order, attrs }) {
  if (!BSALE_HEADERS) throw new Error('BSALE headers not ready (missing token)');
  const isFactura = (attrs.document_type || 'boleta').toLowerCase() === 'factura';
  const documentTypeId = isFactura ? 33 : 39; // ajusta si tu cuenta difiere

  const details = (order.line_items || []).map(li => ({
    quantity: li.quantity,
    netUnitValue: Number(li.price), // si tus precios son brutos, calcula neto
    description: li.title,
    code: li.sku || ''
  }));

  const client = {
    legalName: attrs.razon_social || `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim(),
    rut: attrs.rut || '',
    address: attrs.direccion || order.shipping_address?.address1 || '',
    commune: attrs.comuna || order.shipping_address?.city || '',
    email: attrs.email_doc || order.email || ''
  };

  const payload = {
    emissionDate: new Date().toISOString().slice(0,10),
    documentTypeId,
    reference: `Shopify ${order.name || order.id}`,
    client,
    details
  };

  const r = await fetch(`${BSALE_API}/documents.json`, {
    method: 'POST',
    headers: BSALE_HEADERS,
    body: JSON.stringify(payload)
  });
  const data = await r.json();
  if (!r.ok) {
    console.error('Bsale error:', r.status, data);
    throw new Error('Error al crear documento en Bsale');
  }
  return data;
}

async function saveOrderNote(orderId, text) {
  if (!hasAllEnv()) return;
  const url = `https://${SHOP}/admin/api/2025-07/orders/${orderId}.json`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: {
      'X-Shopify-Access-Token': ADMIN_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ order: { id: orderId, note: text } })
  });
  if (!r.ok) console.error('No se pudo guardar nota en pedido:', await r.text());
}
// --- Descubrimiento de tipos de documento en Bsale
const BSALE_DOC_FACTURA_ID = process.env.BSALE_DOC_FACTURA_ID
  ? Number(process.env.BSALE_DOC_FACTURA_ID) : null;
const BSALE_DOC_BOLETA_ID = process.env.BSALE_DOC_BOLETA_ID
  ? Number(process.env.BSALE_DOC_BOLETA_ID) : null;

async function fetchBsaleDocumentTypes() {
  const url = `${BSALE_API}/document_types.json?limit=50&offset=0`;
  const r = await fetch(url, { headers: BSALE_HEADERS });
  if (!r.ok) throw new Error(`Bsale document_types ${r.status}`);
  return r.json();
}

async function getDocumentTypeIds() {
  if (BSALE_DOC_FACTURA_ID && BSALE_DOC_BOLETA_ID) {
    return { FACTURA: BSALE_DOC_FACTURA_ID, BOLETA: BSALE_DOC_BOLETA_ID };
  }

  const data = await fetchBsaleDocumentTypes();
  const items = data.items || data;

  let factura = items.find(t =>
    String(t.siiCode || t.code || '') === '33' || /factura/i.test(t.name || '')
  );
  let boleta = items.find(t =>
    String(t.siiCode || t.code || '') === '39' || /boleta/i.test(t.name || '')
  );

  if (!factura || !boleta) {
    console.warn('[BSALE] No pude identificar Factura/Boleta. Resumen:',
      items.map(x => ({ id: x.id, name: x.name, siiCode: x.siiCode || x.code }))
    );
    throw new Error('No se pudieron detectar los IDs de documento en Bsale');
  }

  return { FACTURA: factura.id, BOLETA: boleta.id };
}

// ======================= Webhook (RAW + HMAC) =======================
app.post('/webhooks/orders-paid', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256') || '';
    const digest = crypto.createHmac('sha256', WEBHOOK_SECRET || '')
      .update(req.body) // Buffer
      .digest('base64');

    const safeEqual = (a, b) => {
      try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
      catch { return false; }
    };
    const valid = safeEqual(hmacHeader, digest);
    if (!valid) {
      console.warn('[WEBHOOK] HMAC inválida (respondemos 200 en pruebas)');
      // return res.status(401).send('Invalid signature');
    }

    const order = JSON.parse(req.body.toString('utf8'));
    console.log('[WEBHOOK] Order paid:', order?.id, order?.name);

    const attrs = {};
    (order.note_attributes || []).forEach(a => { attrs[a.name] = a.value; });

    // Emite documento Bsale (no fallar el webhook si algo sale mal)
    if (hasAllEnv()) {
      try {
        const doc = await createBsaleDocument({ order, attrs });
        const resumen = `Bsale OK: ID ${doc?.id ?? 'N/A'}`;
        await saveOrderNote(order.id, resumen);
        console.log('[WEBHOOK] Documento Bsale emitido:', doc?.id);
      } catch (e) {
        console.error('[WEBHOOK] Falló emisión Bsale:', e.message);
      }
    } else {
      console.warn('[WEBHOOK] Saltando Bsale: faltan ENV');
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('[WEBHOOK] Error:', err);
    res.sendStatus(200); // evitar reintentos mientras pruebas
  }
});

// ======================= Sync SKUs (cron cada 2 min) =======================
async function syncSKUs() {
  if (!hasAllEnv()) {
    console.warn('[SYNC] Saltando: faltan ENV');
    return;
  }
  console.log('[SYNC] Iniciando…', new Date().toISOString());
  let offset = 0, limit = 50, processed = 0, updated = 0;

  while (true) {
    const page = await fetchBsaleVariants(offset, limit);
    for (const v of page.items) {
      const sku = v.code?.trim();
      const barcode = v.barCode?.trim();
      if (!sku && !barcode) { processed++; continue; }

      let variant = sku ? (await findVariantBySKU(sku))[0] : null;
      if (!variant && barcode) variant = (await findVariantByBarcode(barcode))[0];
      if (!variant) { processed++; continue; }

      if (sku && variant.sku !== sku) {
        await updateVariantSKU(variant.id, sku);
        updated++;
      }
      processed++;
    }
    offset += page.items.length;
    if (offset >= page.count) break;
  }
  console.log(`[SYNC] Procesadas ${processed}, actualizadas ${updated}.`);
  return { processed, updated };
}

// Endpoint manual
app.post('/sync/skus', async (_req, res) => {
  try {
    const result = await syncSKUs();
    res.json(result || { skipped: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Programa el cron solo si hay ENV completas
if (hasAllEnv()) {
  cron.schedule('*/2 * * * *', async () => {
    try { await syncSKUs(); } catch (e) { console.error('[CRON]', e); }
  });
} else {
  console.warn('[CRON] Deshabilitado: faltan variables de entorno.');
}

// ======================= Start =======================
const listenPort = PORT || 10000; // Render asigna PORT
app.listen(listenPort, () => {
  console.log(`Server on :${listenPort}`);
});

