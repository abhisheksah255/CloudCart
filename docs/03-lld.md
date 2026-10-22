# 03 · Low-Level Design (LLD)

> 🎯 **Purpose:** the reference you open while filling in task definitions, writing listener rules, or debugging a 401. Everything here is taken from the code, so it is the source of truth.

---

## 1. 🌐 Routing table (nginx locally = ALB listener rules in AWS)

| Priority | Path pattern (ALB syntax) | Target | Container port | Health-check path |
|:--------:|---------------------------|--------|:--------------:|-------------------|
| 1 | `/api/auth*` | `cc-tg-auth` | 5001 | `/health` |
| 2 | `/api/products*` | `cc-tg-product` | 5002 | `/health` |
| 3 | `/api/cart*` | `cc-tg-cart` | 5003 | `/health` |
| 4 | `/api/orders*` | `cc-tg-order` | 5004 | `/health` |
| 5 | `/api/payments*` | `cc-tg-payment` | 5005 | `/health` |
| default | `*` | `cc-tg-frontend` | 80 | `/health` |

> ⚠️ ALB path patterns are **case-sensitive** and `*` matches zero or more characters. `/api/products*` matches `/api/products`, `/api/products/7` and `/api/products/categories`.

---

## 2. 🔑 Environment variables (copy these into task definitions)

### Shared by all five services

| Variable | Local value | AWS Stage 1 | AWS Stage 2+ |
|----------|-------------|-------------|--------------|
| `PORT` | 5001…5005 | same | same |
| `JWT_SECRET` | from `.env` | plain env var (random 32+ chars) | Secrets Manager `cloudcart/jwt` |
| `INTERNAL_SERVICE_TOKEN` | from `.env` | plain env var (random 32+ chars) | Secrets Manager `cloudcart/internal-token` |
| `NODE_ENV` | development | production | production |

### Per service

| Service | Variable | Local (compose) | AWS Stage 1 | Notes |
|---------|----------|-----------------|-------------|-------|
| 🔐 auth | `MONGODB_URI` | `mongodb://admin:password@mongo:27017/cloudcart_auth?authSource=admin` | Atlas SRV string `mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/cloudcart_auth` | Stage 3: DocumentDB string + `tls=true&tlsCAFile=…` |
| | `REDIS_HOST` / `REDIS_PORT` | `redis` / `6379` | `redis` / `6379` (sidecar, via `links`) | Stage 2: ElastiCache primary endpoint |
| | `DEV_SHOW_OTP` | `true` | `true` | `false` once SES is live |
| | `AWS_REGION` | — | `us-east-1` | for SES client |
| | `SES_SENDER_EMAIL` | unset | unset | Stage 2: verified identity |
| 📦 product | `DB_HOST` | `postgres` | RDS endpoint | |
| | `DB_PORT` / `DB_USER` / `DB_PASSWORD` | `5432` / `postgres` / `password` | `5432` / `postgres` / *master pwd* | password → Secrets Manager in Stage 2 |
| | `DB_NAME` | `product_db` | `product_db` | |
| | `DB_SSL` | unset | `true` | RDS enforces TLS by default on PG 15+ |
| | `REDIS_HOST` / `REDIS_PORT` | `redis` / `6379` | sidecar | |
| | `CACHE_TTL_SECONDS` | `60` | `60` | |
| 🛒 cart | `REDIS_HOST` / `REDIS_PORT` | `redis` / `6379` | sidecar | |
| | `PRODUCT_SERVICE_URL` | `http://product-service:5002` | `http://<ALB-DNS>` | Stage 2: `http://product-service:5002` (Service Connect) |
| 🧾 order | `DB_*` | as product, `DB_NAME=order_db` | `DB_NAME=order_db` | |
| | `CART_SERVICE_URL` | `http://cart-service:5003` | `http://<ALB-DNS>` | |
| | `PRODUCT_SERVICE_URL` | `http://product-service:5002` | `http://<ALB-DNS>` | |
| 💳 payment | `DB_*` | as product, `DB_NAME=payment_db` | `DB_NAME=payment_db` | |
| | `ORDER_SERVICE_URL` | `http://order-service:5004` | `http://<ALB-DNS>` | |

