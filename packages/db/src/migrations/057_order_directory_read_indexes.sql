-- Support bounded chronological order browsing, both with and without a status filter.
-- Query-only indexes: no changes to lifecycle, prices, inventory, or command guards.
CREATE INDEX orders_property_created_id_idx ON orders (property_id, created_at DESC, id DESC);
CREATE INDEX orders_property_status_created_id_idx ON orders (property_id, status, created_at DESC, id DESC);
