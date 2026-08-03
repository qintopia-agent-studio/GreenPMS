LOCK TABLE collection_facts, stay_collection_membership_transfers, command_executions
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM collection_facts AS reversal
    JOIN command_executions AS execution
      ON execution.id = reversal.command_id
    WHERE execution.command_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
      AND reversal.fact_type = 'REVERSAL'
      AND NOT EXISTS (
        SELECT 1
        FROM stay_collection_membership_transfers AS transfer
        WHERE transfer.command_id = reversal.command_id
          AND transfer.order_id = reversal.order_id
          AND transfer.source_reversal_fact_id = reversal.fact_id
          AND transfer.source_collection_fact_id = reversal.reverses_fact_id
      )
  ) THEN
    RAISE EXCEPTION 'stay-to-membership conversion lodging reversals must exactly match transfer bridges'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_reversal_bridge_exact';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_require_stage13_conversion_reversal_bridge()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  execution_type text;
BEGIN
  SELECT command_type INTO execution_type
    FROM command_executions
    WHERE id = NEW.command_id;
  IF execution_type IS DISTINCT FROM 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM stay_collection_membership_transfers AS transfer
    WHERE transfer.command_id = NEW.command_id
      AND transfer.order_id = NEW.order_id
      AND transfer.source_reversal_fact_id = NEW.fact_id
      AND transfer.source_collection_fact_id = NEW.reverses_fact_id
  ) THEN
    RAISE EXCEPTION 'stay-to-membership conversion lodging reversals must exactly match transfer bridges'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_reversal_bridge_exact';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER collection_facts_stage13_require_conversion_reversal_bridge
AFTER INSERT ON collection_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.fact_type = 'REVERSAL')
EXECUTE FUNCTION qintopia_require_stage13_conversion_reversal_bridge();
