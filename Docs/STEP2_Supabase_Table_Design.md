# Step 2 - Supabase Table Design for DDS

Date: 2026-08-02
Scope: Supabase schema needed for the current DDS app state model.

## 1) Design goal
Provide a durable, role-aware, versioned storage model for the current DDS localStorage payloads while keeping the current app's key-based workflows intact.

## 2) Target tables

### A. public.dds_state
Purpose: store all DDS state payloads keyed by workspace and state key.

Columns:
- id: surrogate PK
- workspace_id: workspace scope
- state_key: logical key such as weeklyDDSGeneralState
- payload: JSONB payload
- version: optimistic version counter
- updated_at: timestamp
- updated_by: email or actor string
- source: origin such as web / admin / local-sync

Key constraints:
- unique(workspace_id, state_key)

### B. public.dds_state_audit
Purpose: record inserts/updates for debugging and rollback.

Columns:
- workspace_id
- state_key
- old_payload
- new_payload
- old_version
- new_version
- changed_by
- changed_at
- source

### C. public.dds_workspace_members
Purpose: existing workspace-role membership table for role-based access.

Columns:
- workspace_id
- email
- role
- created_at

## 3) Indexes and performance
- Index on (workspace_id, updated_at desc)
- Index on (workspace_id, state_key)
- Index on (workspace_id, email)
- GIN index on payload JSONB

## 4) Security model
- RLS enabled on all three tables.
- Select/read is allowed for workspace members.
- Insert/update is allowed for editor/admin.
- Delete is allowed for admin only.

## 5) Execution note
The SQL for this design is stored in [STEP2_Supabase_Table_Design.sql](STEP2_Supabase_Table_Design.sql).

## 6) Acceptance checklist
- [x] Base tables defined for state + audit + member access
- [x] Versioning column added for optimistic update handling
- [x] Audit table added for change tracking
- [x] RLS policies drafted for workspace-aware access
- [x] Ready to run in Supabase SQL editor

## 7) Important note
This environment does not have direct Supabase SQL execution access, so the implementation is prepared as an executable SQL script and design doc, ready to be pasted into the Supabase SQL Editor.

## 8) Next step
Proceed to Step 2.5 for Supabase environment provisioning and VS Code connectivity validation before starting Step 3.
