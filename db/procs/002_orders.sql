-- ==============================================================
-- Order functions and procedures
-- ==============================================================

-- Returns order + user + items as a single jsonb object (1 round-trip).
-- Node receives a parsed JS object; created_at fields are ISO strings
-- that the adapter converts to Date.
CREATE OR REPLACE FUNCTION sp_get_order_with_details(p_order_id int)
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'order', jsonb_build_object(
      'id',         o.id,
      'user_id',    o.user_id,
      'status',     o.status,
      'total',      o.total::text,
      'created_at', o.created_at
    ),
    'user', jsonb_build_object(
      'id',    u.id,
      'email', u.email,
      'name',  u.name
    ),
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',           oi.id,
        'order_id',     oi.order_id,
        'product_id',   oi.product_id,
        'quantity',     oi.quantity,
        'unit_price',   oi.unit_price::text,
        'product_name', p.name
      ))
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = o.id
    ), '[]'::jsonb)
  )
  FROM orders o
  JOIN users u ON u.id = o.user_id
  WHERE o.id = p_order_id;
$$;

-- Aggregated order totals per user
CREATE OR REPLACE FUNCTION sp_get_user_order_totals(p_limit int)
RETURNS TABLE(
  user_id     int,
  user_name   text,
  order_count int,
  total_spent text
)
LANGUAGE sql STABLE AS $$
  SELECT
    u.id                                   AS user_id,
    u.name                                 AS user_name,
    COUNT(o.id)::int                       AS order_count,
    COALESCE(SUM(o.total), 0)::text        AS total_spent
  FROM users u
  LEFT JOIN orders o ON o.user_id = u.id
  GROUP BY u.id, u.name
  ORDER BY COALESCE(SUM(o.total), 0) DESC
  LIMIT p_limit;
$$;

-- CTE + window function: last order per user
CREATE OR REPLACE FUNCTION sp_get_last_order_per_user(p_limit int)
RETURNS TABLE(
  user_id          int,
  user_email       text,
  last_order_id    int,
  last_order_total text,
  last_order_at    timestamptz
)
LANGUAGE sql STABLE AS $$
  WITH ranked AS (
    SELECT
      o.id          AS last_order_id,
      o.user_id,
      o.total       AS last_order_total,
      o.created_at  AS last_order_at,
      ROW_NUMBER() OVER (PARTITION BY o.user_id ORDER BY o.created_at DESC) AS rn
    FROM orders o
  )
  SELECT
    r.user_id,
    u.email            AS user_email,
    r.last_order_id,
    r.last_order_total::text,
    r.last_order_at
  FROM ranked r
  JOIN users u ON u.id = r.user_id
  WHERE r.rn = 1
  ORDER BY r.last_order_at DESC
  LIMIT p_limit;
$$;

