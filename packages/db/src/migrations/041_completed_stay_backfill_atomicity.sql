LOCK TABLE amendments, collection_facts, command_executions IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE collection_facts
  ADD COLUMN cash_collector text,
  ADD CONSTRAINT collection_facts_cash_collector_nonblank
    CHECK (cash_collector IS NULL OR btrim(cash_collector) <> '');

CREATE OR REPLACE FUNCTION qintopia_reject_stage10_checkout_bypass() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  execution_type text;
  planned_departure date;
  recorded_business_date date;
BEGIN
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
    IF execution_type NOT IN ('CHECK_OUT', 'SHORTEN_STAY', 'BACKFILL_COMPLETED_STAY', 'CREATE_ORDER') THEN
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

CREATE OR REPLACE FUNCTION qintopia_validate_backfill_cash_collection() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  execution_type text;
  is_completed_stay_backfill boolean;
BEGIN
  IF NEW.cash_collector IS NOT NULL
    AND (NEW.fact_type <> 'COLLECTION' OR NEW.method <> 'CASH') THEN
    RAISE EXCEPTION 'cash collector is only valid on cash collection facts'
      USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_cash_collector_method';
  END IF;

  SELECT command_type INTO execution_type
    FROM command_executions
    WHERE id = NEW.command_id;
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

CREATE TRIGGER collection_facts_validate_backfill_cash
BEFORE INSERT ON collection_facts
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_backfill_cash_collection();
