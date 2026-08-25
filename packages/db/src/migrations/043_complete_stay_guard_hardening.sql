LOCK TABLE command_executions, amendments, collection_facts IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM command_executions AS execution
    LEFT JOIN amendments AS amendment ON amendment.command_id = execution.id
    WHERE execution.command_type = 'COMPLETE_STAY'
    GROUP BY execution.id, execution.state
    HAVING
      (execution.state IS DISTINCT FROM 'APPLIED' AND count(amendment.id) <> 0)
      OR (execution.state = 'APPLIED' AND (
        count(amendment.id) <> 2
        OR count(amendment.id) FILTER (WHERE amendment.amendment_type = 'CHECK_IN') <> 1
        OR count(amendment.id) FILTER (WHERE amendment.amendment_type = 'CHECK_OUT') <> 1
        OR count(DISTINCT amendment.order_id) <> 1
        OR count(amendment.id) FILTER (
          WHERE amendment.reason_code = 'COMPLETE_STAY'
            AND btrim(amendment.reason_note) <> ''
            AND amendment.payload ->> 'orderId' = amendment.order_id
            AND ((amendment.amendment_type = 'CHECK_IN'
                  AND amendment.payload ->> 'fromStatus' = 'RESERVED'
                  AND amendment.payload ->> 'toStatus' = 'CHECKED_IN')
              OR (amendment.amendment_type = 'CHECK_OUT'
                  AND amendment.payload ->> 'fromStatus' = 'CHECKED_IN'
                  AND amendment.payload ->> 'toStatus' = 'CHECKED_OUT'))
        ) <> 2
        OR count(DISTINCT amendment.reason_note) <> 1
        OR min(amendment.sequence) FILTER (WHERE amendment.amendment_type = 'CHECK_OUT')
          IS DISTINCT FROM (min(amendment.sequence) FILTER (WHERE amendment.amendment_type = 'CHECK_IN')) + 1
      ))
  ) THEN
    RAISE EXCEPTION 'existing COMPLETE_STAY executions violate the hardened fulfillment-pair invariant'
      USING ERRCODE = '23514', CONSTRAINT = 'command_executions_complete_stay_existing_exact_pair';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_reject_stage10_checkout_bypass() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  execution_type text;
  planned_departure date;
  recorded_business_date date;
