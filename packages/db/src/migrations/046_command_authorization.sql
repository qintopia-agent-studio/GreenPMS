CREATE TABLE command_catalog (
  command_type text PRIMARY KEY,
  command_class text NOT NULL CHECK (command_class IN ('DIRECT_READ', 'HUMAN_COMMAND', 'SYSTEM_DERIVED', 'FUTURE_DISABLED', 'HISTORICAL_READ')),
  feature_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT command_catalog_exact_type_check CHECK (
    command_type = upper(command_type)
    AND command_type ~ '^[A-Z][A-Z0-9_]*$'
    AND command_type NOT LIKE '%*%'
  ),
  CONSTRAINT command_catalog_feature_key_check CHECK (
    feature_key IS NULL
    OR (command_type IN (
      'COMPLETE_CLEANING',
      'CORRECT_HISTORICAL_STAY_ARRANGEMENTS',
      'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
    ))
  )
);

INSERT INTO command_catalog (command_type, command_class, feature_key) VALUES
  ('CREATE_QUOTE', 'DIRECT_READ', NULL),
  ('CREATE_MEMBER', 'HUMAN_COMMAND', NULL),
  ('CREATE_MEMBERSHIP_ORDER', 'HUMAN_COMMAND', NULL),
  ('RECORD_MEMBERSHIP_PAYMENT', 'HUMAN_COMMAND', NULL),
  ('CORRECT_MEMBERSHIP_PAYMENT', 'HUMAN_COMMAND', NULL),
  ('ACTIVATE_MEMBERSHIP_ORDER', 'HUMAN_COMMAND', NULL),
  ('CREATE_ORDER', 'HUMAN_COMMAND', NULL),
  ('CORRECT_ORDER_OCCUPANT', 'HUMAN_COMMAND', NULL),
  ('RESCHEDULE_STAY', 'HUMAN_COMMAND', NULL),
  ('EXTEND_STAY', 'HUMAN_COMMAND', NULL),
  ('SHORTEN_STAY', 'HUMAN_COMMAND', NULL),
  ('MOVE_UNIT', 'HUMAN_COMMAND', NULL),
  ('REPRICE_ORDER', 'HUMAN_COMMAND', NULL),
  ('CANCEL_ORDER', 'HUMAN_COMMAND', NULL),
  ('MARK_NO_SHOW', 'HUMAN_COMMAND', NULL),
  ('REVOKE_CHECK_IN', 'HUMAN_COMMAND', NULL),
  ('LOCK_MAINTENANCE', 'HUMAN_COMMAND', NULL),
  ('RELEASE_MAINTENANCE', 'HUMAN_COMMAND', NULL),
  ('COMPLETE_CLEANING', 'HUMAN_COMMAND', 'cleaningWorkflow'),
  ('RECORD_COLLECTION', 'HUMAN_COMMAND', NULL),
  ('RECORD_REFUND', 'HUMAN_COMMAND', NULL),
  ('REVERSE_FACT', 'HUMAN_COMMAND', NULL),
  ('CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP', 'HUMAN_COMMAND', NULL),
  ('CHECK_IN', 'HUMAN_COMMAND', NULL),
  ('CHECK_OUT', 'HUMAN_COMMAND', NULL),
  ('COMPLETE_STAY', 'HUMAN_COMMAND', NULL),
  ('REFRESH_MEMBER_COVERAGE', 'SYSTEM_DERIVED', NULL),
  ('ADD_MEMBER_ENTITLEMENT_LOT', 'SYSTEM_DERIVED', NULL),
  ('ADJUST_MEMBER_ENTITLEMENT', 'SYSTEM_DERIVED', NULL),
  ('CORRECT_MEMBER_ENTITLEMENT_BALANCE', 'HUMAN_COMMAND', NULL),
  ('EXPIRE_MEMBER_ENTITLEMENT', 'SYSTEM_DERIVED', NULL),
  ('ISSUE_TOKEN', 'HUMAN_COMMAND', NULL),
  ('ROTATE_TOKEN', 'HUMAN_COMMAND', NULL),
  ('REVOKE_TOKEN', 'HUMAN_COMMAND', NULL),
  ('CORRECT_HISTORICAL_STAY_ARRANGEMENTS', 'FUTURE_DISABLED', 'historicalStayArrangementCorrection'),
  ('VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY', 'FUTURE_DISABLED', 'membershipConversionVoidCorrection'),
  ('PLACE_INTERNAL_USE', 'HISTORICAL_READ', NULL),
  ('RELEASE_INTERNAL_USE', 'HISTORICAL_READ', NULL),
  ('BACKFILL_COMPLETED_STAY', 'HISTORICAL_READ', NULL);

