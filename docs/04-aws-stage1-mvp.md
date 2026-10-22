# 04 · 🟢 AWS Stage 1 — MVP ("it runs on AWS")

> ⏱️ **Time:** 3–4 hours the first time · 💰 **Cost while running:** ≈ ₹130 / day (≈ $1.5) · 🎯 **Goal:** CloudCart reachable from any browser in the world via the ALB's DNS name, every service healthy, every datastore connected — using only the AWS console (plus one script to push images).

---

## 🗺️ What you will build

```mermaid
flowchart LR
    U([🌍 Anyone]) -->|HTTP :80| ALB

    subgraph VPC["cloudcart-vpc 10.0.0.0/16 · us-east-1"]
        subgraph PUB["Public subnets (a, b)"]
            ALB["⚖️ cloudcart-alb<br/>6 target groups · 5 path rules"]
            EC2["🖥️ 1 × t3.small (ECS host)<br/>public IP · SSM + key pair<br/>6 tasks + 3 redis sidecars"]
            BAS["🛡️ cloudcart-bastion t3.micro<br/>SSH from your IP + SSM<br/>psql / mongosh to the DBs"]
            JEN["🔧 cloudcart-jenkins t3.medium<br/>code checkout · .env files · builds → ECR → ECS"]
        end
        subgraph PRIV["Private subnets (a, b)"]
            RDS[("🐘 RDS PostgreSQL<br/>db.t4g.micro")]
        end
    end
    ALB --> EC2
    EC2 --> RDS
    BAS --> RDS
    JEN -->|push| ECR
    JEN -->|update-service| EC2
    EC2 -->|internet| ATLAS[("🍃 MongoDB Atlas M0<br/>(free, outside AWS)")]
    EC2 -->|pull| ECR[("📦 ECR · 6 repos")]
    EC2 -->|logs| CW["📊 CloudWatch Logs"]
    EC2 -.->|service-to-service via ALB DNS| ALB
```

**Deliberate Stage 1 shortcuts** (each one is fixed in Stage 2):

| Shortcut | Why it's OK for now | Fixed by |
|----------|---------------------|----------|
| ECS host in a **public** subnet with a public IP | avoids a NAT gateway (₹90/day); the security group still blocks everything except the ALB and the bastion | Stage 2 moves it to private + NAT (like TSRS) |
| **Redis as sidecar** containers | zero cost, nothing extra to create | Stage 2 ElastiCache |
| Secrets as **`.env` files on the Jenkins server** (copied into the image at build time) + plain task-definition env vars | exactly how the real TSRS pipeline works today; one less service to learn | Stage 3 Secrets Manager |
| **HTTP only** | no domain needed | Stage 2 ACM + HTTPS |
| Services call each other **through the ALB** | works with zero extra config | Stage 2 Service Connect |

---

## 📒 Your ledger

Open [09-cost-and-teardown.md](09-cost-and-teardown.md) in another tab and **write down every resource as you create it**. The teardown order at the end depends on it. The symbol 📒 below means "add this to the ledger".

---

## Step 0 — Account preparation (10 min)

### 0.1 Pick the region 🌏

Top-right of the console → region dropdown → **US East (N. Virginia) `us-east-1`**.

> 💡 **Why us-east-1?** Every AWS service launches here first, it is the cheapest region, and the CloudFront certificate in Stage 3 must live here anyway — one region for everything. Latency from India is ~200 ms, which is fine for a demo. Everything in this guide assumes `us-east-1`. **Every screen below must show this region** — the #1 beginner mistake is creating the VPC in one region and the cluster in another.

### 0.2 Set a budget alarm 💸

AWS Budgets → **Create budget** → *Use a template* → **Monthly cost budget**

| Field | Value | Why |
|-------|-------|-----|
| Budget name | `cloudcart-monthly` | |
| Budgeted amount | `15` (USD) | ≈ ₹1,250 — above what Stage 1 should cost in a month of evenings |
| Email recipients | your email | you get mails at 85 % and 100 % |

### 0.3 Decide your tag 🏷️

On **every** resource that has a *Tags* section, add `Project` = `cloudcart`. At the end, *Resource Groups → Tag Editor* will list everything carrying this tag so nothing is forgotten.

### 0.4 Create the MongoDB Atlas cluster (outside AWS, free) 🍃

1. https://www.mongodb.com/atlas → sign up → **Create** → **M0 Free** → Provider **AWS**, Region **N. Virginia (us-east-1)**, name `cloudcart` → Create.
2. **Security → Database Access → Add new database user**: username `cloudcart`, a strong password (save it), role *Read and write to any database*.
3. **Security → Network Access → Add IP address** → **Allow access from anywhere** (`0.0.0.0/0`). ⚠️ Fine for Stage 1 because the user has a strong password; in Stage 2 you'll restrict this to your NAT gateway's IP.
4. **Connect → Drivers** → copy the URI. Replace `<password>` and add the database name **`/cloudcart_auth`** before the `?` (Atlas gives you the URI without a database; without this, Mongoose writes to `test`):
   `mongodb+srv://cloudcart:YOURPASSWORD@cloudcart.4dxau2t.mongodb.net/cloudcart_auth?retryWrites=true&w=majority`
   (`?compressors=zlib` from the Atlas page is optional; keep it or drop it.)

✅ Done 2026-10-22: cluster `cloudcart`, user `cloudcart`, host `cloudcart.4dxau2t.mongodb.net`.

📒 Ledger: *Atlas cluster `cloudcart` (free — delete at the end anyway)*

---

## Step 1 — VPC and subnets (15 min)

**VPC → Your VPCs → Create VPC**

