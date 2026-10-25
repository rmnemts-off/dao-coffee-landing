-- PROTOTYPE ONLY. Not loaded by the API and not a production migration.
-- Run only against a new, empty test database after explicitly selecting it:
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f backend/db/postgres-schema.sql
-- No extensions, roles, databases, CRM objects, or network settings are created.
-- CREATE SCHEMA deliberately fails if this prototype already exists.
BEGIN;

CREATE SCHEMA dao_website;

CREATE TABLE dao_website.schema_migrations (
  version integer PRIMARY KEY CHECK (version > 0),
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dao_website.directions (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9-]*$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
  display_order smallint NOT NULL UNIQUE CHECK (display_order >= 0)
);

INSERT INTO dao_website.directions (code, label, display_order) VALUES
  ('drinkx', 'DrinkX', 1),
  ('wendougee', 'Wendougee', 2),
  ('linkbar', 'LinkBar', 3),
  ('coffee', 'Кофе и СТМ', 4),
  ('xlvi-ceado', 'XLVI / Ceado', 5),
  ('water', 'Водоподготовка', 6),
  ('horeca', 'Комплектация', 7);

CREATE TABLE dao_website.customers (
  customer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text NOT NULL UNIQUE CHECK (phone_e164 ~ '^\+7[0-9]{10}$'),
  UNIQUE (customer_id, phone_e164),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  crm_contact_id bigint CHECK (crm_contact_id > 0),
  crm_match_state text NOT NULL DEFAULT 'unresolved'
    CHECK (crm_match_state IN ('unresolved', 'matched', 'ambiguous')),
  CHECK (last_seen_at >= first_seen_at),
  CHECK ((crm_match_state = 'matched' AND crm_contact_id IS NOT NULL)
    OR (crm_match_state <> 'matched' AND crm_contact_id IS NULL))
);

COMMENT ON TABLE dao_website.customers IS
  'A provisional grouping by a normalized phone, not proof of a person identity. Names remain in inquiry snapshots. Never auto-merge CRM contacts.';
COMMENT ON COLUMN dao_website.customers.crm_contact_id IS
  'Optional unambiguous CRM mapping. Not unique: one CRM contact can have several phone numbers. Do not guess on conflicting historical mappings.';

CREATE TABLE dao_website.inquiries (
  request_id uuid PRIMARY KEY,
  customer_id uuid NOT NULL,
  idempotency_key uuid NOT NULL UNIQUE,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_hash_version smallint NOT NULL DEFAULT 1 CHECK (payload_hash_version = 1),
  schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  payload_snapshot jsonb NOT NULL CHECK (jsonb_typeof(payload_snapshot) = 'object'),
  submitted_name text NOT NULL CHECK (char_length(submitted_name) BETWEEN 2 AND 100),
  submitted_phone text NOT NULL CHECK (submitted_phone ~ '^\+7[0-9]{10}$'),
  FOREIGN KEY (customer_id, submitted_phone)
    REFERENCES dao_website.customers(customer_id, phone_e164) ON DELETE RESTRICT ON UPDATE RESTRICT,
  product_code text REFERENCES dao_website.directions(code) ON DELETE RESTRICT,
  model_snapshot text CHECK (model_snapshot IS NULL OR char_length(model_snapshot) BETWEEN 1 AND 120),
  message_snapshot text NOT NULL DEFAULT '' CHECK (char_length(message_snapshot) <= 1000),
  source text NOT NULL CHECK (source IN ('hero-modal', 'brand-modal', 'inline')),
  source_block text GENERATED ALWAYS AS (
    CASE source WHEN 'hero-modal' THEN 'hero' WHEN 'inline' THEN 'contact' ELSE product_code END
  ) STORED NOT NULL,
  consent boolean NOT NULL CHECK (consent IS TRUE),
  received_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source = 'brand-modal') = (product_code IS NOT NULL)),
  CHECK (payload_snapshot ?& ARRAY['schemaVersion', 'name', 'phone', 'product', 'interests', 'model', 'comment', 'consent', 'source']),
  CHECK (payload_snapshot @> '{"schemaVersion":1,"consent":true}'::jsonb),
  CHECK (jsonb_typeof(payload_snapshot->'interests') = 'array'),
  CHECK ((payload_snapshot->>'name') IS NOT DISTINCT FROM submitted_name),
  CHECK ((payload_snapshot->>'phone') IS NOT DISTINCT FROM submitted_phone),
  CHECK ((payload_snapshot->>'product') IS NOT DISTINCT FROM product_code),
  CHECK ((payload_snapshot->>'model') IS NOT DISTINCT FROM model_snapshot),
  CHECK ((payload_snapshot->>'comment') IS NOT DISTINCT FROM message_snapshot),
  CHECK ((payload_snapshot->>'source') IS NOT DISTINCT FROM source)
);

CREATE INDEX inquiries_customer_history ON dao_website.inquiries (customer_id, received_at DESC, request_id);
CREATE INDEX inquiries_source_block ON dao_website.inquiries (source_block, received_at DESC);

CREATE TABLE dao_website.inquiry_directions (
  request_id uuid NOT NULL REFERENCES dao_website.inquiries(request_id) ON DELETE RESTRICT,
  direction_code text NOT NULL REFERENCES dao_website.directions(code) ON DELETE RESTRICT,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 6),
  PRIMARY KEY (request_id, direction_code),
  UNIQUE (request_id, position)
);