CREATE TABLE subject_command_grants (
  subject_id text NOT NULL,
  property_id text NOT NULL,
  command_type text NOT NULL REFERENCES command_catalog(command_type),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_id, property_id, command_type),
  CONSTRAINT subject_command_grants_property_fk
    FOREIGN KEY (subject_id, property_id)
    REFERENCES subject_property_grants(subject_id, property_id)
    ON DELETE CASCADE,
  CONSTRAINT subject_command_grants_human_exact_check CHECK (command_type IN (
    'CREATE_MEMBER',
    'CREATE_MEMBERSHIP_ORDER',
    'RECORD_MEMBERSHIP_PAYMENT',
    'CORRECT_MEMBERSHIP_PAYMENT',
    'ACTIVATE_MEMBERSHIP_ORDER',
    'CREATE_ORDER',
    'CORRECT_ORDER_OCCUPANT',
    'RESCHEDULE_STAY',
    'EXTEND_STAY',
    'SHORTEN_STAY',
    'MOVE_UNIT',
    'REPRICE_ORDER',
    'CANCEL_ORDER',
    'MARK_NO_SHOW',
    'REVOKE_CHECK_IN',
    'LOCK_MAINTENANCE',
    'RELEASE_MAINTENANCE',
    'COMPLETE_CLEANING',
    'RECORD_COLLECTION',
    'RECORD_REFUND',
    'REVERSE_FACT',
    'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP',
    'CHECK_IN',
    'CHECK_OUT',
    'COMPLETE_STAY',
    'CORRECT_MEMBER_ENTITLEMENT_BALANCE',
    'ISSUE_TOKEN',
    'ROTATE_TOKEN',
    'REVOKE_TOKEN',
    'CORRECT_HISTORICAL_STAY_ARRANGEMENTS',
    'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY',
    'PLACE_INTERNAL_USE',
    'RELEASE_INTERNAL_USE',
    'BACKFILL_COMPLETED_STAY'
  ))
);

ALTER TABLE api_tokens
  ADD CONSTRAINT api_tokens_subject_property_unique UNIQUE (id, subject_id, property_scope);

CREATE TABLE token_command_ceilings (
  token_id text NOT NULL,
  subject_id text NOT NULL,
  property_id text NOT NULL,
  command_type text NOT NULL REFERENCES command_catalog(command_type),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (token_id, command_type),
  CONSTRAINT token_command_ceilings_token_scope_fk
    FOREIGN KEY (token_id, subject_id, property_id)
    REFERENCES api_tokens(id, subject_id, property_scope)
    ON DELETE CASCADE,
  CONSTRAINT token_command_ceilings_subject_grant_subset_fk
    FOREIGN KEY (subject_id, property_id, command_type)
    REFERENCES subject_command_grants(subject_id, property_id, command_type)
    ON DELETE CASCADE
);

