-- Step 2: DDS Supabase Schema Design
-- Purpose: support key-value state storage, versioning, audit trail, and role-based access.
-- Compatible with the current DDS app using public.dds_state and public.dds_workspace_members.

-- 1) Ensure base tables exist
create table if not exists public.dds_state (
  id bigserial primary key,
  workspace_id text not null,
  state_key text not null,
  payload jsonb not null,
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by text,
  source text not null default 'web',
  constraint dds_state_uq unique (workspace_id, state_key)
);

create table if not exists public.dds_workspace_members (
  id bigserial primary key,
  workspace_id text not null,
  email text not null,
  role text not null default 'viewer',
  created_at timestamptz not null default now(),
  constraint dds_workspace_members_uq unique (workspace_id, email)
);

-- 2) Audit table for change history
create table if not exists public.dds_state_audit (
  id bigserial primary key,
  workspace_id text not null,
  state_key text not null,
  old_payload jsonb,
  new_payload jsonb,
  old_version bigint,
  new_version bigint,
  changed_by text,
  changed_at timestamptz not null default now(),
  source text not null default 'web'
);

-- 3) Indexes
create index if not exists dds_state_workspace_updated_idx on public.dds_state (workspace_id, updated_at desc);
create index if not exists dds_state_state_key_idx on public.dds_state (state_key);
create index if not exists dds_state_workspace_state_key_idx on public.dds_state (workspace_id, state_key);
create index if not exists dds_workspace_members_workspace_email_idx on public.dds_workspace_members (workspace_id, email);
create index if not exists dds_state_audit_workspace_state_idx on public.dds_state_audit (workspace_id, state_key, changed_at desc);
create index if not exists dds_state_audit_changed_at_idx on public.dds_state_audit (changed_at desc);

-- Optional: GIN for JSON payload search
create extension if not exists pgcrypto;
create index if not exists dds_state_payload_gin_idx on public.dds_state using gin (payload);

-- 4) Enable RLS
alter table public.dds_state enable row level security;
alter table public.dds_workspace_members enable row level security;
alter table public.dds_state_audit enable row level security;

-- 5) Helper function: current authenticated email
create or replace function public.current_user_email()
returns text
language sql
stable
as $$
  select coalesce(nullif(auth.jwt() ->> 'email', ''), null)
$$;

-- 6) Helper function: whether current user is workspace member with role admin/editor
create or replace function public.user_has_workspace_role(p_workspace_id text, p_required_role text)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.dds_workspace_members m
    where m.workspace_id = p_workspace_id
      and lower(m.email) = lower(coalesce(public.current_user_email(), ''))
      and lower(m.role) in ('admin', 'editor')
      and (
        p_required_role = 'viewer'
        or lower(m.role) = lower(p_required_role)
      )
  )
$$;

-- 7) Row Level Security policies for dds_state
drop policy if exists dds_state_select_by_member on public.dds_state;
drop policy if exists dds_state_insert_by_editor_or_admin on public.dds_state;
drop policy if exists dds_state_update_by_editor_or_admin on public.dds_state;
drop policy if exists dds_state_delete_by_admin on public.dds_state;

create policy dds_state_select_by_member
  on public.dds_state
  for select
  using (
    exists (
      select 1
      from public.dds_workspace_members m
      where m.workspace_id = dds_state.workspace_id
        and lower(m.email) = lower(coalesce(public.current_user_email(), ''))
    )
  );

create policy dds_state_insert_by_editor_or_admin
  on public.dds_state
  for insert
  with check (
    exists (
      select 1
      from public.dds_workspace_members m
      where m.workspace_id = dds_state.workspace_id
        and lower(m.email) = lower(coalesce(public.current_user_email(), ''))
        and lower(m.role) in ('admin', 'editor')
    )
  );

create policy dds_state_update_by_editor_or_admin
  on public.dds_state
  for update
  using (
    exists (
      select 1
      from public.dds_workspace_members m
      where m.workspace_id = dds_state.workspace_id
        and lower(m.email) = lower(coalesce(public.current_user_email(), ''))
        and lower(m.role) in ('admin', 'editor')
    )
  );

create policy dds_state_delete_by_admin
  on public.dds_state
  for delete
  using (
    exists (
      select 1
      from public.dds_workspace_members m
      where m.workspace_id = dds_state.workspace_id
        and lower(m.email) = lower(coalesce(public.current_user_email(), ''))
        and lower(m.role) = 'admin'
    )
  );

