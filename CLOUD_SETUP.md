# DDS Cloud Sync + Role Auth Setup (Supabase)

This guide upgrades DDS from anonymous write mode to login email + role mode.
It also keeps users signed in automatically after first login.

## 1. Enable Supabase Email Auth

1. Open Supabase -> Authentication -> Providers.
2. Enable Email provider.
3. Keep Magic Link enabled.

## 2. Ensure tables exist

Run in Supabase SQL editor:

```sql
create table if not exists public.dds_state (
  state_key text primary key,
  workspace_id text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.dds_workspace_members (
  id bigserial primary key,
  workspace_id text not null,
  email text not null,
  role text not null check (role in ('admin', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  unique (workspace_id, email)
);

create index if not exists dds_state_workspace_idx on public.dds_state (workspace_id);
create index if not exists dds_members_workspace_email_idx on public.dds_workspace_members (workspace_id, email);

alter table public.dds_state enable row level security;
alter table public.dds_workspace_members enable row level security;
```

## 3. Seed at least one admin email

Run this first so an admin can sign in and manage members in the UI:

```sql
insert into public.dds_workspace_members (workspace_id, email, role)
values
('cn-mo-qa-team-a', 'your-admin@company.com', 'admin')
on conflict (workspace_id, email)
do update set role = excluded.role;
```

Then add editors/viewers as needed:

```sql
insert into public.dds_workspace_members (workspace_id, email, role)
values
('cn-mo-qa-team-a', 'editor1@company.com', 'editor'),
('cn-mo-qa-team-a', 'viewer1@company.com', 'viewer')
on conflict (workspace_id, email)
do update set role = excluded.role;
```

## 4. Remove anonymous-write policies (if you created them during migration)

```sql
drop policy if exists dds_state_select_anon_workspace on public.dds_state;
drop policy if exists dds_state_insert_anon_workspace on public.dds_state;
drop policy if exists dds_state_update_anon_workspace on public.dds_state;
```

## 5. Apply role-based RLS policies

### 5.1 Policies for dds_state

```sql
drop policy if exists dds_select_by_email on public.dds_state;
drop policy if exists dds_insert_by_email on public.dds_state;
drop policy if exists dds_update_by_email on public.dds_state;

create policy dds_select_by_email on public.dds_state
for select
to authenticated
using (
  exists (
    select 1
    from public.dds_workspace_members m
    where m.workspace_id = dds_state.workspace_id
      and lower(m.email) = lower(auth.jwt()->>'email')
  )
);

create policy dds_insert_by_email on public.dds_state
for insert
to authenticated
with check (
  exists (
    select 1
    from public.dds_workspace_members m
    where m.workspace_id = dds_state.workspace_id
      and lower(m.email) = lower(auth.jwt()->>'email')
      and m.role in ('admin', 'editor')
  )
);

create policy dds_update_by_email on public.dds_state
for update
to authenticated
using (
  exists (
    select 1
    from public.dds_workspace_members m
    where m.workspace_id = dds_state.workspace_id
      and lower(m.email) = lower(auth.jwt()->>'email')
      and m.role in ('admin', 'editor')
  )
)
with check (
  exists (
    select 1
    from public.dds_workspace_members m
    where m.workspace_id = dds_state.workspace_id
      and lower(m.email) = lower(auth.jwt()->>'email')
      and m.role in ('admin', 'editor')
  )
);
```

### 5.2 Policies for dds_workspace_members

```sql
drop policy if exists members_select_by_workspace_user on public.dds_workspace_members;
drop policy if exists members_insert_by_admin on public.dds_workspace_members;
drop policy if exists members_update_by_admin on public.dds_workspace_members;
drop policy if exists members_delete_by_admin on public.dds_workspace_members;

create policy members_select_by_workspace_user on public.dds_workspace_members
for select
to authenticated
using (
  exists (
    select 1
    from public.dds_workspace_members me
    where me.workspace_id = dds_workspace_members.workspace_id
      and lower(me.email) = lower(auth.jwt()->>'email')
  )
);

create policy members_insert_by_admin on public.dds_workspace_members
for insert
to authenticated
with check (
  exists (
    select 1
    from public.dds_workspace_members me
    where me.workspace_id = dds_workspace_members.workspace_id
      and lower(me.email) = lower(auth.jwt()->>'email')
      and me.role = 'admin'
  )
);

create policy members_update_by_admin on public.dds_workspace_members
for update
to authenticated
using (
  exists (
    select 1
    from public.dds_workspace_members me
    where me.workspace_id = dds_workspace_members.workspace_id
      and lower(me.email) = lower(auth.jwt()->>'email')
      and me.role = 'admin'
  )
)
with check (
  exists (
    select 1
    from public.dds_workspace_members me
    where me.workspace_id = dds_workspace_members.workspace_id
      and lower(me.email) = lower(auth.jwt()->>'email')
      and me.role = 'admin'
  )
);

create policy members_delete_by_admin on public.dds_workspace_members
for delete
to authenticated
using (
  exists (
    select 1
    from public.dds_workspace_members me
    where me.workspace_id = dds_workspace_members.workspace_id
      and lower(me.email) = lower(auth.jwt()->>'email')
      and me.role = 'admin'
  )
);
```

## 6. App config

Set cloud-config.js to auth-required mode:

```js
window.DDS_CLOUD_CONFIG = {
    enabled: true,
    baseUrl: 'https://YOUR_PROJECT_ID.supabase.co',
    anonKey: 'YOUR_SUPABASE_ANON_KEY',
    tableName: 'dds_state',
    workspaceId: 'cn-mo-qa-team-a',
    requireAuth: true,
    useWorkspaceColumn: true
};
```

## 7. Auto login persistence behavior

The UI uses Supabase client auth settings:

- persistSession: true
- autoRefreshToken: true
- detectSessionInUrl: true

Result: after first magic-link login, users stay signed in across reopen/refresh until they logout or session expires.

## 8. Expected role behavior

- admin: read + write dashboard data, manage workspace members.
- editor: read + write dashboard data, cannot manage members.
- viewer: read-only dashboard data, cannot write, cannot manage members.

## 9. Validation checklist

1. Login with admin email: dashboard writes succeed, admin page can add/update/remove members.
2. Login with editor email: dashboard writes succeed, admin page is blocked.
3. Login with viewer email: dashboard becomes read-only.
4. Close browser and reopen: user remains signed in automatically.