> 💡 In Stage 1 services reach each other **through the ALB** (`http://cloudcart-alb-123.us-east-1.elb.amazonaws.com/api/products/…`). The ALB rules route the path to the right target group just like a browser request. For this to work, `cloudcart-alb-sg` must allow inbound :80 **from `cloudcart-app-sg`** — not only from the internet.

---

## 3. 🗃️ Data model

### 3.1 MongoDB — `cloudcart_auth.users` (auth-service)

```mermaid
erDiagram
    USERS {
        ObjectId _id PK
        string name
        string email UK "lowercase, unique index"
        string role "customer | admin"
        string status "pending | verified | blocked"
        string address
        date createdAt
    }
```

### 3.2 PostgreSQL — three databases, one instance

```mermaid
erDiagram
    PRODUCTS {
        serial id PK
        varchar name
        text description
        varchar category
        numeric price "CHECK >= 0"
        int stock "CHECK >= 0"
        text image_url
        boolean is_active
        timestamptz created_at
        timestamptz updated_at
    }
    ORDERS {
        serial id PK
        varchar user_id "Mongo ObjectId as string"
        varchar user_email
        varchar status "PENDING_PAYMENT|PAID|PAYMENT_FAILED|SHIPPED|DELIVERED|CANCELLED"
        numeric total_amount
        text shipping_address
        int payment_id "logical ref -> payment_db"
        timestamptz created_at
        timestamptz updated_at
    }
    ORDER_ITEMS {
        serial id PK
        int order_id FK
        int product_id "logical ref -> product_db"
        varchar product_name "snapshot"
        numeric unit_price "snapshot"
        int quantity "CHECK > 0"
    }
    PAYMENTS {
        serial id PK
        int order_id "logical ref -> order_db"
        varchar user_id
        numeric amount
        varchar method "card|upi|cod"
        varchar status "INITIATED|SUCCESS|FAILED"
        varchar gateway_ref
        timestamptz created_at
        timestamptz updated_at
    }
    ORDERS ||--|{ ORDER_ITEMS : contains
    ORDER_ITEMS }o..|| PRODUCTS : "product_id (no FK, other DB)"
    PAYMENTS }o..|| ORDERS : "order_id (no FK, other DB)"
```

> 🧠 Dotted lines = **logical** references across databases. There are no foreign keys between databases on purpose: that is what keeps the services independent. `order_items` stores a **snapshot** of name and price so an order never changes if the product is edited later.

### 3.3 Redis keys

| Key pattern | Type | TTL | Owner | Example |
|-------------|------|-----|-------|---------|
| `otp:<email>` | string | 300 s | auth | `otp:asha@cloudcart.local` → `482913` |
| `cart:<userId>` | hash `{productId: qty}` | 7 days (refreshed on write) | cart | `cart:64b0…` → `{ "1": "2", "4": "1" }` |
| `products:<category>:<q>` | string (JSON) | 60 s | product | `products:Books:` → `{"success":true,"products":[…]}` |

---

## 4. 📡 API contracts

Conventions: JSON in/out · `Authorization: Bearer <JWT>` where marked 🔒 · 🛡️ = admin only · 🔧 = internal (`X-Internal-Token` header, never routed by the ALB) · errors are `{ "success": false, "message": "…" }`.

### 🔐 auth-service

