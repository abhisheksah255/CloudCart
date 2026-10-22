<div align="center">

# 🛒 CloudCart

### A 5-microservice e-commerce demo, built to be deployed to AWS **by hand, in the console**, one stage at a time.

![Node](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4-000000?logo=express)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-7-47A248?logo=mongodb&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)
![nginx](https://img.shields.io/badge/nginx-1.27-009639?logo=nginx&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![AWS](https://img.shields.io/badge/AWS-ECS%20on%20EC2-FF9900?logo=amazonaws&logoColor=white)

</div>

---

## 🎯 What this project is for

You want to **learn AWS deployment properly** — not by running a Terraform script, but by clicking through every console screen, understanding every field, and being able to do it again alone for a real production project.

CloudCart gives you a realistic application to deploy (five independent services that call each other, three different datastores, a reverse proxy) and a **three-stage deployment path** that grows from "it runs on one EC2 box" to "CloudFront + WAF + multi-AZ":

| Stage | Nickname | What you learn | Daily cost (approx.) |
|:-----:|----------|----------------|:--------------------:|
| 🟢 **1** | **MVP** | VPC, security groups, IAM, ECR, RDS, ECS on EC2, ALB path routing, CloudWatch, SSM Session Manager | ~₹130 / day |
| 🟡 **2** | **Hardened** | Private subnets + NAT, VPC endpoints, Secrets Manager, ElastiCache, HTTPS/ACM/Route 53, auto scaling, CI/CD (GitHub Actions / Jenkins) | ~₹250 / day |
| 🔴 **3** | **Production** | CloudFront + WAF, Global Accelerator, Multi-AZ RDS, DocumentDB, backups, alarms, DR, runbooks | ~₹600+ / day |

Every stage ends with a **✅ Verify** checklist and a **🧹 Teardown** note, so you only pay for what you are actively using.

---

## 🏗️ Architecture at a glance

```mermaid
flowchart LR
    U([👤 Browser]) -->|HTTP| GW

    GW["🚪 Entry point<br/>local: nginx · AWS: Application Load Balancer<br/>─────────────<br/>/ → frontend<br/>/api/auth* → auth<br/>/api/products* → product<br/>/api/cart* → cart<br/>/api/orders* → order<br/>/api/payments* → payment"]

    GW --> FE["🖥️ frontend<br/>nginx · static SPA"]
    GW --> AU["🔐 auth-service<br/>:5001"]
    GW --> PR["📦 product-service<br/>:5002"]
    GW --> CA["🛒 cart-service<br/>:5003"]
    GW --> OR["🧾 order-service<br/>:5004"]
    GW --> PA["💳 payment-service<br/>:5005"]

    AU --> MG[("🍃 MongoDB<br/>users")]
    AU --> RD1[("⚡ Redis<br/>OTP")]
    PR --> PG1[("🐘 Postgres<br/>product_db")]
    PR --> RD2[("⚡ Redis<br/>catalog cache")]
    CA --> RD3[("⚡ Redis<br/>carts")]
    OR --> PG2[("🐘 Postgres<br/>order_db")]
    PA --> PG3[("🐘 Postgres<br/>payment_db")]

    CA -.->|validate product| PR
    OR -.->|read + clear cart| CA
    OR -.->|reserve / release stock| PR
    PA -.->|payment result| OR

    classDef gw fill:#fff7cc,stroke:#d4a017,color:#333
    classDef svc fill:#1e2740,stroke:#4f8cff,color:#fff
    classDef db fill:#2b2f1d,stroke:#f1c40f,color:#fff
    class GW gw
    class FE,AU,PR,CA,OR,PA svc
    class MG,RD1,RD2,RD3,PG1,PG2,PG3 db
```

**Solid arrows** = client traffic through the entry point. **Dotted arrows** = service-to-service calls, protected by an internal token.

---

## 🧩 The services

| Service | Port | Datastore | Owns |
|---------|:----:|-----------|------|
| 🔐 `auth-service` | 5001 | MongoDB + Redis | Passwordless OTP login, users, roles, JWT issuing |
| 📦 `product-service` | 5002 | PostgreSQL + Redis | Catalog, stock, atomic stock reservation |
| 🛒 `cart-service` | 5003 | Redis | One cart per user (Redis hash, 7-day TTL) |
| 🧾 `order-service` | 5004 | PostgreSQL | Checkout orchestration, order history |
| 💳 `payment-service` | 5005 | PostgreSQL | Mock payment gateway + payment ledger |
| 🖥️ `frontend` | 80 | — | Static SPA served by nginx |

Why these datastores? → see [docs/02-architecture-hld.md](docs/02-architecture-hld.md#why-three-datastores).

---

## 🚀 Quick start (local)

```bash
git clone <your-repo-url> cloudcart && cd cloudcart
docker compose up -d --build        # ~3-5 min first time
open http://localhost:8080          # login as asha@cloudcart.local — the OTP is shown on screen in dev mode
```

Full walkthrough with checkpoints: **[docs/01-local-setup.md](docs/01-local-setup.md)**

---

## 📚 Documentation map

| # | Document | Read it when… |
|:-:|----------|---------------|
| 01 | [Local setup & testing](docs/01-local-setup.md) | you want it running on Docker Desktop in 10 minutes |
| 02 | [High-Level Design](docs/02-architecture-hld.md) | you want the big picture + the AWS service mapping |
| 03 | [Low-Level Design](docs/03-lld.md) | you need API contracts, schemas, sequence diagrams, env vars |
| 04 | [🟢 AWS Stage 1 — MVP](docs/04-aws-stage1-mvp.md) | first deployment, every console field explained |
| 05 | [🟡 AWS Stage 2 — Hardened](docs/05-aws-stage2-hardening.md) | private networking, secrets, HTTPS, scaling, CI/CD |
| 06 | [🔴 AWS Stage 3 — Production](docs/06-aws-stage3-production.md) | edge, security, HA, backups, go-live checklist |
| 07 | [IAM roles & policies](docs/07-iam-roles-and-policies.md) | you need to know exactly which roles to create and why |
| 08 | [DevOps checklist](docs/08-devops-checklist.md) | you are the DevOps engineer and want to know what to watch |
| 09 | [Cost ledger & teardown](docs/09-cost-and-teardown.md) | before you create anything, and before you go to sleep |
| 10 | [Troubleshooting](docs/10-troubleshooting.md) | something is red and you don't know why |
| 11 | [Task definition deep dive](docs/11-task-definition-deep-dive.md) | you are on the *Create task definition* screen and want every field explained (+ ECS Exec) |
| 12 | [Cluster, target groups, ALB & service deep dive](docs/12-ecs-cluster-service-alb-deep-dive.md) | you are creating the cluster, target groups, ALB rules or an ECS service |

> 💡 **Diagrams** are written in [Mermaid](https://mermaid.js.org). GitHub renders them automatically. In VS Code install the extension *"Markdown Preview Mermaid Support"*, then press `Ctrl+Shift+V`.

---

## 📁 Repository layout

```
cloudcart/
├── docker-compose.yml          ← full local stack (3 datastores + 5 services + nginx)
├── .env.example                ← copy to .env
├── frontend/                   ← SPA + nginx (two configs: local proxy / AWS static)
├── services/
│   ├── auth-service/           ← Node + Mongoose + ioredis (+ optional SES)
│   ├── product-service/        ← Node + pg + ioredis
│   ├── cart-service/           ← Node + ioredis
│   ├── order-service/          ← Node + pg
│   └── payment-service/        ← Node + pg
├── db/postgres/                ← SQL that creates the 3 databases + seed data
├── scripts/
│   ├── smoke-test.sh           ← end-to-end test (local or AWS)
│   └── build-and-push-ecr.sh   ← the only CLI step in Stage 1
├── .github/workflows/deploy.yml← CI/CD for Stage 2
└── docs/                       ← everything listed above
```

---

## 🔑 Demo accounts

| Email | Role | Notes |
|-------|------|-------|
| `admin@cloudcart.local` | admin | can add products, change user/order status |
| `asha@cloudcart.local` | customer | |
| `ravi@cloudcart.local` | customer | |

Any **new** email + name creates a customer account on first OTP request.
OTP is shown in the UI while `DEV_SHOW_OTP=true` (default). Use card digits **`0000`** at payment to simulate a declined card.

---

<div align="center">
<sub>Built as a hands-on AWS learning project. Delete everything when you're done — <a href="docs/09-cost-and-teardown.md">here's the order to do it in</a>.</sub>
</div>