| Field | Value | Why |
|-------|-------|-----|
| Resources to create | **VPC and more** | the wizard also makes subnets, route tables, IGW — correctly wired |
| Name tag auto-generation | ✅ Auto-generate, text: `cloudcart` | names everything `cloudcart-vpc`, `cloudcart-subnet-public1-us-east-1a`… |
| IPv4 CIDR block | `10.0.0.0/16` | 65k addresses; room for Stage 2/3 extra subnets. Must not overlap anything you may peer with later |
| IPv6 CIDR block | **No IPv6 CIDR block** | nothing here needs IPv6 |
| Tenancy | **Default** | *Dedicated* = physically isolated hardware, ~$2/hour minimum |
| Number of Availability Zones | **2** | ALB and RDS subnet groups **require** ≥ 2 AZs |
| Number of public subnets | **2** | one per AZ, for the ALB (and, in Stage 1, the ECS host) |
| Number of private subnets | **2** | one per AZ, for RDS now and ECS hosts in Stage 2 |
| Customize subnets CIDR blocks | leave auto: public `10.0.0.0/20`, `10.0.16.0/20`; private `10.0.128.0/20`, `10.0.144.0/20` | /20 = 4,096 IPs each; plenty |
| NAT gateways ($) | **None** | hosts are in public subnets in Stage 1, so nothing in a private subnet needs internet yet. NAT is ~₹90/day — add it in Stage 2 |
| VPC endpoints | **S3 Gateway** | **free**; ECR stores image layers in S3, so pulls stay inside AWS |
| Enable DNS hostnames | ✅ | RDS endpoints are hostnames; services resolve them inside the VPC |
| Enable DNS resolution | ✅ | same |
| Tags | `Project` = `cloudcart` | |

Click **Preview code** (optional but educational — it shows the CloudFormation the wizard runs) → **Create VPC**. Wait for the green progress list to finish (~1 min) → **View VPC**.

### ✅ Verify

VPC → **Your VPCs** → `cloudcart-vpc` → **Resource map** tab. You should see: 1 VPC → 4 subnets → 3 route tables → 1 internet gateway + 1 S3 endpoint.

- Click `cloudcart-rtb-public` → **Routes**: `0.0.0.0/0 → igw-…`. That one route is what makes a subnet "public".
- Click `cloudcart-rtb-private1-…` → Routes: only `10.0.0.0/16 local` and the S3 prefix list. No internet route — that is what "private" means.

📒 Ledger: VPC `cloudcart-vpc` (vpc-…), 4 subnets, IGW, 3 route tables, S3 endpoint.

---

## Step 2 — Security groups (15 min)

Three groups, chained. **Order matters** — each one references the previous.

**EC2 → Network & Security → Security Groups → Create security group** (×3)

### 2.1 `cloudcart-alb-sg`

| Field | Value |
|-------|-------|
| Name | `cloudcart-alb-sg` |
| Description | `Internet -> ALB` |
| VPC | `cloudcart-vpc` ⚠️ change from default |
| Inbound rule 1 | Type **HTTP**, Source **Anywhere-IPv4** `0.0.0.0/0` |
| Inbound rule 2 | Type **HTTPS**, Source **Anywhere-IPv4** (unused until Stage 2, harmless) |
| Outbound | leave default (All traffic) |
| Tags | `Project` = `cloudcart` |

### 2.2 `cloudcart-app-sg`

| Field | Value |
|-------|-------|
| Name | `cloudcart-app-sg` |
| Description | `ALB -> ECS hosts` |
| VPC | `cloudcart-vpc` |
| Inbound rule 1 | Type **Custom TCP**, Port range **32768-65535**, Source → start typing `cloudcart-alb` and pick **cloudcart-alb-sg** |
| Outbound | default |