| Method | Path | Auth | Body | 200/201 response |
|--------|------|:----:|------|------------------|
| POST | `/api/auth/request-otp` | — | `{ email, name? }` | `{ success, message, dev_otp? }` |
| POST | `/api/auth/verify-otp` | — | `{ email, otp }` | `{ success, token, user }` |
| GET | `/api/auth/me` | 🔒 | — | `{ success, user }` |
| PUT | `/api/auth/me` | 🔒 | `{ name?, address? }` | `{ success, user }` |
| GET | `/api/auth/users` | 🛡️ | — | `{ success, users[] }` |
| PUT | `/api/auth/users/:id/status` | 🛡️ | `{ status }` | `{ success, user }` |
| GET | `/health`, `/api/auth/health` | — | — | `{ status, mongo, redis }` (503 if degraded) |

**JWT payload** (HS256, 7 d): `{ id, name, email, role, iat, exp }`

### 📦 product-service

| Method | Path | Auth | Body | Response |
|--------|------|:----:|------|----------|
| GET | `/api/products?category=&q=` | — | — | `{ success, products[] }` + `X-Cache: HIT/MISS` |
| GET | `/api/products/categories` | — | — | `{ success, categories[] }` |
| GET | `/api/products/:id` | — | — | `{ success, product }` |
| POST | `/api/products` | 🛡️ | `{ name, category, price, stock?, description?, image_url? }` | 201 `{ success, product }` |
| PUT | `/api/products/:id` | 🛡️ | any subset of fields | `{ success, product }` |
| POST | `/api/products/internal/reserve` | 🔧 | `{ items:[{product_id, quantity}] }` | `{ success, items:[{product_id,name,unit_price,quantity}] }` or **409** |
| POST | `/api/products/internal/release` | 🔧 | `{ items:[…] }` | `{ success }` |
| GET | `/health`, `/api/products/health` | — | — | `{ status, database, cache }` |

### 🛒 cart-service

| Method | Path | Auth | Body | Response |
|--------|------|:----:|------|----------|
| GET | `/api/cart` | 🔒 | — | `{ success, cart:{ items[], total, count } }` |
| POST | `/api/cart/items` | 🔒 | `{ product_id, quantity? }` | cart (409 if over stock) |
| PUT | `/api/cart/items/:productId` | 🔒 | `{ quantity }` (0 removes) | cart |
| DELETE | `/api/cart/items/:productId` | 🔒 | — | cart |
| DELETE | `/api/cart` | 🔒 | — | empty cart |
| GET | `/api/cart/internal/:userId` | 🔧 | — | cart |
| DELETE | `/api/cart/internal/:userId` | 🔧 | — | `{ success }` |
| GET | `/health`, `/api/cart/health` | — | — | `{ status, redis }` |

### 🧾 order-service

| Method | Path | Auth | Body | Response |
|--------|------|:----:|------|----------|
| POST | `/api/orders` | 🔒 | `{ shipping_address? }` | 201 `{ success, order }` · 400 empty cart · 409 stock |
| GET | `/api/orders` | 🔒 | — | own orders (admin: all) |
| GET | `/api/orders/:id` | 🔒 | — | `{ success, order:{…, items[]} }` |
| PUT | `/api/orders/:id/status` | 🛡️ | `{ status }` | `{ success, order }` |
| GET | `/api/orders/internal/:id` | 🔧 | — | order |
| POST | `/api/orders/internal/:id/payment-result` | 🔧 | `{ success, payment_id }` | `{ success }` |
| GET | `/health`, `/api/orders/health` | — | — | `{ status, database }` |

**Order status machine**

```mermaid
stateDiagram-v2
    [*] --> PENDING_PAYMENT: checkout
    PENDING_PAYMENT --> PAID: payment success
    PENDING_PAYMENT --> PAYMENT_FAILED: payment declined (stock released)
    PAID --> SHIPPED: admin
    SHIPPED --> DELIVERED: admin
    PENDING_PAYMENT --> CANCELLED: admin
    PAID --> CANCELLED: admin
```

### 💳 payment-service

