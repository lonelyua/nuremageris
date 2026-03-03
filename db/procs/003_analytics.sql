-- ==============================================================
-- Analytics functions
-- ==============================================================

-- Per-category sales report: GROUP BY + COUNT DISTINCT + SUM
CREATE OR REPLACE FUNCTION sp_get_product_sales_report()
RETURNS TABLE(
  category_id   int,
  category_name text,
  product_count int,
  avg_price     text,
  total_stock   int,
  orders_count  int,
  revenue       text
)
LANGUAGE sql STABLE AS $$
  SELECT
    c.id::int                                                   AS category_id,
    c.name                                                      AS category_name,
    COUNT(DISTINCT p.id)::int                                   AS product_count,
    ROUND(AVG(p.price), 2)::text                                AS avg_price,
    COALESCE(SUM(p.stock), 0)::int                              AS total_stock,
    COUNT(DISTINCT oi.order_id)::int                            AS orders_count,
    COALESCE(SUM(oi.quantity * oi.unit_price), 0)::text         AS revenue
  FROM categories c
  LEFT JOIN products p     ON p.category_id = c.id
  LEFT JOIN order_items oi ON oi.product_id = p.id
  GROUP BY c.id, c.name
  ORDER BY COALESCE(SUM(oi.quantity * oi.unit_price), 0) DESC;
$$;

-- CTE + window function: monthly revenue with running total
CREATE OR REPLACE FUNCTION sp_get_monthly_revenue_trend(p_months int)
RETURNS TABLE(
  year          int,
  month         int,
  order_count   int,
  revenue       text,
  running_total text
)
LANGUAGE sql STABLE AS $$
  WITH monthly AS (
    SELECT
      EXTRACT(YEAR  FROM created_at)::int AS year,
      EXTRACT(MONTH FROM created_at)::int AS month,
      COUNT(*)::int                        AS order_count,
      SUM(total)::text                     AS revenue
    FROM orders
    WHERE created_at >= NOW() - INTERVAL '1 month' * p_months
    GROUP BY year, month
  )
  SELECT
    year, month, order_count, revenue,
    SUM(revenue::numeric) OVER (ORDER BY year, month)::text AS running_total
  FROM monthly
  ORDER BY year, month;
$$;
