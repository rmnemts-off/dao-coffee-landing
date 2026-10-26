-- Apply as schema owner/admin after postgres-schema.sql, in the selected database.
-- Role/database provisioning is a separate server administration action.
GRANT USAGE ON SCHEMA dao_website TO "dao-coffee";
GRANT SELECT ON ALL TABLES IN SCHEMA dao_website TO "dao-coffee";
GRANT INSERT,UPDATE ON dao_website.customers,dao_website.crm_deliveries,
  dao_website.delivery_attempts,dao_website.upstream_cooldown TO "dao-coffee";
GRANT INSERT ON dao_website.inquiries,dao_website.inquiry_directions TO "dao-coffee";
GRANT UPDATE ON dao_website.dispatch_lock TO "dao-coffee";
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA dao_website TO "dao-coffee";