-- Deep join: returns flat rows (same shape as raw adapter's TopOrderRow).
-- Aggregation is done in Node — same as raw/knex/dal.
-- The JOIN SQL lives in the database; no SQL text sent over the wire per call.
CREATE OR REPLACE FUNCTION sp_get_top_orders_with_items(p_limit int)
RETURNS TABLE(
  order_id         int,
  user_id          int,
  status           text,
  order_total      text,
  order_created_at timestamptz,
  user_email       text,
  user_name        text,
  item_id          int,
  product_id       int,
  quantity         int,
  unit_price       text,
  product_name     text,
  category_name    text,
  pay_id           int,
  pay_amount       text,
  pay_status       text,
  pay_paid_at      timestamptz
)
LANGUAGE sql STABLE AS $$
  SELECT
    o.id              AS order_id,
    o.user_id,
    o.status,
    o.total::text     AS order_total,
    o.created_at      AS order_created_at,
    u.email           AS user_email,
    u.name            AS user_name,
    oi.id             AS item_id,
    oi.product_id,
    oi.quantity,
    oi.unit_price::text,
    p.name            AS product_name,
    c.name            AS category_name,
    pay.id            AS pay_id,
    pay.amount::text  AS pay_amount,
    pay.status        AS pay_status,
    pay.paid_at       AS pay_paid_at
  FROM (SELECT id FROM orders ORDER BY created_at DESC LIMIT p_limit) top
  JOIN orders o           ON o.id = top.id
  JOIN users u            ON u.id = o.user_id
  JOIN order_items oi     ON oi.order_id = o.id
  JOIN products p         ON p.id = oi.product_id
  JOIN categories c       ON c.id = p.category_id
  LEFT JOIN payments pay  ON pay.order_id = o.id
  ORDER BY o.created_at DESC, oi.id;
$$;

-- Transactional write: insert order + items + payment atomically.
-- Entire transaction in one function call = 1 round-trip from Node.
-- p_items JSON shape: [{"productId":N,"quantity":N,"unitPrice":N.NN}]
CREATE OR REPLACE FUNCTION sp_create_order_with_items(
  p_user_id        int,
  p_items          jsonb,
  p_payment_amount numeric
)
RETURNS TABLE(id int, user_id int, status text, total text, created_at timestamptz)
LANGUAGE plpgsql AS $$
DECLARE
  v_order_id int;
BEGIN
  INSERT INTO orders (user_id, status, total)
  VALUES (p_user_id, 'pending', p_payment_amount)
  RETURNING orders.id INTO v_order_id;

  INSERT INTO order_items (order_id, product_id, quantity, unit_price)
  SELECT
    v_order_id,
    (item->>'productId')::int,
    (item->>'quantity')::int,
    (item->>'unitPrice')::numeric
  FROM jsonb_array_elements(p_items) AS item;

  INSERT INTO payments (order_id, amount, status)
  VALUES (v_order_id, p_payment_amount, 'pending');

  RETURN QUERY
    SELECT o.id, o.user_id, o.status, o.total::text, o.created_at
    FROM orders o WHERE o.id = v_order_id;
END;
$$;

-- Bulk transactional write: multiple orders in one call.
-- p_orders JSON shape: [{"userId":N,"paymentAmount":N,"items":[...]}]
-- 5 orders × 10 items = 1 function call vs 60 statements (Prisma) / 15 (raw).
CREATE OR REPLACE FUNCTION sp_bulk_create_orders(p_orders jsonb)
RETURNS TABLE(id int, user_id int, status text, total text, created_at timestamptz)
LANGUAGE plpgsql AS $$
DECLARE
  v_order    jsonb;
  v_order_id int;
BEGIN
  FOR v_order IN SELECT value FROM jsonb_array_elements(p_orders) LOOP
    INSERT INTO orders (user_id, status, total)
    VALUES (
      (v_order->>'userId')::int,
      'pending',
      (v_order->>'paymentAmount')::numeric
    )
    RETURNING orders.id INTO v_order_id;

    INSERT INTO order_items (order_id, product_id, quantity, unit_price)
    SELECT
      v_order_id,
      (item->>'productId')::int,
      (item->>'quantity')::int,
      (item->>'unitPrice')::numeric
    FROM jsonb_array_elements(v_order->'items') AS item;

    INSERT INTO payments (order_id, amount, status)
    VALUES (
      v_order_id,
      (v_order->>'paymentAmount')::numeric,
      'pending'
    );

    RETURN QUERY
      SELECT o.id, o.user_id, o.status, o.total::text, o.created_at
      FROM orders o WHERE o.id = v_order_id;
  END LOOP;
END;
$$;

-- Bulk product insert: single batch INSERT from jsonb array.
-- p_data JSON shape: [{"categoryId":N,"name":"...","price":N,"stock":N}]
CREATE OR REPLACE FUNCTION sp_insert_many_products(p_data jsonb)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
BEGIN
  INSERT INTO products (category_id, name, price, stock)
  SELECT
    (item->>'categoryId')::int,
    item->>'name',
    (item->>'price')::numeric,
    (item->>'stock')::int
  FROM jsonb_array_elements(p_data) AS item;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Update order status; returns true if row was found and updated
CREATE OR REPLACE FUNCTION sp_update_order_status(p_order_id int, p_status text)
RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
BEGIN
  UPDATE orders SET status = p_status WHERE id = p_order_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

-- Delete order; returns true if row existed
CREATE OR REPLACE FUNCTION sp_delete_order(p_order_id int)
RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
BEGIN
  DELETE FROM orders WHERE id = p_order_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;