BEGIN
  IF NEW.command_id IS NOT NULL THEN
    SELECT command_type INTO execution_type
      FROM command_executions
      WHERE id = NEW.command_id;
  END IF;

  IF execution_type = 'COMPLETE_STAY' THEN
    IF NEW.amendment_type NOT IN ('CHECK_IN', 'CHECK_OUT')
      OR NEW.reason_code IS DISTINCT FROM 'COMPLETE_STAY'
      OR NEW.reason_note IS NULL
      OR btrim(NEW.reason_note) = ''
      OR NEW.payload ->> 'orderId' IS DISTINCT FROM NEW.order_id THEN
      RAISE EXCEPTION 'COMPLETE_STAY command may only append its typed fulfillment pair'
        USING ERRCODE = '23514', CONSTRAINT = 'amendments_complete_stay_typed_pair';
    END IF;
    IF NEW.amendment_type = 'CHECK_IN' THEN
      IF NEW.payload ->> 'fromStatus' IS DISTINCT FROM 'RESERVED'
        OR NEW.payload ->> 'toStatus' IS DISTINCT FROM 'CHECKED_IN' THEN
        RAISE EXCEPTION 'COMPLETE_STAY CHECK_IN payload is invalid'
          USING ERRCODE = '23514', CONSTRAINT = 'amendments_complete_stay_check_in_payload';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.payload ->> 'fromStatus' IS DISTINCT FROM 'CHECKED_IN'
      OR NEW.payload ->> 'toStatus' IS DISTINCT FROM 'CHECKED_OUT'
      OR NOT EXISTS (
        SELECT 1
        FROM amendments AS checked_in
        WHERE checked_in.order_id = NEW.order_id
          AND checked_in.command_id = NEW.command_id
          AND checked_in.sequence = NEW.sequence - 1
          AND checked_in.amendment_type = 'CHECK_IN'
          AND checked_in.reason_code = 'COMPLETE_STAY'
          AND checked_in.reason_note = NEW.reason_note
      ) THEN
      RAISE EXCEPTION 'COMPLETE_STAY checkout requires one adjacent typed CHECK_IN'
        USING ERRCODE = '23514', CONSTRAINT = 'amendments_complete_stay_checkout_chain';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.amendment_type NOT IN ('SHORTEN_STAY', 'CHECK_OUT') THEN
    RETURN NEW;
  END IF;

  IF NEW.amendment_type = 'SHORTEN_STAY' THEN
    IF NEW.command_id IS NULL THEN
      RAISE EXCEPTION 'new SHORTEN_STAY amendments require a command execution'
        USING ERRCODE = '23514', CONSTRAINT = 'amendments_stage10_command_required';
    END IF;
    SELECT command_type INTO execution_type
      FROM command_executions
      WHERE id = NEW.command_id;
    IF execution_type IS DISTINCT FROM 'SHORTEN_STAY' THEN
      RAISE EXCEPTION 'SHORTEN_STAY amendment requires a SHORTEN_STAY command execution'
        USING ERRCODE = '23514', CONSTRAINT = 'amendments_stage10_shorten_command_type';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.command_id IS NOT NULL THEN
    SELECT command_type INTO execution_type
      FROM command_executions
      WHERE id = NEW.command_id;
    IF execution_type NOT IN ('CHECK_OUT', 'SHORTEN_STAY', 'BACKFILL_COMPLETED_STAY', 'CREATE_ORDER', 'COMPLETE_STAY') THEN
      RAISE EXCEPTION 'CHECK_OUT amendment requires an approved checkout command execution'
        USING ERRCODE = '23514', CONSTRAINT = 'amendments_stage10_checkout_command_type';
    END IF;
    IF execution_type = 'SHORTEN_STAY' THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT departure_date INTO planned_departure
    FROM orders
    WHERE id = NEW.order_id;
  BEGIN
    recorded_business_date := (NEW.payload ->> 'businessDate')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'CHECK_OUT requires a typed business date'
      USING ERRCODE = '23514', CONSTRAINT = 'amendments_stage10_checkout_business_date';
  END;

  IF recorded_business_date IS NULL OR recorded_business_date < planned_departure THEN
    RAISE EXCEPTION 'ordinary CHECK_OUT cannot end a stay before its planned departure date'
      USING ERRCODE = '23514', CONSTRAINT = 'amendments_stage10_checkout_not_early';
  END IF;

  IF execution_type = 'CREATE_ORDER' THEN
    IF NEW.reason_code IS DISTINCT FROM 'BACKFILL_STAY'
      OR NOT EXISTS (
        SELECT 1
        FROM amendments AS created
        WHERE created.order_id = NEW.order_id
          AND created.command_id = NEW.command_id
          AND created.sequence = 1
          AND created.amendment_type = 'CREATE_ORDER'
          AND created.reason_code = 'BACKFILL_STAY'
          AND created.reason_note = NEW.reason_note
      )
      OR NOT EXISTS (
        SELECT 1
        FROM amendments AS checked_in
        WHERE checked_in.order_id = NEW.order_id
          AND checked_in.command_id = NEW.command_id
          AND checked_in.sequence = 2
          AND checked_in.amendment_type = 'CHECK_IN'
          AND checked_in.reason_code = 'BACKFILL_STAY'
          AND checked_in.reason_note = NEW.reason_note
      ) THEN
      RAISE EXCEPTION 'CREATE_ORDER checkout requires one atomic BACKFILL_STAY create and check-in chain'
        USING ERRCODE = '23514', CONSTRAINT = 'amendments_backfill_create_order_checkout_chain';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP INDEX IF EXISTS amendments_one_fulfillment_type_per_command;
CREATE UNIQUE INDEX amendments_one_fulfillment_type_per_command
  ON amendments (command_id, amendment_type)
  WHERE command_id IS NOT NULL
    AND amendment_type IN ('CHECK_IN', 'CHECK_OUT');

CREATE OR REPLACE FUNCTION qintopia_validate_complete_stay_execution_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_command_id text;
  execution_type text;
  execution_state text;
  amendment_count bigint;
  check_in_count bigint;
  check_out_count bigint;
  order_count bigint;
  valid_fact_count bigint;
  check_in_sequence integer;
  check_out_sequence integer;
