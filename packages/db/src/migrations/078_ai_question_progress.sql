-- Active model streams may outlive ten minutes. Reclaim abandoned telemetry by
-- its last authenticated progress, rather than the question's creation time.
ALTER TABLE ai_question_records DROP CONSTRAINT ai_question_records_duration_ms_check;
ALTER TABLE ai_question_records ADD CONSTRAINT ai_question_records_duration_ms_check CHECK (duration_ms >= 0);

CREATE FUNCTION qintopia_touch_ai_question(question_id text, actor_id text, session_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('qintopia:ai-questions', 0));
  PERFORM 1 FROM ai_question_records q
    JOIN subjects s ON s.id = q.actor_subject_id
    JOIN web_sessions w ON w.subject_id = s.id AND w.id = q.actor_session_id
    JOIN subject_property_grants g ON g.subject_id = s.id AND g.property_id = q.property_id
    WHERE q.id = question_id AND q.actor_subject_id = actor_id AND q.actor_session_id = session_id
      AND s.status = 'ACTIVE' AND w.revoked_at IS NULL AND w.expires_at > clock_timestamp()
    FOR SHARE OF s, w, g;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_QUESTION_FORBIDDEN'; END IF;
  UPDATE ai_question_records SET updated_at = clock_timestamp()
    WHERE id = question_id AND actor_subject_id = actor_id AND actor_session_id = session_id
      AND outcome = 'PENDING' AND updated_at > clock_timestamp() - interval '10 minutes'
      AND created_at > clock_timestamp() - interval '90 days';
END;
$$;
REVOKE ALL ON FUNCTION qintopia_touch_ai_question(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_touch_ai_question(text,text,text) TO qintopia_runtime;

-- Closing an already-authorized event remains allowed after session revocation.
CREATE OR REPLACE FUNCTION qintopia_finish_ai_question(question_id text, actor_id text, session_id text, result text,
  failure_code text, used_tools text[], elapsed_ms integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('qintopia:ai-questions', 0));
  IF result NOT IN ('ANSWERED', 'FAILED') THEN RAISE EXCEPTION 'AI_QUESTION_INVALID'; END IF;
  UPDATE ai_question_records SET outcome = result, error_code = failure_code, tools_used = used_tools,
    duration_ms = elapsed_ms, updated_at = clock_timestamp()
    WHERE id = question_id AND actor_subject_id = actor_id AND actor_session_id = session_id AND outcome = 'PENDING'
      AND updated_at > clock_timestamp() - interval '10 minutes'
      AND created_at > clock_timestamp() - interval '90 days';
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_maintain_ai_questions() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('qintopia:ai-questions', 0));
  UPDATE ai_question_records SET outcome = 'INTERRUPTED', error_code = 'REQUEST_INTERRUPTED', updated_at = clock_timestamp()
    WHERE outcome = 'PENDING' AND updated_at <= clock_timestamp() - interval '10 minutes';
  -- Lifetime rollups intentionally survive detail retention.
  DELETE FROM ai_question_records WHERE created_at <= clock_timestamp() - interval '90 days';
END;
$$;
