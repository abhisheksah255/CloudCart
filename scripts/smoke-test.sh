#!/usr/bin/env bash
# CloudCart end-to-end smoke test.
#   ./scripts/smoke-test.sh                     -> against http://localhost:8080
#   ./scripts/smoke-test.sh http://<alb-dns>    -> against AWS
# Requires: curl, jq  (brew install jq / apt install jq / choco install jq)
set -euo pipefail
BASE="${1:-http://localhost:8080}"
EMAIL="asha@cloudcart.local"
say() { printf "\n\033[1;34m▶ %s\033[0m\n" "$*"; }
ok()  { printf "   \033[1;32m✔ %s\033[0m\n" "$*"; }

say "1. Health checks"
for p in /health /api/auth/health /api/products/health /api/cart/health /api/orders/health /api/payments/health; do
  s=$(curl -s -o /dev/null -w "%{http_code}" "$BASE$p"); [ "$s" = "200" ] && ok "$p -> 200" || { echo "   ✘ $p -> $s"; exit 1; }
done

say "2. Request OTP for $EMAIL"
OTP=$(curl -s -X POST "$BASE/api/auth/request-otp" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\"}" | jq -r .dev_otp)
[ "$OTP" != "null" ] || { echo "   ✘ no dev_otp in response (DEV_SHOW_OTP=false?). Read it from the auth-service logs instead."; exit 1; }
ok "OTP = $OTP"

say "3. Verify OTP -> JWT"
TOKEN=$(curl -s -X POST "$BASE/api/auth/verify-otp" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"otp\":\"$OTP\"}" | jq -r .token)
[ "$TOKEN" != "null" ] || { echo "   ✘ login failed"; exit 1; }
AUTH="Authorization: Bearer $TOKEN"; ok "token received"

say "4. List products"
PID=$(curl -s "$BASE/api/products" | jq -r '.products[0].id'); ok "first product id = $PID"

say "5. Add to cart"
curl -s -X POST "$BASE/api/cart/items" -H "$AUTH" -H 'Content-Type: application/json' -d "{\"product_id\":$PID,\"quantity\":2}" | jq -c '.cart | {count,total}'

say "6. Checkout -> order"
OID=$(curl -s -X POST "$BASE/api/orders" -H "$AUTH" -H 'Content-Type: application/json' -d '{"shipping_address":"Smoke test lane"}' | jq -r .order.id)
[ "$OID" != "null" ] || { echo "   ✘ checkout failed"; exit 1; }; ok "order #$OID created"

say "7. Pay"
PAYID=$(curl -s -X POST "$BASE/api/payments" -H "$AUTH" -H 'Content-Type: application/json' -d "{\"order_id\":$OID,\"method\":\"card\"}" | jq -r .payment.id)
curl -s -X POST "$BASE/api/payments/$PAYID/confirm" -H "$AUTH" -H 'Content-Type: application/json' -d '{"card_last4":"4242"}' | jq -c '{success,message}'

say "8. Order status"
curl -s "$BASE/api/orders/$OID" -H "$AUTH" | jq -c '.order | {id,status,total_amount}'
ok "Smoke test finished — expect status PAID above"
