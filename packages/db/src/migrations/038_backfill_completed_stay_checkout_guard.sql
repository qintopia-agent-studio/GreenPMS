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
    IF execution_type NOT IN ('CHECK_OUT', 'SHORTEN_STAY', 'BACKFILL_COMPLETED_STAY') THEN
      RAISE EXCEPTION 'CHECK_OUT amendment requires a CHECK_OUT or SHORTEN_STAY command execution'
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
  RETURN NEW;
END;
$$;
