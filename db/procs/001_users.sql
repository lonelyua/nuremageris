-- ==============================================================
-- User functions
-- All functions use CREATE OR REPLACE — safe to re-run (idempotent).
-- ==============================================================

-- PK lookup
CREATE OR REPLACE FUNCTION sp_find_user_by_id(p_id int)
RETURNS TABLE(id int, email text, name text, created_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT id, email, name, created_at FROM users WHERE id = p_id;
$$;

-- Email lookup
CREATE OR REPLACE FUNCTION sp_find_user_by_email(p_email text)
RETURNS TABLE(id int, email text, name text, created_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT id, email, name, created_at FROM users WHERE email = p_email;
$$;

-- Paginated list with optional search + createdAfter filter.
-- Dynamic ORDER BY via EXECUTE to keep a single code path.
CREATE OR REPLACE FUNCTION sp_list_users_paged(
  p_search        text,           -- NULL = no name filter
  p_created_after timestamptz,    -- NULL = no date filter
  p_sort_field    text,
  p_sort_dir      text,
  p_limit         int,
  p_offset        int
)
RETURNS TABLE(id int, email text, name text, created_at timestamptz)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_sort_field text := CASE
    WHEN p_sort_field IN ('id', 'email', 'name', 'created_at') THEN p_sort_field
    ELSE 'id'
  END;
  v_sort_dir text := CASE WHEN p_sort_dir = 'desc' THEN 'DESC' ELSE 'ASC' END;
BEGIN
  RETURN QUERY EXECUTE format(
    'SELECT id, email, name, created_at
     FROM users
     WHERE ($1 IS NULL OR name ILIKE ''%%'' || $1 || ''%%'')
       AND ($2 IS NULL OR created_at > $2)
     ORDER BY %I %s
     LIMIT $3 OFFSET $4',
    v_sort_field, v_sort_dir
  ) USING p_search, p_created_after, p_limit, p_offset;
END;
$$;

-- Batch lookup by id array — uses ANY for single-param binding
CREATE OR REPLACE FUNCTION sp_batch_get_users(p_ids int[])
RETURNS TABLE(id int, email text, name text, created_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT id, email, name, created_at FROM users WHERE id = ANY(p_ids);
$$;

-- Insert single user, return inserted row
CREATE OR REPLACE FUNCTION sp_insert_one_user(p_email text, p_name text)
RETURNS TABLE(id int, email text, name text, created_at timestamptz)
LANGUAGE sql AS $$
  INSERT INTO users (email, name) VALUES (p_email, p_name)
  RETURNING id, email, name, created_at;
$$;
