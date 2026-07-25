ALTER TABLE collection_facts
  ADD COLUMN pricing_revision_id text REFERENCES pricing_revisions(id);

ALTER TABLE collection_facts DISABLE TRIGGER collection_facts_append_only;

UPDATE collection_facts AS fact
SET pricing_revision_id = COALESCE(
  (
    SELECT revision.id
    FROM pricing_revisions AS revision
    WHERE revision.order_id = fact.order_id
      AND revision.created_at <= fact.created_at
    ORDER BY revision.created_at DESC, revision.revision_no DESC
    LIMIT 1
  ),
  (
    SELECT revision.id
    FROM pricing_revisions AS revision
    WHERE revision.order_id = fact.order_id
    ORDER BY revision.created_at, revision.revision_no
    LIMIT 1
  )
);

ALTER TABLE collection_facts ENABLE TRIGGER collection_facts_append_only;

ALTER TABLE pricing_revisions
  ADD CONSTRAINT pricing_revisions_id_order_unique UNIQUE (id, order_id);

ALTER TABLE collection_facts
  ALTER COLUMN pricing_revision_id SET NOT NULL,
  ADD CONSTRAINT collection_facts_pricing_revision_order_fk
    FOREIGN KEY (pricing_revision_id, order_id)
    REFERENCES pricing_revisions (id, order_id);

CREATE INDEX collection_facts_pricing_revision_idx
  ON collection_facts (pricing_revision_id, created_at, fact_id);