-- 8) RLS for dds_workspace_members
-- Members can read their own workspace membership rows; admins can manage rows.
drop policy if exists dds_workspace_members_select_by_member on public.dds_workspace_members;
drop policy if exists dds_workspace_members_insert_by_admin on public.dds_workspace_members;
drop policy if exists dds_workspace_members_update_by_admin on public.dds_workspace_members;
drop policy if exists dds_workspace_members_delete_by_admin on public.dds_workspace_members;

create policy dds_workspace_members_select_by_member
  on public.dds_workspace_members
  for select
  using (
    exists (
      select 1
      from public.dds_workspace_members me
      where me.workspace_id = dds_workspace_members.workspace_id
        and lower(me.email) = lower(coalesce(public.current_user_email(), ''))
    )
  );

create policy dds_workspace_members_insert_by_admin
  on public.dds_workspace_members
  for insert
  with check (
    exists (
      select 1
      from public.dds_workspace_members me
      where me.workspace_id = dds_workspace_members.workspace_id
        and lower(me.email) = lower(coalesce(public.current_user_email(), ''))
        and lower(me.role) = 'admin'
    )
  );

create policy dds_workspace_members_update_by_admin
  on public.dds_workspace_members
  for update
  using (
    exists (
      select 1
      from public.dds_workspace_members me
      where me.workspace_id = dds_workspace_members.workspace_id
        and lower(me.email) = lower(coalesce(public.current_user_email(), ''))
        and lower(me.role) = 'admin'
    )
  );

create policy dds_workspace_members_delete_by_admin
  on public.dds_workspace_members
  for delete
  using (
    exists (
      select 1
      from public.dds_workspace_members me
      where me.workspace_id = dds_workspace_members.workspace_id
        and lower(me.email) = lower(coalesce(public.current_user_email(), ''))
        and lower(me.role) = 'admin'
    )
  );

-- 9) RLS for dds_state_audit
-- Audit rows should be readable by workspace members and writable by admin/editor through app logic.
drop policy if exists dds_state_audit_select_by_member on public.dds_state_audit;
drop policy if exists dds_state_audit_insert_by_editor_or_admin on public.dds_state_audit;
drop policy if exists dds_state_audit_update_by_admin on public.dds_state_audit;

create policy dds_state_audit_select_by_member
  on public.dds_state_audit
  for select
  using (
    exists (
      select 1
      from public.dds_workspace_members m
      where m.workspace_id = dds_state_audit.workspace_id
        and lower(m.email) = lower(coalesce(public.current_user_email(), ''))
    )
  );

create policy dds_state_audit_insert_by_editor_or_admin
  on public.dds_state_audit
  for insert
  with check (
    exists (
      select 1
      from public.dds_workspace_members m
      where m.workspace_id = dds_state_audit.workspace_id
        and lower(m.email) = lower(coalesce(public.current_user_email(), ''))
        and lower(m.role) in ('admin', 'editor')
    )
  );

create policy dds_state_audit_update_by_admin
  on public.dds_state_audit
  for update
  using (
    exists (
      select 1
      from public.dds_workspace_members m
      where m.workspace_id = dds_state_audit.workspace_id
        and lower(m.email) = lower(coalesce(public.current_user_email(), ''))
        and lower(m.role) = 'admin'
    )
  );

-- 10) Trigger function to record audit entries on state updates/inserts
create or replace function public.log_dds_state_change()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.dds_state_audit (
      workspace_id, state_key, old_payload, new_payload, old_version, new_version, changed_by, source
    ) values (
      new.workspace_id,
      new.state_key,
      null,
      new.payload,
      null,
      new.version,
      coalesce(new.updated_by, public.current_user_email()),
      coalesce(new.source, 'web')
    );
    return new;
  elsif tg_op = 'UPDATE' then
    insert into public.dds_state_audit (
      workspace_id, state_key, old_payload, new_payload, old_version, new_version, changed_by, source
    ) values (
      new.workspace_id,
      new.state_key,
      old.payload,
      new.payload,
      old.version,
      new.version,
      coalesce(new.updated_by, public.current_user_email()),
      coalesce(new.source, 'web')
    );
    return new;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_log_dds_state_change on public.dds_state;
create trigger trg_log_dds_state_change
after insert or update on public.dds_state
for each row
execute function public.log_dds_state_change();
