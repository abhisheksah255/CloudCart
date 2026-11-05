# 06 · 🔴 AWS Stage 3 — Production ("I'd put a client on this")

> ⏱️ **Time:** 4–6 hours · 💰 **Cost while running:** ≈ ₹600+ / day · 🎯 **Goal:** survive an AZ failure, stop attacks at the edge, serve the world fast, recover from mistakes, and know about problems before users do. **Prerequisite:** Stage 2 complete.

This stage is modular — each step is independent. Do the ones that matter for your demo; the ✅ Go-live checklist at the end tells you which are non-negotiable for a real client.

---

## 🗺️ Stage 3 shape

```mermaid
flowchart LR
    U([🌍 Users]) --> GA["🌐 Global Accelerator<br/>(optional, anycast IPs)"]
    GA --> CF["🛡️ CloudFront + WAF<br/>cache static · block attacks"]
    U --> CF
    CF --> ALB["⚖️ ALB (HTTPS)<br/>origin"]
    subgraph AZa["AZ a"]
        H1["ECS host"]
        R1[("RDS primary")]
        C1[("Redis primary")]
        D1[("DocumentDB primary")]
        N1["NAT a"]
    end
    subgraph AZb["AZ b"]
        H2["ECS host"]
        R2[("RDS standby")]
        C2[("Redis replica")]
        D2[("DocDB replica")]
        N2["NAT b"]
    end
    ALB --> H1 & H2
    H1 & H2 --> R1 & C1 & D1
    R1 -. sync .-> R2
    C1 -. async .-> C2
    D1 -. async .-> D2
    H1 --> EFS[("📁 EFS (optional)")]
    H2 --> EFS
```

---

## Step 0 — Secrets Manager: get the secrets out of the images (30 min)

Until now every image carried a `.env` copied from the Jenkins box. In production the image must be **the same artifact everywhere** and secrets must live in a vault with audit + rotation. This is the step TSRS is heading to as well.

### 0.1 Create the secrets
**Secrets Manager → Store a new secret** (×4), type *Other → Plaintext*, tag `Project=cloudcart`:

| Secret name | Value |
|---|---|
| `cloudcart/jwt` | the JWT secret currently in the `.env` files (keep the same value so existing logins survive) |
| `cloudcart/internal-token` | the internal token |
| `cloudcart/db-password` | RDS master password |
| `cloudcart/mongodb-uri` | `mongodb+srv://cloudcart:Lhein7udXmGNEhV4@cloudcart.4dxau2t.mongodb.net/cloudcart_auth?retryWrites=true&w=majority` (Stage 3 Step 1.3 replaces with the DocumentDB URI) |

### 0.2 Let the execution role read them
IAM → `cloudcart-ecs-task-execution-role` → Add permissions → inline policy `cloudcart-read-secrets`:
```json
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Action": "secretsmanager:GetSecretValue",
  "Resource": "arn:aws:secretsmanager:us-east-1:856698935369:secret:cloudcart/*" }] }
```
(Private subnets need the Secrets Manager VPC endpoint from Stage 2 Step 1.3, or NAT.)

### 0.3 Reference them from the task definitions
New revision of each family (JSON): keep the non-secret `environment` entries, add
```json
"secrets": [
  { "name": "JWT_SECRET",             "valueFrom": "arn:aws:secretsmanager:us-east-1:856698935369:secret:cloudcart/jwt-XXXXXX" },
  { "name": "INTERNAL_SERVICE_TOKEN", "valueFrom": "…:secret:cloudcart/internal-token-XXXXXX" },
  { "name": "DB_PASSWORD",            "valueFrom": "…:secret:cloudcart/db-password-XXXXXX" },
  { "name": "MONGODB_URI",            "valueFrom": "…:secret:cloudcart/mongodb-uri-XXXXXX" }
]
```
(only the ones each service needs — LLD §2). Because ECS-injected env vars take precedence over the baked `.env`, you can switch service by service.

### 0.4 Remove the `.env` from the images
Delete `/opt/script/cloudcart/*/.env` contents down to the **non-secret** keys (PORT, DB_HOST, URLs) or delete the files entirely and move those keys into the task-definition `environment`. Rebuild once via Jenkins (or Step 0.5 below). Now `docker run <image> env` shows no secrets.