CREATE INDEX inquiry_directions_direction ON dao_website.inquiry_directions (direction_code, request_id);
COMMENT ON TABLE dao_website.inquiry_directions IS
  'Derived in the reservation transaction from v1: product => one direction; interests => selected directions; undecided => zero rows, preserved in payload_snapshot.';
COMMENT ON COLUMN dao_website.inquiries.model_snapshot IS
  'Only an explicitly selected model. Current brand CTAs have empty data-model; never infer a model from hover, nearby cards, or a product direction.';

CREATE TABLE dao_website.crm_deliveries (
  request_id uuid PRIMARY KEY REFERENCES dao_website.inquiries(request_id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'received'
    CHECK (state IN ('received', 'processing', 'delivered', 'rejected', 'uncertain', 'unconfigured')),
  -- New requests persist verified non-secret routing before a send. Legacy
  -- imports may retain NULL rather than inventing an unknown historical route.
  target_route jsonb CHECK (target_route IS NULL OR jsonb_typeof(target_route) = 'object'),
  originator_id text NOT NULL DEFAULT 'DAO_COFFEE_WEBSITE' CHECK (originator_id = 'DAO_COFFEE_WEBSITE'),
  origin_id text GENERATED ALWAYS AS (request_id::text) STORED,
  crm_id bigint CHECK (crm_id > 0),
  entity_type_id smallint CHECK (entity_type_id IN (1, 2)),
  contact_id bigint CHECK (contact_id > 0),
  operation text CHECK (operation IN ('send', 'reconcile')),
  claim_token uuid,
  lease_until timestamptz,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (updated_at >= created_at),
  CHECK (state <> 'delivered' OR (crm_id IS NOT NULL AND entity_type_id IS NOT NULL)),
  CHECK ((state = 'processing' AND operation IS NOT NULL AND claim_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (state <> 'processing' AND operation IS NULL AND claim_token IS NULL AND lease_until IS NULL)),
  CHECK (state <> 'processing' OR operation <> 'send' OR
    (target_route IS NOT NULL AND target_route ?& ARRAY['portalHost', 'entityTypeId', 'categoryId', 'stageId', 'sourceId', 'assignedById']))
);

CREATE UNIQUE INDEX crm_deliveries_confirmed_object ON dao_website.crm_deliveries (entity_type_id, crm_id)
  WHERE crm_id IS NOT NULL AND entity_type_id IS NOT NULL;
CREATE INDEX crm_deliveries_pending ON dao_website.crm_deliveries (state, updated_at, request_id)
  WHERE state <> 'delivered';
CREATE INDEX crm_deliveries_retry ON dao_website.crm_deliveries (retry_at, request_id)
  WHERE state IN ('received', 'rejected', 'unconfigured');

CREATE TABLE dao_website.delivery_attempts (
  attempt_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES dao_website.crm_deliveries(request_id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN ('send', 'reconcile')),
  claim_token uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text CHECK (outcome IN ('delivered', 'rejected', 'uncertain', 'unconfigured')),
  CHECK (finished_at IS NULL OR finished_at >= started_at),
  CHECK ((finished_at IS NULL) = (outcome IS NULL))
);

CREATE INDEX delivery_attempts_request ON dao_website.delivery_attempts (request_id, started_at, attempt_id);

-- Preserve current cross-process serialization for the first PostgreSQL
-- implementation. Claim in a short transaction; never hold a SQL transaction
-- open across a Bitrix HTTP call. Owner + generation fence the final UPDATE.
CREATE TABLE dao_website.dispatch_lock (
  singleton smallint PRIMARY KEY CHECK (singleton = 1),
  owner uuid,
  expires_at timestamptz,
  CHECK ((owner IS NULL) = (expires_at IS NULL))
);
INSERT INTO dao_website.dispatch_lock (singleton) VALUES (1);

CREATE FUNCTION dao_website.guard_delivery_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'delivered' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Confirmed CRM delivery is immutable';
  END IF;
  IF OLD.state = 'uncertain' AND NOT (
    NEW.state IN ('uncertain', 'delivered') OR (NEW.state = 'processing' AND NEW.operation = 'reconcile')
  ) THEN
    RAISE EXCEPTION 'An uncertain delivery can only be reconciled';
  END IF;
  IF OLD.state = 'processing' AND NEW.state = 'received' THEN
    RAISE EXCEPTION 'An in-flight delivery cannot return to received';
  END IF;
  IF OLD.state = 'processing' AND OLD.operation = 'reconcile'
    AND NEW.state IN ('rejected', 'unconfigured') THEN
    RAISE EXCEPTION 'A failed reconciliation does not authorize another send';
  END IF;
  IF OLD.state = 'processing' AND NEW.state = 'processing' AND NEW.operation = 'send'
    AND (NEW.claim_token IS DISTINCT FROM OLD.claim_token OR NEW.operation IS DISTINCT FROM OLD.operation) THEN
    RAISE EXCEPTION 'An in-flight delivery cannot start another send';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER crm_delivery_transition
BEFORE UPDATE ON dao_website.crm_deliveries
FOR EACH ROW EXECUTE FUNCTION dao_website.guard_delivery_transition();

COMMENT ON TABLE dao_website.crm_deliveries IS
  'A local delivery journal. Neither its unique indexes nor origin_id provide exactly-once delivery across PostgreSQL and Bitrix REST. Unknown remote writes must not be retried.';

INSERT INTO dao_website.schema_migrations (version, name) VALUES (1, 'Unconnected PostgreSQL architecture prototype');
COMMIT;
