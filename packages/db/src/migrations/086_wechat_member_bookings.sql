CREATE TABLE wechat_member_rule_versions (
  property_id text NOT NULL REFERENCES properties(id), version integer NOT NULL CHECK (version > 0),
  settings jsonb NOT NULL, updated_by text NOT NULL REFERENCES subjects(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(property_id,version)
);
CREATE TABLE wechat_member_bookings (
  id text PRIMARY KEY, app_id text NOT NULL, property_id text NOT NULL, member_id text NOT NULL,
  binding_id text NOT NULL REFERENCES wechat_member_bindings(id),
  arrival_date date NOT NULL, departure_date date NOT NULL CHECK (departure_date > arrival_date),
  room_type_code text NOT NULL, room_type_name text NOT NULL, inventory_kind text NOT NULL CHECK (inventory_kind IN ('ROOM','BED')),
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CONFIRMED','DECLINED')),
  order_id text UNIQUE REFERENCES orders(id), decided_by text REFERENCES subjects(id),
  created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz,
  FOREIGN KEY(member_id,property_id) REFERENCES member_property_links(member_id,property_id),
  CHECK ((status='PENDING') = (decided_by IS NULL) AND (status='PENDING') = (decided_at IS NULL)),
  CHECK ((status='CONFIRMED') = (order_id IS NOT NULL))
);
CREATE TABLE wechat_member_booking_requests (
  app_id text NOT NULL, property_id text NOT NULL, member_id text NOT NULL, request_key uuid NOT NULL,
  booking_id text NOT NULL REFERENCES wechat_member_bookings(id),
  PRIMARY KEY (app_id,property_id,member_id,request_key)
);
CREATE INDEX wechat_bookings_queue ON wechat_member_bookings(property_id,status,created_at);
CREATE INDEX wechat_bookings_member ON wechat_member_bookings(app_id,property_id,member_id,created_at DESC);
ALTER TABLE quotes ADD COLUMN wechat_booking_id text REFERENCES wechat_member_bookings(id);
ALTER TABLE wechat_member_bindings ADD COLUMN booking_template text;
ALTER TABLE wechat_member_expiry_notices DROP CONSTRAINT wechat_member_expiry_notices_lead_days_check,
  ADD CHECK (lead_days BETWEEN 0 AND 3650);
CREATE TABLE wechat_member_interactions (
  event_key text PRIMARY KEY, app_id text NOT NULL, property_id text NOT NULL REFERENCES properties(id),
  member_id text REFERENCES members(id), binding_id text REFERENCES wechat_member_bindings(id),
  booking_id text REFERENCES wechat_member_bookings(id), kind text NOT NULL,
  state text NOT NULL CHECK(state IN ('PENDING','ACCEPTED','REJECTED','UNKNOWN','SKIPPED','RECORDED')),
  detail text NOT NULL, template_id text, content jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wechat_interactions_property ON wechat_member_interactions(property_id,created_at DESC,event_key);
CREATE INDEX wechat_interactions_pending ON wechat_member_interactions(app_id,property_id,created_at) WHERE state='PENDING';
REVOKE ALL ON wechat_member_bookings, wechat_member_booking_requests, wechat_member_interactions, wechat_member_rule_versions FROM PUBLIC, qintopia_runtime, qintopia_ai_analytics_reader;
GRANT SELECT, INSERT ON wechat_member_bookings, wechat_member_booking_requests, wechat_member_interactions, wechat_member_rule_versions TO qintopia_runtime;
GRANT UPDATE (status,order_id,decided_by,decided_at) ON wechat_member_bookings TO qintopia_runtime;
GRANT UPDATE (state,detail,template_id,content,updated_at) ON wechat_member_interactions TO qintopia_runtime;
GRANT UPDATE (booking_template) ON wechat_member_bindings TO qintopia_runtime;

ALTER TABLE wechat_member_bindings ADD CHECK (open_id IS NOT NULL OR booking_template IS NULL);
-- All unbinding paths, including older application versions, retire the added subscription.
CREATE FUNCTION qintopia_clear_revoked_booking_template() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.booking_template := NULL;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION qintopia_clear_revoked_booking_template() FROM PUBLIC;
CREATE TRIGGER wechat_clear_booking_subscription BEFORE UPDATE OF open_id ON wechat_member_bindings
FOR EACH ROW WHEN (NEW.open_id IS NULL AND NEW.booking_template IS NOT NULL)
EXECUTE FUNCTION qintopia_clear_revoked_booking_template();

-- Preserve provider facts that predate the interaction journal, without reconstructing message text.
INSERT INTO wechat_member_interactions(event_key, app_id,property_id,member_id,binding_id,kind,state,detail,created_at,updated_at)
SELECT 'binding:' || id,app_id,property_id,member_id,id,'绑定微信','RECORDED','已有绑定记录',bound_at,bound_at FROM wechat_member_bindings;
INSERT INTO wechat_member_interactions(event_key, app_id,property_id,member_id,binding_id,kind,state,detail,created_at,updated_at)
SELECT 'unlink:' || id,app_id,property_id,member_id,id,'解除绑定','RECORDED','已有解绑记录',revoked_at,revoked_at
FROM wechat_member_bindings WHERE revoked_at IS NOT NULL;
INSERT INTO wechat_member_interactions(event_key,app_id,property_id,member_id,binding_id,kind,state,detail,created_at,updated_at)
SELECT concat('[',to_json('expiry'::text),',',to_json(n.app_id),',',to_json(n.order_id),',',to_json(n.expires_on::text),',',n.lead_days,']'),
  n.app_id,b.property_id,b.member_id,b.id,'权益到期',
  CASE WHEN n.state='RETRY' THEN 'REJECTED' ELSE n.state END,'历史发送记录，当时未保存模板内容',n.attempted_at,n.attempted_at
FROM wechat_member_expiry_notices n JOIN wechat_member_bindings b ON b.id=n.binding_id;
