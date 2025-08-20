# Shopify <-> Bsale (Webhook + SKU Sync) para Render (Free)

## Endpoints
- GET `/` -> Healthcheck ("OK")
- POST `/webhooks/orders-paid` -> Webhook Shopify (Order paid)
- POST `/sync/skus` -> Dispara sincronización de SKUs manualmente

## Variables de entorno (Render)
- PORT = 10000 (Render la usa, pero mantenla)
- SHOPIFY_SHOP = tu-tienda.myshopify.com
- SHOPIFY_TOKEN = shpat_xxx (Admin API access token)
- SHOPIFY_WEBHOOK_SECRET = API secret key (para HMAC)
- BSALE_TOKEN = token de Bsale

## Despliegue
1. Sube este repo a GitHub.
2. Crea **Web Service** en https://render.com (plan Free).
3. Conecta el repo, Start Command: `node server.js`.
4. Configura Variables de Entorno anteriores.
5. Render te dará una URL fija: `https://tu-app.onrender.com`.

## Shopify Webhook
Crea un webhook:
- Event: **Order payment**
- URL: `https://tu-app.onrender.com/webhooks/orders-paid`
- Format: JSON

## Notas
- En plan Free, Render puede "dormir". El primer request puede tardar.
- Cron de 2 minutos corre mientras el servicio está "awake".