### 0.5 Switch CI/CD to GitHub Actions (OIDC, keyless)
1. **IAM → Identity providers → Add**: OpenID Connect, URL `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
2. **IAM → Roles → Create → Web identity** → that provider, audience `sts.amazonaws.com`, GitHub org = your username, repo `cloudcart` → attach `AmazonEC2ContainerRegistryPowerUser` + the same inline deploy policy as `cloudcart-jenkins-role` → name `cloudcart-github-actions-role`. (Trust-policy detail in doc 07 §4.)
3. GitHub → repo → Settings → *Secrets and variables → Actions → Variables*: `AWS_REGION=us-east-1`, `AWS_ACCOUNT_ID=856698935369`, `AWS_ROLE_ARN=arn:aws:iam::856698935369:role/cloudcart-github-actions-role`, `ECS_CLUSTER=cloudcart-cluster`.
4. Push to `main` → **Actions** tab → `Build and deploy to ECS` runs six parallel jobs (one per service). *Run workflow* lets you pick a single service, like the Jenkins parameters.
5. Decommission Jenkins: stop the instance (keep the AMI for a month), delete the webhook/poll trigger. 📒 Ledger.

### ✅ Verify
- Task → *Configuration → Environment*: secrets show as `valueFrom`, no plaintext.
- CloudTrail → `GetSecretValue` events from the execution role at each task start.
- A push deploys via Actions with zero downtime; the ECR image pulled by `docker run … env` contains no `JWT_SECRET`.
- `docker history <image>` shows no `.env` layer.

📒 Ledger: 4 secrets, OIDC provider, `cloudcart-github-actions-role`.

---

## Step 1 — High availability for data (30 min + waits)

### 1.1 RDS Multi-AZ
RDS → `cloudcart-postgres` → **Modify** → Availability & durability: **Multi-AZ DB instance** → also raise *Backup retention* to **7 days**, enable **Deletion protection**, **Performance Insights** (7-day free tier) → *Apply immediately*. Takes ~10 min; a **standby in AZ b** gets synchronous replication and automatic failover (DNS endpoint stays the same).

> 💰 Doubles the RDS cost (≈ ₹66/day for t4g.micro). For a demo, turn it on, test failover (**Actions → Reboot with failover** — watch the app recover in ~60 s), then turn it off.

### 1.2 ElastiCache replica
ElastiCache → `cloudcart-redis` → **Add replica** (1), **Multi-AZ** enabled, **Automatic failover** on. The *primary endpoint* stays valid across failovers.

### 1.3 Amazon DocumentDB (replaces Atlas, keeps user data inside the VPC)

**DocumentDB → Clusters → Create**

| Field | Value | Why |
|-------|-------|-----|
| Cluster type | **Instance-based cluster** | elastic clusters are for sharding at scale |
| Cluster identifier | `cloudcart-docdb` | |
| Engine version | 5.0 | MongoDB 5 API compatible — Mongoose 8 works |
| Instance class | **db.t3.medium** | the smallest available (no micro) — ≈ ₹150/day |
| Number of instances | **1** (2 for real HA) | |
| Authentication → username / password | `cloudcart` / strong | ⚠️ `admin` is reserved |
| Show advanced settings → Network | VPC `cloudcart-vpc`, **new subnet group** on the private subnets, SG `cloudcart-data-sg` | 27017 already allowed |
| Encryption | on | |
| Backup retention | 7 days | |
| Tags | `Project` = `cloudcart` | |

DocumentDB **requires TLS**. The auth-service already passes `MONGODB_URI` straight to Mongoose, so the URI carries the TLS options:

```
mongodb://cloudcart:PASSWORD@cloudcart-docdb.cluster-xxxx.us-east-1.docdb.amazonaws.com:27017/cloudcart_auth?tls=true&tlsCAFile=/app/global-bundle.pem&replicaSet=rs0&readPreference=secondaryPreferred&retryWrites=false
```

Add the CA bundle to the image: in `services/auth-service/Dockerfile`, before `COPY . .`:
```dockerfile
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/global-bundle.pem
```
Rebuild/push (CI/CD does it), update the `cloudcart/mongodb-uri` secret, redeploy `cc-auth`. Migrate the 3 seed users? Not needed — auth-service re-seeds an empty database on boot.

### ✅ Verify
- Login works; Atlas can be deleted (📒 remove from ledger).
- RDS → *Multi-AZ: Yes*, secondary AZ shown. ElastiCache → 2 nodes.
- DocumentDB → cluster *available*; Session Manager → `mongosh --tls --tlsCAFile global-bundle.pem --host <endpoint> -u cloudcart -p` lists `cloudcart_auth`.

---

## Step 2 — Compute across two AZs (15 min)

- ASG → Edit → **Min 2, Desired 2, Max 4**; subnets = both private subnets (already). ASG balances instances across AZs.
- Each ECS service → Update → **Placement strategy**: `spread` on `attribute:ecs.availability-zone` then `binpack` on memory → tasks land on different AZs.
- Add a **second NAT gateway** in `cloudcart-subnet-public2-us-east-1b` and point `cloudcart-rtb-private2` at it (so AZ b doesn't depend on AZ a's NAT).

### ✅ Verify
ECS → cluster → Tasks → *Availability zone* column shows both `us-east-1a` and `us-east-1b`. Terminate one EC2 host from the EC2 console → the ASG replaces it within ~3 min and the site stays up (ALB drains the dead targets in 30 s).

---

## Step 3 — CloudFront + WAF at the edge (45 min)

### 3.1 Why
CloudFront caches static files (HTML/CSS/JS/images) at 600+ edge locations so a user in São Paulo doesn't fetch `style.css` from N. Virginia, terminates TLS close to the user, absorbs DDoS (Shield Standard is free), and is where **WAF** inspects every request before it reaches your ALB.

### 3.2 Certificate for CloudFront — must be in **us-east-1**
Good news: that is already our region, so the Stage 2 certificate can be reused by CloudFront. (If you ever run this in another region, CloudFront still needs its own cert requested in us-east-1.)

### 3.3 Distribution
**CloudFront → Create distribution**

| Field | Value | Why |
|-------|-------|-----|
| Origin domain | `cloudcart-alb-….us-east-1.elb.amazonaws.com` | |
| Protocol | **HTTPS only**, origin SSL TLSv1.2 | |
| Origin name | `alb-origin` | |
| **Add custom header** | `X-Origin-Verify: <long random string>` | later the ALB only accepts requests carrying this → nobody can bypass CloudFront/WAF by hitting the ALB directly |
| Default cache behavior → Viewer protocol | **Redirect HTTP to HTTPS** | |
| Allowed HTTP methods | **GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE** | the API needs POST/PUT/DELETE |
| Cache policy | **CachingOptimized** | for static assets |
| Origin request policy | **AllViewerExceptHostHeader** | forwards `Authorization`, cookies, query strings; keeps ALB happy on Host |
| Alternate domain name (CNAME) | `shop.yourdomain.com` | |
| Custom SSL certificate | the **us-east-1** cert | |
| Price class | **Use only North America and Europe** (cheapest) or **All** if you want to show global edge | |
| WAF | **Enable security protections** (creates a web ACL with managed rules) | or attach your own below |
| Tags | `Project` = `cloudcart` | |

**Add a second behavior**: Path pattern `/api/*` → same origin → Cache policy **CachingDisabled** → Origin request policy **AllViewerExceptHostHeader**. API responses must never be cached.

### 3.4 WAF rules
**WAF & Shield → Web ACLs → (the one CloudFront created, region *Global*) → Rules → Add rules**:

| Rule | Type | Purpose |
|------|------|---------|
| `AWSManagedRulesCommonRuleSet` | managed | XSS, LFI, protocol anomalies |
| `AWSManagedRulesSQLiRuleSet` | managed | SQL injection patterns |
| `AWSManagedRulesKnownBadInputsRuleSet` | managed | Log4j etc. |
| `rate-limit-otp` | **Rate-based**, 100 req / 5 min per IP, scope-down: URI path starts with `/api/auth/request-otp` | stops OTP spam |
| `block-internal-paths` | **Custom**: URI path contains `/internal/` → **Block** | internal endpoints never reachable from the edge |
| `AmazonIpReputationList` | managed | known bad IPs |

Set the web ACL **default action: Allow**. Check **Sampled requests** after a few minutes of traffic.

### 3.5 Lock the ALB to CloudFront only
EC2 → `cloudcart-alb` → HTTPS:443 listener → **Default rule** → Edit → add condition **HTTP header** `X-Origin-Verify` = your random string → keep forwarding; then add a new lowest-priority rule with **no header → Fixed response 403**. Also replace `cloudcart-alb-sg` inbound `0.0.0.0/0` with the **CloudFront managed prefix list** (`com.amazonaws.global.cloudfront.origin-facing`).

### 3.6 Point DNS at CloudFront
Route 53 → `shop` A record → Edit → Alias to **CloudFront distribution** → `dxxxx.cloudfront.net`.

### ✅ Verify
- `curl -I https://shop.yourdomain.com/style.css` twice → second response `x-cache: Hit from cloudfront`.
- `curl -I https://shop.yourdomain.com/api/products` → `x-cache: Miss from cloudfront` **every** time (not cached).
- `curl -I https://<alb-dns>/` directly → **403** (locked to CloudFront).
- `curl "https://shop.yourdomain.com/api/products?q=1' OR '1'='1"` → **403** from WAF.
- Loop 120 × `POST /api/auth/request-otp` → after ~100 you get 403 (rate limit).

📒 Ledger: CloudFront distribution, us-east-1 cert, web ACL (≈ ₹14/day + ₹0.6 per million requests), prefix-list rule.

---

## Step 4 — Global Accelerator (optional, 15 min)

**When it makes sense:** your users are worldwide *and* your traffic is mostly API (which CloudFront doesn't cache). GA gives two **static anycast IPs** and routes users over the AWS backbone to the nearest healthy ALB — later, to ALBs in *multiple regions*.

**Global Accelerator → Create accelerator**: name `cloudcart-ga`, type Standard → Listener TCP 443 → Endpoint group us-east-1 → Endpoint: `cloudcart-alb` → Create. Point `api.yourdomain.com` at the GA DNS name if you want to demo it.

💰 ≈ ₹45/day fixed + data. **Not needed for a single-region demo**; create it, measure latency from a different region (e.g. an EC2 in `us-east-1` running `curl -w %{time_connect}`), then delete it.

---

## Step 5 — EFS for shared files (only if you need it, 20 min)

Needed only when tasks must **share writable files** (user uploads, generated reports). CloudCart doesn't — product images are URLs — so this is a pure learning step.

1. **EFS → Create file system**: name `cloudcart-efs`, VPC `cloudcart-vpc`, **Customize** → Lifecycle: transition to IA after 30 days, Performance: *Elastic*, Encryption on → mount targets in both **private** subnets with a new SG `cloudcart-efs-sg` (inbound **NFS 2049** from `cloudcart-app-sg`).
2. Task definition `cc-product` → new revision → **Volumes → Add volume → EFS** → file system `cloudcart-efs`, root `/`, transit encryption on → container **mount point** `/app/uploads`.
3. Update service. Session Manager on a host → `docker exec -it <product container> ls /app/uploads` (empty, but mounted).

### ✅ Verify
EFS → file system → *Mount targets: 2 available*. Write a file from one task, read it from another host's task.

📒 Ledger: EFS (pay per GB, near zero empty), `cloudcart-efs-sg`, 2 mount targets.

---

## Step 6 — Backups, recovery and runbooks (30 min)

| What | How | Test it (don't skip) |
|------|-----|----------------------|
| RDS point-in-time | automated backups 7 days (done) | **Actions → Restore to point in time** → new identifier `cloudcart-postgres-restore` → verify data → delete it |
| RDS manual snapshot before every risky change | Actions → Take snapshot | restore from snapshot once |
| DocumentDB backups | 7-day retention (done) | same restore drill |
| ECR | immutable tags for prod (`:v1.2.3`), keep 10 | roll back = update service to previous task-def revision (ECS keeps every revision) |
| Task-def rollback | ECS → service → Update → pick **previous revision** | do it once on purpose and time it (≈ 2 min) |
| AWS Backup | Backup plans → *Daily-35day-Retention* template → assign by tag `Project=cloudcart` | check the vault has recovery points next day |
| Secrets rotation | Secrets Manager → `cloudcart/db-password` → Rotation → Lambda template for RDS PostgreSQL | app reconnects on next pool connection |

**Runbooks** — write one page each (template in [08-devops-checklist.md](08-devops-checklist.md)):
1. *Site returns 502* · 2. *Deploy went bad — roll back* · 3. *RDS failover happened* · 4. *Suspicious traffic* · 5. *Cost spike*.

---

## Step 7 — Security posture (30 min)

| Control | Where | Setting |
|---------|-------|---------|
| ECR scanning | ECR → Private registry → Scanning → **Enhanced** (Inspector) | fixes CVEs listed per image; rebuild on base-image bumps |
| Immutable image tags | each repo → Edit → Tag immutability **on** | pin task defs to `:vX` tags, never `latest` |
| ALB TLS policy | listener → `ELBSecurityPolicy-TLS13-1-2-2021-06` | |
| HSTS | add `Strict-Transport-Security` response header via CloudFront **response headers policy** `SecurityHeadersPolicy` | |
| IAM Access Analyzer | IAM → Access analyzer → create | flags public/cross-account access |
| GuardDuty | enable (30-day free trial) | threat detection on VPC flow logs, DNS, CloudTrail |
| CloudTrail | one trail to S3, all regions | who changed what |
| VPC Flow Logs | VPC → Flow logs → to CloudWatch `/vpc/cloudcart` | network forensics |
| SG review | no `0.0.0.0/0` except CloudFront prefix list on alb-sg | |
| Non-root containers | already (`USER node`) | |
| Read-only root FS | task def → `readonlyRootFilesystem: true` + `/tmp` tmpfs | hardening (test: services write no files) |
| Secrets in logs | Logs Insights query `filter @message like /password|secret|token/` → expect 0 | |

---

## Step 8 — Performance & cost polish

- **Reserved capacity**: once the shape is stable, a 1-year **Compute Savings Plan** cuts EC2 ~30 %; **RDS reserved instance** ~35 %. Not for a demo — but know the lever.
- **Graviton everywhere**: `t4g.small` hosts (arm64) need multi-arch images: `docker buildx build --platform linux/amd64,linux/arm64`. ~20 % cheaper.
- **Right-size** with Container Insights: if a service sits at 5 % CPU / 60 MB, lower its reservation; more tasks fit per host.
- **Spot** for the second/third host: capacity provider on a **Spot ASG** with `capacity-optimized` strategy (On-demand base 1 via the first provider).
- **Cost Anomaly Detection**: Billing → Cost Anomaly Detection → monitor by service, alert ≥ $5.

---

## ✅ Go-live checklist (what you must have before a real client)

| Area | Non-negotiable | Nice to have |
|------|----------------|--------------|
| Network | private hosts, NAT per AZ, SG chain, no 0.0.0.0/0 to hosts/DB | VPC endpoints for all AWS calls |
| Edge | HTTPS, HTTP→HTTPS, WAF managed rules, ALB locked to CloudFront | Global Accelerator, custom WAF rules |
| Compute | ≥ 2 hosts across AZs, service auto scaling, 100/200 deploys, health checks on `/health` | Spot for burst, Graviton |
| Data | Multi-AZ RDS, 7-day backups, **restore tested**, deletion protection, encryption at rest | read replica, RDS Proxy |
| Secrets | Secrets Manager, no secrets in git/images/env dumps | rotation |
| Observability | logs with retention, 4+ alarms to a human, dashboard | Container Insights, X-Ray tracing |
| Delivery | keyless CI/CD (GitHub Actions OIDC) with rollback tested | blue/green (CodeDeploy), canary |
| Ops | runbooks ×5, on-call contact, budget + anomaly alerts | game-day (kill a host, fail over RDS) |
| Compliance | CloudTrail, tags on everything, IAM least privilege reviewed | GuardDuty, Access Analyzer |

---

## ✅ Stage 3 done when

- [ ] Secrets live only in Secrets Manager; images contain no `.env`; GitHub Actions deploys keylessly
- [ ] You killed an EC2 host and failed over RDS — users never noticed
- [ ] Direct ALB access returns 403; WAF blocked an injection and rate-limited OTP spam
- [ ] `x-cache: Hit from cloudfront` on static, `Miss` on API
- [ ] A point-in-time restore produced a working copy of the database
- [ ] All items in the "non-negotiable" column above are ticked
- [ ] 📌 **Commit and push**, then **tear down** using [09](09-cost-and-teardown.md) — Stage 3 costs real money per day

➡️ [07 · IAM roles](07-iam-roles-and-policies.md) · [08 · DevOps checklist](08-devops-checklist.md) · [09 · Cost & teardown](09-cost-and-teardown.md)
