# Step 2.5 - Supabase Environment And Connectivity

Date: 2026-08-02
Scope: add an execution checkpoint between Step 2 schema design and Step 3 app migration.

## 1) Goal
Before Step 3 starts, confirm that the DDS project has a usable Supabase environment and that the local VS Code workspace can reach it reliably.

## 2) Environment model
For Supabase, a separate test environment should be a separate Supabase project. A single Supabase project already contains its own PostgreSQL database, so "test database" in this plan should be implemented as a dedicated test project rather than another database inside the same project.

## 3) Current repository state
- A Supabase project is already configured in cloud-config.js.
- Current configured project URL: https://tamagreqdngmbsoyrknp.supabase.co
- Current mode: requireAuth = true
- Current app target table: public.dds_state

## 4) What was completed in this workspace

### 4.1 Connectivity validation from VS Code
A reusable validation script was added:
- scripts/validate-supabase-connection.ps1

A reusable VS Code task was added:
- Task label: validate-supabase-connection

Validation result from this machine:
- REST endpoint reachable
- Auth endpoint reachable
- Both endpoints returned HTTP 401
- This is expected because the current DDS cloud config requires authenticated access

Interpretation:
- VS Code to Supabase network connectivity is working
- The configured project is online and responding
- Further write/read validation now depends on a real authenticated test account session

### 4.2 Step 2 schema deliverables already prepared
- Step 2 SQL exists and is ready to run in Supabase SQL Editor
- Step 2 table design exists and is consistent with the current app storage model

## 5) What could not be completed automatically here
The following actions require Supabase admin access outside this workspace and were not automatable from the current environment:
- Create a brand new Supabase test project
- Run SQL inside Supabase directly
- Create real Auth users in Supabase Authentication
- Generate or manage project secrets beyond the repo's existing public anon configuration

## 6) Required manual completion for Step 2.5

### 6.1 Create a dedicated test Supabase project
Create one new Supabase project for DDS testing, for example:
- Project name: mo-qa-weekly-dds-test

### 6.2 Apply schema
Run the SQL in:
- Docs/STEP2_Supabase_Table_Design.sql

### 6.3 Enable auth
In Supabase Authentication:
- Enable Email provider
- Keep Magic Link enabled

### 6.4 Create test accounts
Create at least these test identities in Supabase Auth:
- dds-admin-test@your-domain.com
- dds-editor-test@your-domain.com
- dds-viewer-test@your-domain.com

Then seed workspace roles in public.dds_workspace_members with those same emails.

Recommended seed SQL:

```sql
insert into public.dds_workspace_members (workspace_id, email, role)
values
  ('cn-mo-qa-team-a', 'dds-admin-test@your-domain.com', 'admin'),
  ('cn-mo-qa-team-a', 'dds-editor-test@your-domain.com', 'editor'),
  ('cn-mo-qa-team-a', 'dds-viewer-test@your-domain.com', 'viewer')
on conflict (workspace_id, email)
do update set role = excluded.role;
```

### 6.5 Point the repo to the test project
Update cloud-config.js with the test project's:
- baseUrl
- anonKey

### 6.6 Re-run connectivity validation
From VS Code, run:
- Task: validate-supabase-connection

## 7) Acceptance criteria for Step 2.5
- A dedicated Supabase test project exists
- Step 2 schema SQL has been applied
- Three test users exist: admin, editor, viewer
- cloud-config.js points to the intended environment
- VS Code connectivity script reports the project endpoints as reachable
- Authenticated manual smoke tests are ready for Step 3

## 8) Step 2.5 status
Status: partially completed

Completed:
- Existing Supabase project identified from repository config
- VS Code to Supabase endpoint connectivity validated
- Repeatable validation script and VS Code task added

Pending external-admin actions:
- Create dedicated test project
- Apply schema in Supabase
- Create real test auth accounts
- Switch repo config to the test project if needed

## 9) Result summary
The repository is already wired to a live Supabase project, and VS Code can reach that project successfully. What remains is not a code blocker but an environment-admin step: creating or confirming the dedicated test project and test auth accounts in Supabase.