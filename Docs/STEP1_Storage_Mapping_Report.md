# Step 1 - Storage Mapping Baseline (DDS)

Date: 2026-08-02
Scope: Entire workspace source files under root, pages, and archive folder.
Method: Static scan of localStorage read/write usage and key references.

## 1) Key Inventory

| Key | Domain | Owner Page(s) | Priority Class |
|---|---|---|---|
| weeklyDDSGeneralState | Module 1 notes current week | index | P0 Core |
| weeklyDDSTriggersDateState | Trigger timeline anchor | index, admin | P0 Core |
| weeklyDDSTriggersState | Trigger labels/values/order | index, admin | P0 Core |
| weeklyDDSTriggerDetailsState | Module 3 details rows | index | P0 Core |
| weeklyDDSFollowUpsState | Module 4 follow-up rows | index | P0 Core |
| weeklyDDSHistoryArchive | Weekly snapshots + removed closed items | index, history | P0 Core |
| weeklyDDSWorkspaceConfigState | Reminder/trigger workspace config | index, admin | P1 Config |
| weeklyDDSGeneralHistory | short notes history (6) | index | P2 Auxiliary |
| ddsLocalWorkspaceMembers:{workspaceId} | Local admin member cache fallback | admin | P2 Fallback |

## 2) Read/Write Mapping by Page

### index page (via script.js)

Reads:
- loadState generic reader used by all keys: script.js:828-835
- weeklyDDSTriggersDateState: script.js:808
- weeklyDDSHistoryArchive: script.js:903, script.js:1021
- weeklyDDSTriggersState: script.js:987
- weeklyDDSGeneralState: script.js:997, script.js:1043
- weeklyDDSGeneralHistory: script.js:1046
- weeklyDDSTriggerDetailsState: script.js:1102
- weeklyDDSFollowUpsState: script.js:1175
- weeklyDDSWorkspaceConfigState through WORKSPACE_CONFIG_STORAGE_KEY: script.js:17, script.js:880

Writes:
- saveState generic writer: script.js:891-898
- cloud bootstrap writes local key from scoped cloud key: script.js:684
- weeklyDDSHistoryArchive: script.js:943, script.js:1037
- weeklyDDSTriggersState: script.js:993
- weeklyDDSGeneralHistory: script.js:1052
- weeklyDDSGeneralState: script.js:1058, script.js:1078, script.js:1712
- weeklyDDSTriggerDetailsState: script.js:1126, script.js:1496, script.js:1506, script.js:1669
- weeklyDDSFollowUpsState: script.js:1212, script.js:1217, script.js:1598, script.js:1608, script.js:1682
- weeklyDDSTriggersDateState: script.js:822, script.js:1344

### history page (pages/history.html)

Reads:
- generic loadState: pages/history.html:118-125
- weeklyDDSHistoryArchive: pages/history.html:163, pages/history.html:173, pages/history.html:268

Writes:
- generic saveState: pages/history.html:127-129
- weeklyDDSHistoryArchive (delete actions): pages/history.html:167, pages/history.html:178
- weeklyDDSHistoryArchive (bootstrap from cloud): pages/history.html:264

### admin page (pages/admin.html)

Reads:
- ddsLocalWorkspaceMembers:{workspaceId}: pages/admin.html:86, pages/admin.html:126
- generic local JSON reader: pages/admin.html:144-149
- weeklyDDSWorkspaceConfigState (fallback path): pages/admin.html:87, pages/admin.html:322
- weeklyDDSTriggersDateState (fallback path): pages/admin.html:88, pages/admin.html:323
- weeklyDDSTriggersState (fallback path): pages/admin.html:89, pages/admin.html:382

Writes:
- ddsLocalWorkspaceMembers:{workspaceId}: pages/admin.html:135
- remove ddsLocalWorkspaceMembers:{workspaceId}: pages/admin.html:139
- generic local JSON writer: pages/admin.html:152-154
- weeklyDDSWorkspaceConfigState (fallback path): pages/admin.html:398
- weeklyDDSTriggersDateState (fallback path): pages/admin.html:399
- weeklyDDSTriggersState (fallback path): pages/admin.html:400

### masterplan page (pages/masterplan.html)

- No localStorage read/write usage found.

### archive folder

- archive directory is empty; no localStorage usage found.

## 3) Data Structure Baseline

1. weeklyDDSGeneralState
- Type: object
- Shape: { weekKey: string, notes: object }
- Note: notes currently uses combined-notes text key in UI path.

2. weeklyDDSTriggersDateState
- Type: object
- Shape: { startDate: string, weekKey: string }

3. weeklyDDSTriggersState
- Type: object
- Shape: { labels: string[], values: string[][], orders: number[] }

4. weeklyDDSTriggerDetailsState
- Type: object
- Shape: { weekKey: string, items: TriggerDetail[] }
- TriggerDetail fields: triggerType, triggerDetail, nextStep, owner, dueDate, status

5. weeklyDDSFollowUpsState
- Type: object
- Shape: { weekKey: string, items: FollowUp[] }
- FollowUp fields: bucket, taskName, comments, assignTo, dueDate, status

6. weeklyDDSHistoryArchive
- Type: array
- Shape item: {
  weekKey, weekLabel, capturedAt,
  generalNotes, triggerLabels, triggerValues, triggerDetails, followUps,
  removedItems?
}
- removedItems fields: kind, item, removedAt

7. weeklyDDSWorkspaceConfigState
- Type: object
- Shape: { reminderItems: {key,label}[], triggerRows: string[], defaultTriggerStartDate: string }

8. weeklyDDSGeneralHistory
- Type: array
- Shape item: { weekLabel: string, notes: object }

9. ddsLocalWorkspaceMembers:{workspaceId}
- Type: array
- Shape item: { id, workspace_id, email, role, created_at }

## 4) Migration Class Assignment

- P0 Core: weeklyDDSGeneralState, weeklyDDSTriggersDateState, weeklyDDSTriggersState, weeklyDDSTriggerDetailsState, weeklyDDSFollowUpsState, weeklyDDSHistoryArchive
- P1 Config: weeklyDDSWorkspaceConfigState
- P2 Auxiliary/Fallback: weeklyDDSGeneralHistory, ddsLocalWorkspaceMembers:{workspaceId}

## 5) Step 1 Acceptance Checklist

### AC-1: All currently used localStorage keys are inventoried
- Result: PASS
- Evidence: Key inventory section + references from script.js/pages admin/history.

### AC-2: Every key has owner page and read/write mapping
- Result: PASS
- Evidence: Section 2 page-by-page mapping.

### AC-3: Data structure baseline exists for each key
- Result: PASS
- Evidence: Section 3 structure definitions.

### AC-4: Scope includes full project pages and archive folder
- Result: PASS
- Evidence: index, admin, history, masterplan scanned; archive confirmed empty.

### AC-5: Unknown key writers are identified
- Result: PARTIAL PASS
- Finding: script.js cloud bootstrap writes dynamic local key names from cloud state_key suffix (script.js:684).
- Impact: This is known/intentional in current design, but should be constrained by a whitelist in migration Step 3.

## 6) Step 1 Exit Decision

Step 1 is accepted with one tracked note:
- Dynamic local key write path exists and must be constrained during dual-write hardening.

Ready to proceed to Step 2 (Supabase table design).
