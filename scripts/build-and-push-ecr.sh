#!/usr/bin/env bash
# Build all 6 images and push them to ECR (used in Stage 1, Step 5 — the only step that needs the CLI).
#   ./scripts/build-and-push-ecr.sh <aws-account-id> <region> [tag]
set -euo pipefail
ACCOUNT="${1:?aws account id}"; REGION="${2:?region e.g. ap-south-1}"; TAG="${3:-latest}"
REG="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REG"
for svc in auth product cart order payment; do
  docker build -t "$REG/cloudcart/$svc-service:$TAG" "services/$svc-service"
  docker push "$REG/cloudcart/$svc-service:$TAG"
done
docker build -t "$REG/cloudcart/frontend:$TAG" frontend          # default build arg = nginx.aws.conf
docker push "$REG/cloudcart/frontend:$TAG"
echo "✔ pushed 6 images with tag $TAG to $REG/cloudcart/*"
