# ECS task-definition templates (Stage 1)

Six JSON files, one per ECS service. Paste each one into **ECS → Task definitions → Create new task definition with JSON**, after replacing the placeholders:

| Placeholder | Replace with | Where you find it |
|-------------|--------------|-------------------|
| `{{ACCOUNT_ID}}` | your 12-digit AWS account id | top-right of the console → account menu |
| `{{REGION}}` | `us-east-1` | the region you chose in Stage 1, Step 0 |
| `{{RDS_ENDPOINT}}` | `cloudcart-postgres.xxxxxxxx.us-east-1.rds.amazonaws.com` | RDS → Databases → cloudcart-postgres → *Endpoint* |
| `{{DB_PASSWORD}}` | the RDS master password you typed | your password manager |
| `{{MONGODB_URI}}` | `mongodb+srv://cloudcart:PASSWORD@cloudcart.4dxau2t.mongodb.net/cloudcart_auth?retryWrites=true&w=majority` | Atlas → Connect → Drivers (add `/cloudcart_auth`) |
| `{{ALB_DNS}}` | `cloudcart-alb-1234567890.us-east-1.elb.amazonaws.com` | EC2 → Load balancers → cloudcart-alb → *DNS name* (no `http://`) |
| `{{JWT_SECRET}}` | a random 40-char string | generate: `openssl rand -base64 32` |
| `{{INTERNAL_TOKEN}}` | a different random 40-char string | same |

Tip: open all six files in VS Code and use **Edit → Replace in Files** (`Ctrl+Shift+H`) once per placeholder.

**Using Jenkins (Stage 1 default)?** The image already contains `.env`, so you can delete the `JWT_SECRET`, `INTERNAL_SERVICE_TOKEN`, `DB_PASSWORD` and `MONGODB_URI` entries from `environment` and fill only the first four placeholders. Values set here override the `.env`.

In Stage 3 the secret values are replaced by `"secrets": [...]` references to Secrets Manager — see `docs/05-aws-stage2-hardening.md`.
