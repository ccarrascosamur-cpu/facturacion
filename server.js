// server.js — Shopify <-> Bsale en Render (Webhook + Sync SKUs)
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const cron = require('node-cron');

const app = express();

// ---------- ENV
const SHOP = process.env.SHOPIFY_SHOP;                  // p.ej. ugachile.myshopify.com
const ADMIN_TOKEN = process.env.SHOPIFY_TOKEN;          // shpat_xxx (Admin API access token)
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET; // API secret key (para HMAC)
const BSALE_TOKEN = process.env.BSALE_TOKEN;            // Token de Bsale

const GQL = `https://${SHOP}/admin/api/2025-07/graphql.json`;
const SHOPIFY_HEADERS = {
  'X-Shopify-Access-Token': ADMIN_TOKEN,
  'Content-Type': 'application/json'
};

const BSALE_API = 'https://api.bsale.cl/v1';
const BSALE_HEADERS = {
  'access_token': BSALE_TOKEN,
  'Content-Type': 'application/json'
};

// ---------- Healthcheck
app.get('/', (_req, res) => res.send('OK'));

// ---------- JSON para todo salvo el webhook (que usa RAW)
app.use((req, res, next) => {
  if (req.path === '/webhooks/orders-paid') return next();
  express.json({ type: '*/*' })(req, res, next);
});

// ---------- Utilidades Shopify (GraphQL)
async function gql(query, variables = {}) {
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

// ---------- Bsale helpers
async function fetchBsaleVariants(offset = 0, limit = 50) {
  const url = `${BSALE_API}/variants.json?limit=${limit}&offset=${offset}&fields=[id,code,barCode,description,product]`;
  const r = await fetch(url, { headers: { 'access_token': BSALE_TOKEN } });
  if (!r.ok) throw new Error(`Bsale variants ${r.status}`);
  return r.json(); // { items, count, limit, offset }
}

// Crea documento en Bsale (boleta/factura) — AJUSTA a tu configuración si usas neto/bruto, sucursal, etc.
async function createBsaleDocument({ order, attrs }) {
  const isFactura = (attrs.document_type || 'boleta').toLowerCase() === 'factura';
  const documentTypeId = isFactura ? 33 : 39; // valida en tu cuenta Bsale

  const details = (order.line_items || []).map(li => ({
    quantity: li.quantity,
    netUnitValue: Number(li.price), // si tus precios en Shopify son brutos, calcula neto (19% IVA)
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

// Guarda una notita en el pedido (puedes mover a metafield si quieres)
async function saveOrderNote(orderId, text) {
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

// ---------- Webhook raw (HMAC primero, parse después)
app.post('/webhooks/orders-paid', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // Verificar HMAC
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256') || '';
    const digest = crypto.createHmac('sha256', WEBHOOK_SECRET || '')
      .update(req.body) // Buffer crudo
      .digest('base64');

    const safeEqual = (a, b) => {
      try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
      catch { return false; }
    };
    const valid = safeEqual(hmacHeader, digest);
    if (!valid) {
      console.warn('[WEBHOOK] HMAC inválida (en pruebas devolvemos 200)');
      // return res.status(401).send('Invalid signature');
    }

    // Parse JSON recién ahora
    const order = JSON.parse(req.body.toString('utf8'));
    console.log('[WEBHOOK] Order paid:', order?.id, order?.name);

    // Leer atributos del carrito (note_attributes) para Factura
    const attrs = {};
    (order.note_attributes || []).forEach(a => { attrs[a.name] = a.value; });

    // Emisión Bsale (descomenta para activar realmente)
    try {
      const doc = await createBsaleDocument({ order, attrs });
      const resumen = `Bsale OK: ID ${doc?.id ?? 'N/A'}`;
      await saveOrderNote(order.id, resumen);
      console.log('[WEBHOOK] Documento Bsale emitido:', doc?.id);
    } catch (e) {
      console.error('[WEBHOOK] Falló emisión Bsale:', e.message);
      // En pruebas, no fallamos el webhook
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('[WEBHOOK] Error:', err);
    // Para evitar reintentos masivos mientras pruebas:
    res.sendStatus(200);
  }
});

// ---------- Sync SKUs (cada 2 min). Nota: en plan free, si Render “duerme”, reanudará al primer request.
async function syncSKUs() {
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

// Endpoint manual para disparar sync
app.post('/sync/skus', async (_req, res) => {
  try {
    const result = await syncSKUs();
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Programación cada 2 minutos
cron.schedule('*/2 * * * *', async () => {
  try { await syncSKUs(); } catch (e) { console.error('[CRON]', e); }
});

// ---------- Start (Render asigna PORT)
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server on :${PORT}`);
});