BEGIN
  target_command_id := CASE
    WHEN TG_TABLE_NAME = 'command_executions' THEN to_jsonb(NEW) ->> 'id'
    ELSE to_jsonb(NEW) ->> 'command_id'
  END;
  IF target_command_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT command_type, state INTO execution_type, execution_state
    FROM command_executions
    WHERE id = target_command_id;
  IF execution_type IS DISTINCT FROM 'COMPLETE_STAY' THEN
    RETURN NULL;
  END IF;
  IF execution_state IS DISTINCT FROM 'APPLIED' THEN
    IF TG_TABLE_NAME = 'amendments' THEN
      RAISE EXCEPTION 'COMPLETE_STAY fulfillment facts require an APPLIED execution'
        USING ERRCODE = '23514', CONSTRAINT = 'command_executions_complete_stay_applied';
    END IF;
    RETURN NULL;
  END IF;

  SELECT
    count(*),
    count(*) FILTER (WHERE amendment_type = 'CHECK_IN'),
    count(*) FILTER (WHERE amendment_type = 'CHECK_OUT'),
    count(DISTINCT order_id),
    count(*) FILTER (
      WHERE reason_code = 'COMPLETE_STAY'
        AND btrim(reason_note) <> ''
        AND payload ->> 'orderId' = order_id
    ),
    min(sequence) FILTER (WHERE amendment_type = 'CHECK_IN'),
    min(sequence) FILTER (WHERE amendment_type = 'CHECK_OUT')
  INTO
    amendment_count,
    check_in_count,
    check_out_count,
    order_count,
    valid_fact_count,
    check_in_sequence,
    check_out_sequence
  FROM amendments
  WHERE command_id = target_command_id;

  IF amendment_count <> 2
    OR check_in_count <> 1
    OR check_out_count <> 1
    OR order_count <> 1
    OR valid_fact_count <> 2
    OR check_out_sequence <> check_in_sequence + 1 THEN
    RAISE EXCEPTION 'APPLIED COMPLETE_STAY requires exactly one adjacent CHECK_IN and CHECK_OUT pair'
      USING ERRCODE = '23514', CONSTRAINT = 'command_executions_complete_stay_exact_pair';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS command_executions_complete_stay_exact_pair ON command_executions;
CREATE CONSTRAINT TRIGGER command_executions_complete_stay_exact_pair
AFTER INSERT OR UPDATE ON command_executions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_complete_stay_execution_chain();

DROP TRIGGER IF EXISTS amendments_complete_stay_exact_pair ON amendments;
CREATE CONSTRAINT TRIGGER amendments_complete_stay_exact_pair
AFTER INSERT ON amendments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_complete_stay_execution_chain();

CREATE OR REPLACE FUNCTION qintopia_validate_backfill_cash_collection() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  execution_type text;
  is_completed_stay_backfill boolean;
  is_complete_stay boolean;
BEGIN
  IF NEW.cash_collector IS NOT NULL
    AND (NEW.fact_type <> 'COLLECTION' OR NEW.method <> 'CASH') THEN
    RAISE EXCEPTION 'cash collector is only valid on cash collection facts'
      USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_cash_collector_method';
  END IF;

  SELECT command_type INTO execution_type
    FROM command_executions
    WHERE id = NEW.command_id;
  IF execution_type = 'COMPLETE_STAY' THEN
    IF NEW.fact_type = 'COLLECTION' AND NEW.method = 'CASH' THEN
      IF NEW.cash_collector IS NULL OR btrim(NEW.cash_collector) = '' THEN
        RAISE EXCEPTION 'cash COMPLETE_STAY collection requires a cash collector'
          USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_complete_stay_cash_collector_required';
      END IF;
      IF NEW.note IS NULL OR btrim(NEW.note) = '' THEN
        RAISE EXCEPTION 'cash COMPLETE_STAY collection requires a collection note'
          USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_complete_stay_cash_note_required';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF execution_type = 'CREATE_ORDER' THEN
    SELECT EXISTS (
      SELECT 1
      FROM amendments
      WHERE order_id = NEW.order_id
        AND command_id = NEW.command_id
        AND amendment_type = 'CREATE_ORDER'
        AND reason_code = 'BACKFILL_STAY'
    ) INTO is_completed_stay_backfill;
    IF is_completed_stay_backfill
      AND NEW.fact_type = 'COLLECTION'
      AND NEW.method = 'CASH' THEN
      IF NEW.cash_collector IS NULL OR btrim(NEW.cash_collector) = '' THEN
        RAISE EXCEPTION 'cash completed-stay backfill requires a cash collector'
          USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_backfill_cash_collector_required';
      END IF;
      IF NEW.note IS NULL OR btrim(NEW.note) = '' THEN
        RAISE EXCEPTION 'cash completed-stay backfill requires a collection note'
          USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_backfill_cash_note_required';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