> 🧠 **Why 32768-65535 and not 5001-5005?** ECS on EC2 with *bridge* networking maps each container port to a **random host port** in this "ephemeral" range (that's how several copies of one service can share a host). The ALB learns the random port from ECS and sends traffic there. The source is the ALB's *security group*, so only the ALB can reach the hosts — not the internet, even though the host has a public IP.
> 🧠 **No SSH rule.** We log in with SSM Session Manager (Step 3), which needs no inbound port at all.

### 2.3 `cloudcart-data-sg`

| Field | Value |
|-------|-------|
| Name | `cloudcart-data-sg` |
| Description | `ECS hosts -> databases` |
| VPC | `cloudcart-vpc` |
| Inbound rule 1 | Type **PostgreSQL** (5432), Source **cloudcart-app-sg** |
| Inbound rule 2 | Type **Custom TCP** 6379, Source **cloudcart-app-sg** (for ElastiCache in Stage 2) |
| Inbound rule 3 | Type **Custom TCP** 27017, Source **cloudcart-app-sg** (for DocumentDB in Stage 3) |
| Outbound | default |

### 2.4 `cloudcart-bastion-sg`

| Field | Value |
|-------|-------|
| Name | `cloudcart-bastion-sg` |
| Description | `My IP -> bastion (SSH)` |
| VPC | `cloudcart-vpc` |
| Inbound rule 1 | Type **SSH** (22), Source **My IP** |
| Outbound | default |

> 🧠 Why both SSH *and* SSM on the bastion? SSM Session Manager is the no-port way in; the key pair is the fallback when SSM is broken (agent down, IAM mistake). Your home IP changes — when SSH times out, edit this rule's source first.

### 2.5 `cloudcart-jenkins-sg`

| Field | Value |
|-------|-------|
| Name | `cloudcart-jenkins-sg` |
| Description | `Jenkins UI + SSH` |
| VPC | `cloudcart-vpc` |
| Inbound rule 1 | Type **Custom TCP** 8080, Source **My IP** (Jenkins web UI) |
| Inbound rule 2 | Type **SSH** (22), Source **cloudcart-bastion-sg** (reach Jenkins via the bastion, like TSRS) |
| Outbound | default |

### 2.6 Extra rules on the groups above

- **`cloudcart-data-sg` → Inbound → Add**: PostgreSQL 5432 **and** Custom TCP 27017 from **`cloudcart-bastion-sg`** — so `psql`/`mongosh` from the bastion can reach the databases.
- **`cloudcart-app-sg` → Inbound → Add**: SSH 22 from **`cloudcart-bastion-sg`** — so you can hop to an ECS host with the key pair if SSM is unavailable.

### 2.7 One more rule: let the hosts call the ALB

Services call each other **via the ALB** in Stage 1, and the call originates from the ECS host. Open **`cloudcart-alb-sg` → Inbound rules → Edit → Add rule**: Type **HTTP**, Source **cloudcart-app-sg**. Without this, `order-service` gets a timeout when it calls `cart-service` and checkout fails with 409.

### ✅ Verify

Security Groups list filtered by `cloudcart` shows **5** groups. Open `cloudcart-data-sg` → Inbound: four rules, the *Source* column shows `sg-…` ids (app-sg and bastion-sg), not IPs.

📒 Ledger: 5 security groups.

---

## Step 3 — IAM roles (10 min)

Four roles now (full catalogue with reasons in [07-iam-roles-and-policies.md](07-iam-roles-and-policies.md)).

**IAM → Roles → Create role**

### 3.1 `cloudcart-ecs-instance-role` — worn by the EC2 host

| Screen | Value |
|--------|-------|
| Trusted entity type | **AWS service** |
| Use case | **EC2** → Next |
| Permissions policies (search and tick) | `AmazonEC2ContainerServiceforEC2Role` *(lets the host register with ECS, pull from ECR, write logs)* and `AmazonSSMManagedInstanceCore` *(lets you open a Session Manager shell — replaces SSH)* |
| Role name | `cloudcart-ecs-instance-role` |
| Tags | `Project` = `cloudcart` |

### 3.2 `cloudcart-ecs-task-execution-role` — used by the ECS agent to *start* tasks

| Screen | Value |
|--------|-------|
| Trusted entity type | **AWS service** |
| Use case | search **Elastic Container Service** → choose **Elastic Container Service Task** → Next |
| Permissions | `AmazonECSTaskExecutionRolePolicy` *(pull images from ECR, create log streams)* |
| Role name | `cloudcart-ecs-task-execution-role` |

> 🧠 **Instance role vs execution role vs task role** — three different "who":
> • *instance role* → the EC2 machine itself
> • *execution role* → the ECS agent, when it pulls your image and ships logs (and, in Stage 2, reads secrets)
> • *task role* → **your application code** calling AWS APIs (e.g. auth-service sending via SES). None of our Stage 1 code calls AWS APIs, so no task role yet.

### 3.3 `cloudcart-bastion-role` — worn by the bastion EC2

| Screen | Value |
|--------|-------|
| Trusted entity | AWS service → **EC2** |
| Permissions | `AmazonSSMManagedInstanceCore` only |
| Role name | `cloudcart-bastion-role` |

### 3.4 `cloudcart-jenkins-role` — worn by the Jenkins EC2 (so the pipeline needs no AWS keys)

| Screen | Value |
|--------|-------|
| Trusted entity | AWS service → **EC2** |
| Permissions | `AmazonEC2ContainerRegistryPowerUser` *(docker push/pull)*, `AmazonSSMManagedInstanceCore` *(shell)* |
| Inline policy `cloudcart-jenkins-deploy` (add after creation: role → Add permissions → Create inline policy → JSON) | see below |
| Role name | `cloudcart-jenkins-role` |

```json
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow", "Action": ["ecs:UpdateService", "ecs:DescribeServices"],
    "Resource": "arn:aws:ecs:us-east-1:856698935369:service/cloudcart-cluster/*" },
  { "Effect": "Allow", "Action": ["ecs:DescribeTaskDefinition", "ecs:ListTaskDefinitions"], "Resource": "*" }
]}
```

### ✅ Verify
IAM → Roles → search `cloudcart` → 4 roles. Open the instance role → **Trust relationships**: `"Service": "ec2.amazonaws.com"`.

📒 Ledger: 4 IAM roles.

---

## Step 4 — ECR repositories and image push (20 min)

### 4.1 Create 6 repositories

**ECR → Private registry → Repositories → Create repository** (×6)

| Field | Value |
|-------|-------|
| Repository name | `cloudcart/auth-service`, `cloudcart/product-service`, `cloudcart/cart-service`, `cloudcart/order-service`, `cloudcart/payment-service`, `cloudcart/frontend` |
| Image tag mutability | **Mutable** (so `latest` can be overwritten) |
| Scan on push | ✅ Enabled (free basic scanning; you'll see CVEs per image) |
| Encryption | AES-256 (default) |

### 4.2 Create the key pair (for the bastion, Jenkins and ECS hosts)

**EC2 → Key pairs → Create key pair**: Name `cloudcart-key`, type **RSA**, format **.pem** (Mac/Git Bash) or **.ppk** (PuTTY). The file downloads once — keep it in a safe folder, `chmod 400 cloudcart-key.pem`. 📒 Ledger.

### 4.3 Launch the Jenkins server

**EC2 → Launch instance**

| Field | Value | Why |
|-------|-------|-----|
| Name | `cloudcart-jenkins` | |
| AMI | **Amazon Linux 2023** | `dnf` + Corretto Java available |
| Instance type | **t3.medium** (2 vCPU / 4 GiB) | Jenkins + Docker builds need ~3 GB; t3.small swaps |
| Key pair | `cloudcart-key` | |
| Network → VPC / Subnet | `cloudcart-vpc` / `cloudcart-subnet-public1-us-east-1a` | public in Stage 1 (TSRS keeps it private + bastion — Stage 2 moves it) |
| Auto-assign public IP | **Enable** | |
| Security group | **Select existing** → `cloudcart-jenkins-sg` | |
| Storage | **30 GiB** gp3 | images + workspaces |
| Advanced → IAM instance profile | `cloudcart-jenkins-role` | |
| Advanced → User data | paste the script below | installs Java, Jenkins, Docker, git, AWS CLI unattended |
| Tags | `Project=cloudcart` | |

```bash
#!/bin/bash
dnf update -y
dnf install -y java-17-amazon-corretto docker git
curl -fsSL https://pkg.jenkins.io/redhat-stable/jenkins.repo -o /etc/yum.repos.d/jenkins.repo
rpm --import https://pkg.jenkins.io/redhat-stable/jenkins.io-2023.key
dnf install -y jenkins
systemctl enable --now docker
usermod -aG docker jenkins
systemctl enable --now jenkins
mkdir -p /opt/script/cloudcart/{auth,product,cart,order,payment}
chown -R jenkins:jenkins /opt/script/cloudcart && chmod 700 /opt/script/cloudcart
```

Wait ~4 min, then open `http://<jenkins-public-ip>:8080`. Get the unlock password via **Session Manager** (Connect → Session Manager): `sudo cat /var/lib/jenkins/secrets/initialAdminPassword`. Install *suggested plugins*, create your admin user.

> 🧠 **Why no AWS keys in Jenkins?** The instance role `cloudcart-jenkins-role` is attached to the machine; the AWS CLI and `docker login` pick it up automatically. The TSRS Jenkins works the same way.

### 4.4 Put the runtime config on the Jenkins server (`/opt/script/cloudcart/<service>/.env`)

This mirrors TSRS's `/opt/script/tsrs-prod/<service>/.env`. The pipeline copies the matching file into the service folder right before `docker build`, so the image carries its config. Create each file via Session Manager (`sudo -u jenkins nano /opt/script/cloudcart/auth/.env`):

```ini
# /opt/script/cloudcart/auth/.env
PORT=5001
NODE_ENV=production
JWT_SECRET=<random-40-chars — SAME in all five files>
INTERNAL_SERVICE_TOKEN=<random-40-chars — SAME in all five files>
MONGODB_URI=mongodb+srv://cloudcart:<password>@cloudcart.4dxau2t.mongodb.net/cloudcart_auth?retryWrites=true&w=majority
REDIS_HOST=redis
REDIS_PORT=6379
DEV_SHOW_OTP=true
AWS_REGION=us-east-1
```
```ini
# /opt/script/cloudcart/product/.env
PORT=5002
NODE_ENV=production
JWT_SECRET=...
INTERNAL_SERVICE_TOKEN=...
DB_HOST=<rds endpoint — fill after Step 5>
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=<rds master password>
DB_NAME=product_db
DB_SSL=true
REDIS_HOST=redis
REDIS_PORT=6379
CACHE_TTL_SECONDS=60
```
```ini
# /opt/script/cloudcart/cart/.env
PORT=5003
NODE_ENV=production
JWT_SECRET=...
INTERNAL_SERVICE_TOKEN=...
REDIS_HOST=redis
REDIS_PORT=6379
PRODUCT_SERVICE_URL=http://<alb dns — fill after Step 9>
```
```ini
# /opt/script/cloudcart/order/.env
PORT=5004
NODE_ENV=production
JWT_SECRET=...
INTERNAL_SERVICE_TOKEN=...
DB_HOST=<rds endpoint>
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=<rds master password>
DB_NAME=order_db
DB_SSL=true
CART_SERVICE_URL=http://<alb dns>
PRODUCT_SERVICE_URL=http://<alb dns>
```
```ini
# /opt/script/cloudcart/payment/.env
PORT=5005
NODE_ENV=production
JWT_SECRET=...
INTERNAL_SERVICE_TOKEN=...
DB_HOST=<rds endpoint>
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=<rds master password>
DB_NAME=payment_db
DB_SSL=true
ORDER_SERVICE_URL=http://<alb dns>
```
`chmod 600` each file. Two placeholders (RDS endpoint, ALB DNS) aren't known yet — you'll come back after Steps 5 and 9 and rebuild.

> ⚠️ Because the config is **inside the image**, every image is environment-specific and the ECR image contains secrets. That is the accepted trade-off of this pattern (and TSRS's). Stage 3 fixes it with Secrets Manager. Also: with `.env` in the image you can leave the task-definition `environment` list **empty** for those keys; if you set both, the task definition wins.

### 4.5 Create the Jenkins job and run it

Jenkins → **New Item** → name `cloudcart-deploy` → **Pipeline** → OK.
*Pipeline* section: Definition **Pipeline script from SCM**, SCM **Git**, Repository URL `https://github.com/<you>/cloudcart.git`, Branch `*/main`, Script Path `Jenkinsfile` → Save. (Edit `GIT_URL` in the Jenkinsfile to your repo first; for a private repo add a GitHub PAT under *Credentials* and set `JENKINS_CREDENTIALS_ID`.)

Click **Build with Parameters** → BRANCH `main`, SERVICE `all` → Build. The first run only needs to reach the end of **Docker Build and Push** (the *ECS Deployment* stage will fail until Step 12 exists — that's expected; re-run after Step 12).

Laptop fallback if Jenkins isn't ready: `./scripts/build-and-push-ecr.sh 856698935369 us-east-1` (needs AWS CLI configured) — note this path **does not** bake `.env`, so the task-definition JSONs must carry all env vars.

### ✅ Verify
ECR → each repository shows images tagged `latest` **and** `<timestamp>`, with a *Scan status*. Jenkins job console ends with `✅ Image pushed` ×6. Click `cloudcart/frontend` → image → note the **Image URI** format — the task definitions need it.

📒 Ledger: 6 ECR repos (negligible), **Jenkins EC2 `cloudcart-jenkins` t3.medium ≈ ₹90/day** (stop it when not building: Instance state → Stop; Jenkins restarts on start), key pair `cloudcart-key`.

---

## Step 5 — RDS PostgreSQL (15 min + 10 min wait)

### 5.1 DB subnet group

**RDS → Subnet groups → Create DB subnet group**

| Field | Value |
|-------|-------|
| Name | `cloudcart-db-subnets` |
| Description | `private subnets for cloudcart databases` |
| VPC | `cloudcart-vpc` |
| Availability Zones | `us-east-1a`, `us-east-1b` |
| Subnets | tick **only** the two **private** subnets (`10.0.128.0/20`, `10.0.144.0/20`) |

### 5.2 Database

**RDS → Databases → Create database**

| Field | Value | Why |
|-------|-------|-----|
| Creation method | **Standard create** | the *Easy create* path hides the network settings |
| Engine | **PostgreSQL**, latest 16.x | |
| Templates | **Free tier** (if offered) else **Dev/Test** | Free tier forces single-AZ + small instance |
| Availability & durability | **Single DB instance** | Multi-AZ doubles cost; Stage 3 |
| DB instance identifier | `cloudcart-postgres` | |
| Master username | `postgres` | |
| Credentials management | **Self managed** | *Managed in Secrets Manager* is Stage 2 |
| Master password | strong, **save it** | |
| DB instance class | **Burstable classes → db.t4g.micro** | cheapest (Graviton); db.t3.micro if t4g isn't listed |
| Storage type | **gp3**, Allocated **20** GiB | |
| Storage autoscaling | ❌ **untick** | so a runaway table can't grow your bill |
| Compute resource | **Don't connect to an EC2 compute resource** | we handle SGs ourselves |
| Network type | IPv4 | |
| VPC | `cloudcart-vpc` | |
| DB subnet group | `cloudcart-db-subnets` | |
| Public access | **No** | *the* most important security setting here |
| VPC security group | **Choose existing** → `cloudcart-data-sg`, and **remove `default`** | |
| Availability Zone | No preference | |
| RDS Proxy | ❌ | |
| Certificate authority | default | |
| Database authentication | **Password authentication** | |
| Monitoring | untick *Enable Performance Insights* and *Enhanced monitoring* for now | free tier of PI exists but keep it simple |
| **Additional configuration** ▶ (expand it!) | Initial database name: **leave empty** | we create the 3 databases ourselves in Step 10 |
| Backup | ✅ automated backups, retention **1 day** | minimum; Stage 2 raises it |
| Encryption | ✅ (default) | |
| Maintenance | leave defaults | |
| Deletion protection | ❌ off | you *will* delete this; turn on in Stage 3 |
| Tags | `Project` = `cloudcart` | |

**Create database** → status *Creating* for ~8–10 minutes. Continue with Step 6 meanwhile.

### ✅ Verify (when *Available*)
Click `cloudcart-postgres` → **Connectivity & security**: copy the **Endpoint** (`cloudcart-postgres.xxxx.us-east-1.rds.amazonaws.com`). *Publicly accessible* must say **No**. Security group must be `cloudcart-data-sg`.

📒 Ledger: RDS `cloudcart-postgres` (**≈ ₹33/day** — the first thing to delete when pausing) + subnet group.

---

## Step 6 — CloudWatch log groups (5 min)

**CloudWatch → Logs → Log groups → Create log group** (×6)

| Field | Value |
|-------|-------|
| Log group name | `/ecs/cloudcart/frontend`, `/ecs/cloudcart/auth`, `/ecs/cloudcart/product`, `/ecs/cloudcart/cart`, `/ecs/cloudcart/order`, `/ecs/cloudcart/payment` |
| Retention setting | **1 week** | 
| Log class | Standard |

> 🧠 Without a retention setting, logs are kept **forever** and billed at $0.03/GB-month. Always set one.

📒 Ledger: 6 log groups.

---

## Step 7 — ECS cluster with an EC2 host (15 min)

**ECS → Clusters → Create cluster**

| Section | Field | Value | Why |
|---------|-------|-------|-----|
| Cluster configuration | Cluster name | `cloudcart-cluster` | |
| Infrastructure | AWS Fargate | ❌ untick | you asked for EC2 |
| | **Amazon EC2 instances** | ✅ tick | |
| Auto Scaling group | | **Create new ASG** | the console creates the launch template + ASG for you — no manual AMI hunting |
| | Provisioning model | **On-demand** | Spot can be interrupted; fine for Stage 2 experiments, not day one |
| | Container instance AMI | **Amazon Linux 2023** (ECS-optimized) | current, has `dnf` for installing psql later |
| | EC2 instance type | **t3.small** | 2 vCPU / 2 GiB — fits 6 tasks + 3 Redis sidecars. t3.micro (1 GiB) is too tight |
| | EC2 instance role | `cloudcart-ecs-instance-role` | from Step 3.1 |
| | Desired capacity | Minimum **1**, Maximum **1** | one host; Stage 2 raises max |
| | SSH key pair | **`cloudcart-key`** | SSM is the normal way in; the key is the fallback via the bastion (TSRS pattern) |
| | Root EBS volume size | **30** GiB | default; images need space |
| Network settings for EC2 instances | VPC | `cloudcart-vpc` | |
| | Subnets | the **two public** subnets | Stage 1 shortcut (no NAT) |
| | Security group | `cloudcart-app-sg` | |
| | Auto-assign public IP | **Turn on** | the host must reach ECR, Atlas and CloudWatch over the internet |
| Monitoring | Container Insights | off (Stage 2) | costs per metric |
| Tags | `Project` = `cloudcart` | |

**Create**. The cluster appears immediately; the EC2 instance takes 2–3 minutes to boot and register.

### ✅ Verify
- ECS → `cloudcart-cluster` → **Infrastructure** tab → *Container instances*: **1 registered**, agent *connected*, status ACTIVE.
- EC2 → Instances → one running `t3.small` with a public IP, security group `cloudcart-app-sg`, IAM role `cloudcart-ecs-instance-role`.
- **Log in without SSH:** select the instance → **Connect** → **Session Manager** tab → **Connect**. A shell opens in the browser. Run `sudo systemctl status ecs` — *active (running)*. Run `docker ps` — empty for now. Type `exit`.

> ❌ *Session Manager tab says "not connected"?* It takes a couple of minutes after boot. If still red after 5 min: the instance role is missing `AmazonSSMManagedInstanceCore`, or the host has no internet (public IP off / wrong subnet).

📒 Ledger: ECS cluster, **ASG `…cloudcart-cluster…` (this is what keeps the EC2 running — ≈ ₹45/day)**, launch template, EC2 instance, 30 GiB EBS.

---

## Step 7b — Bastion host (10 min)

A tiny EC2 in a public subnet whose only job is to reach the private databases: `psql`, `mongosh`, dumps/restores, log checks. Exactly what `bastion-staging-db` does for TSRS.

**EC2 → Launch instance**

| Field | Value |
|-------|-------|
| Name | `cloudcart-bastion` |
| AMI | Amazon Linux 2023 |
| Instance type | **t3.micro** |
| Key pair | `cloudcart-key` |
| VPC / Subnet | `cloudcart-vpc` / `cloudcart-subnet-public1-us-east-1a` |
| Auto-assign public IP | Enable |
| Security group | `cloudcart-bastion-sg` |
| IAM instance profile (Advanced) | `cloudcart-bastion-role` |
| User data (Advanced) | `#!/bin/bash` ↵ `dnf install -y postgresql16` ↵ `curl -fsSL https://downloads.mongodb.com/compass/mongosh-2.3.2-linux-x64.tgz \| tar xz -C /tmp && mv /tmp/mongosh-*/bin/mongosh /usr/local/bin/` |
| Tags | `Project=cloudcart` |

Two ways in — practise both:
1. **SSM**: EC2 → instance → Connect → *Session Manager* → Connect. No port, no key, logged.
2. **SSH with the key**: `ssh -i cloudcart-key.pem ec2-user@<bastion-public-ip>` (your IP must match `cloudcart-bastion-sg`).

### ✅ Verify
From the bastion: `nc -zv <rds-endpoint> 5432` → *succeeded* (proves data-sg ← bastion-sg). `mongosh "mongodb+srv://cloudcart:<pw>@cloudcart.4dxau2t.mongodb.net/cloudcart_auth"` → `show collections`.

📒 Ledger: EC2 `cloudcart-bastion` t3.micro ≈ ₹20/day (stop when idle; it keeps its public IP only if you attach an Elastic IP — otherwise the IP changes on every start, which is fine).

---

## Step 8 — Target groups (15 min)

Six of them, one per service. **EC2 → Load Balancing → Target groups → Create target group**

| Field | Value | Why |
|-------|-------|-----|
| Target type | **Instances** | bridge-mode dynamic ports require *Instances*; *IP addresses* would be for awsvpc/Fargate |
| Target group name | `cc-tg-frontend` (then `cc-tg-auth`, `cc-tg-product`, `cc-tg-cart`, `cc-tg-order`, `cc-tg-payment`) | |
| Protocol : Port | HTTP : **80** for frontend; **5001 / 5002 / 5003 / 5004 / 5005** for the others | this is the *container* port; ECS overrides the actual host port per target |
| IP address type | IPv4 | |
| VPC | `cloudcart-vpc` | |
| Protocol version | HTTP1 | |
| Health check protocol / path | HTTP / **`/health`** | every service answers here; `/` would 404 on the APIs → "unhealthy" → 502s |
| Advanced health check settings ▶ | Port: **Traffic port** · Healthy threshold **2** · Unhealthy **3** · Timeout **5** · Interval **15** · Success codes **200** | faster feedback than the 30 s default while you're learning |
| Register targets (next page) | **register nothing** → Create target group | ECS registers the host:port pairs itself |

### ✅ Verify
Target groups list shows 6 groups, each with *0 targets* and "No load balancer associated" (fine for now).

📒 Ledger: 6 target groups.

---

## Step 9 — Application Load Balancer and listener rules (20 min)

### 9.1 Create the ALB

**EC2 → Load Balancers → Create load balancer → Application Load Balancer → Create**

| Field | Value |
|-------|-------|
| Load balancer name | `cloudcart-alb` |
| Scheme | **Internet-facing** |
| IP address type | IPv4 |
| VPC | `cloudcart-vpc` |
| Availability Zones / subnets | tick **both** AZs and pick the **public** subnet in each |
| Security groups | `cloudcart-alb-sg` only (remove `default`) |
| Listener | HTTP : **80** → Default action: **Forward to `cc-tg-frontend`** |
| Tags | `Project` = `cloudcart` |

**Create load balancer**. State *Provisioning* → *Active* in 2–3 minutes.

### 9.2 Add the five path rules

`cloudcart-alb` → **Listeners and rules** tab → click **HTTP:80** → **Add rule** (×5)

| Rule name | Condition (Path) | Action: forward to | Priority |
|-----------|------------------|--------------------|:--------:|
| `auth` | `/api/auth*` | `cc-tg-auth` | 1 |
| `product` | `/api/products*` | `cc-tg-product` | 2 |
| `cart` | `/api/cart*` | `cc-tg-cart` | 3 |
| `order` | `/api/orders*` | `cc-tg-order` | 4 |
| `payment` | `/api/payments*` | `cc-tg-payment` | 5 |

For each: **Add condition → Path → type the pattern → Confirm → Next → Forward to target group → pick → Next → Priority → Next → Create**.

### ✅ Verify
- Listener rules page shows 5 rules + *Default*.
- Copy the ALB **DNS name** from the *Details* panel (`cloudcart-alb-123456789.us-east-1.elb.amazonaws.com`).
- Open `http://<dns-name>/` in a browser → **503 Service Temporarily Unavailable**. ✅ That is correct: the ALB is alive but no targets are registered yet. (A timeout instead would mean the SG or subnets are wrong.)

📒 Ledger: ALB `cloudcart-alb` (**≈ ₹48/day**, bills even with zero traffic).

---

## Step 10 — Create the databases inside RDS (10 min)

The services expect `product_db`, `order_db`, `payment_db`. RDS doesn't run `init.sql` for you, and the DB is private, so run the SQL **from the bastion** (Step 7b) — this is the bastion's reason to exist.

1. Connect to `cloudcart-bastion` (Session Manager or SSH).
2. Paste the SQL (replace the endpoint and password; `psql` was installed by user data):

```bash
export PGPASSWORD='YOUR_MASTER_PASSWORD'
H=cloudcart-postgres.xxxxxxxx.us-east-1.rds.amazonaws.com

psql -h $H -U postgres -d postgres -c "CREATE DATABASE product_db;" -c "CREATE DATABASE order_db;" -c "CREATE DATABASE payment_db;"
```

3. Now run the three schema files. Easiest: open each file from the repo (`db/postgres/02-product-db.sql`, `03`, `04`) in your editor, **remove the first line `\connect …`** and paste the rest into:

```bash
psql -h $H -U postgres -d product_db     # paste 02-product-db.sql, then \q
psql -h $H -U postgres -d order_db       # paste 03-order-db.sql
psql -h $H -U postgres -d payment_db     # paste 04-payment-db.sql
```

### ✅ Verify
```bash
psql -h $H -U postgres -d product_db -c "SELECT count(*) FROM products;"    # 12
psql -h $H -U postgres -d order_db   -c "\dt"                               # orders, order_items
```

> 🧠 You just proved **bastion → data-sg → RDS** connectivity on 5432. If `psql` hangs: the RDS SG isn't `cloudcart-data-sg`, or data-sg lacks the 5432-from-bastion-sg rule (Step 2.6). Now also go back to `/opt/script/cloudcart/*/.env` on Jenkins and fill in `DB_HOST`.

---

## Step 11 — Task definitions (20 min)

A task definition is the blueprint for a container (image, ports, env vars, logs). We use the **JSON editor** with the prepared templates so nothing is mistyped.

1. In the repo open `aws/task-definitions/`. Read its `README.md` and **replace the placeholders** in all six files. Since the Jenkins-built images already contain `.env`, you may **delete the secret entries** (`JWT_SECRET`, `INTERNAL_SERVICE_TOKEN`, `DB_PASSWORD`, `MONGODB_URI`) from the `environment` arrays and keep only `{{ACCOUNT_ID}}`, `{{REGION}}`, `{{RDS_ENDPOINT}}`, `{{ALB_DNS}}`. If you used the laptop script instead, keep all eight.
2. **ECS → Task definitions → Create new task definition → Create new task definition with JSON**.
3. Delete the sample JSON, paste the file content, **Create**. Repeat for all six: `cc-frontend`, `cc-auth`, `cc-product`, `cc-cart`, `cc-order`, `cc-payment`.

What the JSON contains, and the console field it corresponds to:

| JSON key | Console field | Our value | Why |
|----------|---------------|-----------|-----|
| `networkMode` | Network mode | `bridge` | required for dynamic host ports on EC2 |
| `requiresCompatibilities` | Launch type | `EC2` | |
| `executionRoleArn` | Task execution role | `cloudcart-ecs-task-execution-role` | pull image + write logs |
| `portMappings.hostPort` | Host port | `0` | **0 = dynamic**; the ALB target group learns the real port |
| `cpu` / `memoryReservation` / `memory` | CPU units / soft limit / hard limit | per service (see LLD §5) | soft = scheduler planning, hard = OOM kill |
| `links` (auth/product/cart) | Container links | `["redis"]` | lets the app reach the sidecar as hostname `redis` in bridge mode |
| `dependsOn` | Startup dependency | redis HEALTHY | app waits for Redis |
| `healthCheck` | Container health check | `wget /health` | ECS replaces unhealthy containers |
| `logConfiguration` | Log driver | `awslogs` → `/ecs/cloudcart/<svc>` | Step 6 groups |
| `environment` | Environment variables | see LLD §2 | |

### ✅ Verify
Task definitions list shows 6 families, each at **revision 1**, status *Active*. Open `cc-auth` → Containers: two (`redis`, `auth`).

📒 Ledger: 6 task definition families (free, but note them — they must be *deregistered* at teardown).

---

## Step 12 — ECS services (20 min)

A service keeps N copies of a task running and wires them to a target group.

**ECS → Clusters → `cloudcart-cluster` → Services tab → Create** (×6)

| Section | Field | Value |
|---------|-------|-------|
| Environment | Compute options | **Launch type** |
| | Launch type | **EC2** |
| Deployment configuration | Application type | Service |
| | Task definition family / revision | `cc-frontend` / 1 (LATEST) |
| | Service name | **`cc-frontend`** (must match the family — the CI/CD script relies on it) |
| | Service type | Replica |
| | Desired tasks | **1** |
| Deployment options | Min running / Max running % | **0 / 100** ⚠️ |
| Load balancing ▶ | Load balancer type | **Application Load Balancer** |
| | Use an existing load balancer | `cloudcart-alb` |
| | Container to load balance | `frontend 80:0` (shows container:host port) |
| | Listener | **Use an existing listener → HTTP:80** |
| | Target group | **Use an existing target group → `cc-tg-frontend`** |
| Service auto scaling | off (Stage 2) | |
| Tags | `Project` = `cloudcart` | |

> ⚠️ **Why Min 0 / Max 100 %?** With one host and fixed memory, the default *Min 100 / Max 200 %* would try to start a **second** copy before stopping the first during every deployment, and fail with "insufficient memory". 0/100 means: stop the old one, start the new one. Brief downtime, fine for a demo; Stage 2's second host restores zero-downtime deploys.

Repeat for `cc-auth` (container `auth 5001:0` → `cc-tg-auth`), `cc-product` → `cc-tg-product`, `cc-cart` → `cc-tg-cart`, `cc-order` → `cc-tg-order`, `cc-payment` → `cc-tg-payment`.

### ✅ Verify — this is the moment of truth

1. Cluster → **Services** tab: all six show *1/1 Tasks running*, deployment *Completed* (takes 2–4 min; images are pulled from ECR once).
2. Cluster → **Tasks** tab: 6 RUNNING. Click a task → **Logs** tab → you should see your JSON log lines, e.g. `{"service":"product-service","msg":"Redis connected"}`.
3. EC2 → **Target groups** → each group → **Targets** tab: 1 target, status **healthy**. *This is the line that connects everything: unhealthy here = 502 at the ALB.*
4. Session Manager on the host → `docker ps` → 9 containers (6 apps + 3 redis).

### 🧯 If a task is STOPPED
Click it → *Stopped reason*. Common ones and the fix are in [10-troubleshooting.md](10-troubleshooting.md). Fastest triage: **Tasks → stopped task → Logs**.

📒 Ledger: 6 ECS services.

---

## Step 12b — Final config pass

`PRODUCT_SERVICE_URL` / `CART_SERVICE_URL` / `ORDER_SERVICE_URL` in `/opt/script/cloudcart/{cart,order,payment}/.env` need the ALB DNS from Step 9. Fill them in, then Jenkins → **Build with Parameters** → SERVICE `all`. This time the *ECS Deployment* stage succeeds and *Wait for stable* turns green once all six services report steady state.

---

## Step 13 — End-to-end test 🎉

Open **`http://<alb-dns-name>`** from your phone on mobile data (not Wi-Fi) — if it loads, CloudCart is on the public internet.

Then run the checkpoint list from [01-local-setup.md](01-local-setup.md#-checkpoint-c--the-full-user-journey) against the ALB URL, or:

```bash
./scripts/smoke-test.sh http://cloudcart-alb-123456789.us-east-1.elb.amazonaws.com
```

Watch it happen in AWS while you click:
- **CloudWatch → Log groups → `/ecs/cloudcart/order`** → latest stream → `Order created`.
- **EC2 → Target groups → `cc-tg-product` → Monitoring** → request count climbs.
- **RDS → Monitoring** → DB connections > 0.

### ✅ Stage 1 done when

- [ ] `http://<alb-dns>` loads from outside your network
- [ ] Service health page in the footer: all 6 green
- [ ] An order reaches **PAID**; one with card `0000` reaches **PAYMENT FAILED**
- [ ] All six target groups show *healthy*
- [ ] A Jenkins build (SERVICE=all) deployed end-to-end with *Wait for stable* green
- [ ] You opened `psql` on RDS from the bastion via **both** SSM and SSH
- [ ] Ledger in `09-cost-and-teardown.md` lists everything created
- [ ] 📌 **Commit and push** (you edited the task-definition JSONs — make sure `{{DB_PASSWORD}}` etc. are **not** committed: copy the files to `aws/task-definitions/filled/` which is git-ignored, or revert the placeholders before committing)

---

## 🧹 Pausing vs tearing down after Stage 1

| You want to… | Do this | Saves |
|--------------|---------|-------|
| stop paying tonight, continue tomorrow | ASG → `…cloudcart…` → Edit → Desired/Min **0** · RDS → `cloudcart-postgres` → Actions → **Stop temporarily** · **Stop** the Jenkins and bastion instances | ≈ ₹190/day (ALB keeps billing ≈ ₹48) |
| stop everything but keep the config | above + delete the **ALB** (target groups survive; the listener rules don't — screenshot them, recreating takes 5 min) | ≈ ₹128/day |
| delete it all | follow the order in [09-cost-and-teardown.md](09-cost-and-teardown.md) | everything |

➡️ Next: [05 · 🟡 Stage 2 — Hardened](05-aws-stage2-hardening.md)