CREATE TABLE security_audit_entries (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  subject_id text NOT NULL,
  command_type text NOT NULL REFERENCES command_catalog(command_type),
  stage text NOT NULL CHECK (stage IN ('PREVIEW', 'CONFIRM', 'STORED_PREVIEW', 'RECEIPT', 'COMMAND', 'FIND', 'RESOLVE', 'REPLAY')),
  denial_reason text NOT NULL,
  credential_type text NOT NULL CHECK (credential_type IN ('SESSION', 'TOKEN')),
  credential_fingerprint char(64) NOT NULL CHECK (credential_fingerprint ~ '^[a-f0-9]{64}$'),
  correlation_id text NOT NULL,
  idempotency_key_hash char(64) NOT NULL CHECK (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER security_audit_entries_append_only
BEFORE UPDATE OR DELETE ON security_audit_entries
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

CREATE INDEX subject_command_grants_property_idx
  ON subject_command_grants(property_id, command_type, subject_id);

CREATE INDEX token_command_ceilings_subject_property_idx
  ON token_command_ceilings(subject_id, property_id, command_type);

CREATE INDEX security_audit_entries_subject_idx
  ON security_audit_entries(subject_id, property_id, created_at DESC);

CREATE INDEX security_audit_entries_correlation_idx
  ON security_audit_entries(correlation_id, created_at DESC);

COMMENT ON TABLE subject_command_grants IS
  'Exact per-subject command grants. Runtime lock order: subjects -> subject_property_grants -> subject_command_grants -> credential(session/token) -> token_command_ceilings.';

COMMENT ON TABLE token_command_ceilings IS
  'Exact per-token command ceilings. The subject grant FK makes every ceiling command a subset of the subject effective grants.';

WITH ordinary(command_type) AS (
  VALUES
    ('CREATE_MEMBER'),
    ('CREATE_MEMBERSHIP_ORDER'),
    ('RECORD_MEMBERSHIP_PAYMENT'),
    ('CORRECT_MEMBERSHIP_PAYMENT'),
    ('ACTIVATE_MEMBERSHIP_ORDER'),
    ('CREATE_ORDER'),
    ('RESCHEDULE_STAY'),
    ('EXTEND_STAY'),
    ('SHORTEN_STAY'),
    ('MOVE_UNIT'),
    ('REPRICE_ORDER'),
    ('CANCEL_ORDER'),
    ('MARK_NO_SHOW'),
    ('REVOKE_CHECK_IN'),
    ('LOCK_MAINTENANCE'),
    ('RELEASE_MAINTENANCE'),
    ('RECORD_COLLECTION'),
    ('RECORD_REFUND'),
    ('REVERSE_FACT'),
    ('CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'),
    ('CHECK_IN'),
    ('CHECK_OUT'),
    ('COMPLETE_STAY'),
    ('CORRECT_MEMBER_ENTITLEMENT_BALANCE')
)
INSERT INTO subject_command_grants(subject_id, property_id, command_type)
SELECT grant_row.subject_id, grant_row.property_id, ordinary.command_type
FROM subject_property_grants AS grant_row
CROSS JOIN ordinary
WHERE grant_row.access_level = 'WRITE'
ON CONFLICT DO NOTHING;

WITH historical_existing(command_type) AS (
  SELECT DISTINCT regexp_replace(command_type, '^PREVIEW:', '') AS command_type
  FROM command_executions
  WHERE regexp_replace(command_type, '^PREVIEW:', '') IN (
    'PLACE_INTERNAL_USE',
    'RELEASE_INTERNAL_USE',
    'BACKFILL_COMPLETED_STAY'
  )
)
INSERT INTO subject_command_grants(subject_id, property_id, command_type)
SELECT execution_row.subject_id, execution_row.property_id, execution_row.command_type
FROM (
  SELECT DISTINCT subject_id, property_id, regexp_replace(command_type, '^PREVIEW:', '') AS command_type
  FROM command_executions
  WHERE regexp_replace(command_type, '^PREVIEW:', '') IN (SELECT command_type FROM historical_existing)
) AS execution_row
JOIN subject_property_grants AS grant_row
  ON grant_row.subject_id = execution_row.subject_id
  AND grant_row.property_id = execution_row.property_id
ON CONFLICT DO NOTHING;

INSERT INTO token_command_ceilings(token_id, subject_id, property_id, command_type)
SELECT token_row.id, token_row.subject_id, token_row.property_scope, grant_row.command_type
FROM api_tokens AS token_row
JOIN subject_command_grants AS grant_row
  ON grant_row.subject_id = token_row.subject_id
  AND grant_row.property_id = token_row.property_scope
WHERE token_row.access_ceiling = 'WRITE'
ON CONFLICT DO NOTHING;