| Method | Path | Auth | Body | Response |
|--------|------|:----:|------|----------|
| POST | `/api/payments` | 🔒 | `{ order_id, method? }` | 201 `{ success, payment }` (409 if order not PENDING_PAYMENT) |
| POST | `/api/payments/:id/confirm` | 🔒 | `{ card_last4 }` | `{ success, payment, message }` — `0000` ⇒ declined |
| GET | `/api/payments/order/:orderId` | 🔒 | — | `{ success, payments[] }` |
| GET | `/health`, `/api/payments/health` | — | — | `{ status, database }` |

---

## 5. 🐳 Container specs (what to type into each ECS task definition)

| Task family | Container(s) | Image | Port | CPU / memory (soft) | Needs |
|-------------|--------------|-------|:----:|:------------------:|-------|
| `cc-frontend` | `frontend` | `…/cloudcart/frontend:latest` | 80 | 128 / 64 MB | — |
| `cc-auth` | `auth` + `redis` (sidecar, `links: ["redis"]`) | `…/cloudcart/auth-service:latest` + `public.ecr.aws/docker/library/redis:7-alpine` | 5001 | 256 / 192 MB + 64 MB | Mongo URI |
| `cc-product` | `product` + `redis` sidecar | `…/cloudcart/product-service:latest` | 5002 | 256 / 192 MB + 64 MB | RDS |
| `cc-cart` | `cart` + `redis` sidecar | `…/cloudcart/cart-service:latest` | 5003 | 128 / 128 MB + 64 MB | ALB URL |
| `cc-order` | `order` | `…/cloudcart/order-service:latest` | 5004 | 256 / 192 MB | RDS, ALB URL |
| `cc-payment` | `payment` | `…/cloudcart/payment-service:latest` | 5005 | 128 / 128 MB | RDS, ALB URL |

Total ≈ 1.2 GB reserved → fits one **t3.small (2 GB)** with room for the ECS agent. (Sidecars disappear in Stage 2 when ElastiCache arrives.)

Every service image: `node:20-alpine`, runs as the non-root `node` user, `HEALTHCHECK` on `/health`, no volumes.

---

## 6. 📜 Logging format

```json
{ "ts": "ISO-8601", "service": "order-service", "level": "info|warn|error|access", "msg": "…", "...extra": "fields" }
```

Useful CloudWatch Logs Insights queries (log group `/ecs/cloudcart/*`):

```sql
-- all errors in the last hour across services
fields @timestamp, service, msg, error | filter level = "error" | sort @timestamp desc

-- slowest requests
fields @timestamp, service, msg, ms | filter level = "access" | sort ms desc | limit 20

-- checkout funnel
filter msg = "Order created" | stats count() by bin(5m)
```

---

## 7. 🧪 Test matrix (run after every stage)

| # | Test | Expected | Proves |
|:-:|------|----------|--------|
| 1 | `GET /health` on all 6 via the entry point | 200 ×6 | routing + every datastore connection |
| 2 | request-otp → verify-otp | token | auth ↔ Redis ↔ Mongo |
| 3 | list products twice | `X-Cache: MISS` then `HIT` | product ↔ Postgres ↔ Redis |
| 4 | add 6 × Football (stock 5) | 409 "Only 5 left" | cart ↔ product |
| 5 | checkout | 201, cart empty, stock −qty | order ↔ cart ↔ product, transaction |
| 6 | pay 4242 | order PAID | payment ↔ order |
| 7 | pay 0000 | PAYMENT_FAILED, stock restored | compensating action |
| 8 | admin: add product, set order SHIPPED | 201 / 200 | role authorization |
| 9 | customer calls `POST /api/products` | 403 | role authorization |
| 10 | call `/api/products/internal/reserve` from the internet | 403 (no token) / 404 (Stage 2, not routed) | internal boundary |

`scripts/smoke-test.sh <base-url>` runs 1–7 automatically.

➡️ Next: [04 · AWS Stage 1 — MVP](04-aws-stage1-mvp.md)
