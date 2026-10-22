-- CloudCart: one PostgreSQL *instance*, one *database per service*.
-- This is the "database-per-service" pattern on a shared instance (cheap for demos,
-- and each service still only ever talks to its own database).
--
-- Locally this runs automatically via docker-entrypoint-initdb.d.
-- On AWS RDS you run these files once by hand (see docs/04-aws-stage1-mvp.md, Step 7).

CREATE DATABASE product_db;
CREATE DATABASE order_db;
CREATE DATABASE payment_db;
