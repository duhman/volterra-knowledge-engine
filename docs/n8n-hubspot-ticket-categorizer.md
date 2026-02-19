# n8n HubSpot Ticket Categorizer

Categorizes incoming HubSpot tickets and returns a structured JSON response with
category/subcategory, confidence, rationale, suggested reply, and next steps.

## Workflow

- **Workflow:** `AI agent support - HubSpot ticket categorizer` (`YOUR_WORKFLOW_ID`)
- **Webhook path:** `hubspot-ticket-categorizer`
- **Webhook URL:** `https://your-n8n-instance.example.com/webhook/hubspot-ticket-categorizer`
- **Data sources:** Supabase vector stores only (training conversations, documents, Slack)
- **External search:** Disabled (SerpAPI removed)
- **Webhook auth:** None (for now)

## Input (Webhook payload)

The workflow normalizes common HubSpot ticket payload shapes. It reads from:

- `body.properties.subject`
- `body.properties.content`
- `body.properties.hs_lastmessage`
- `body.properties.email`
- `body.properties.hs_ticket_category` (Ops label)
- `body.properties.subcategory` (Ops label)

### Recommended webhook properties

Send the minimal set needed for classification + auditing:

- `hs_object_id`
- `subject`
- `content`
- `hs_lastmessage`
- `hs_ticket_category`
- `subcategory`
- `hs_pipeline`
- `hs_pipeline_stage`
- `createdate`
- `email` (optional; only if needed for session tracking)

Enrollment guidance (HubSpot workflow):
- Only enroll tickets where `hs_ticket_category` is unknown and `subcategory` is unknown.
- Keep re‑enrollment off unless you want duplicate trial rows.

Example:

```json
{
  "properties": {
    "subject": "Lader offline",
    "content": "Min lader er offline i appen og jeg får ikke startet lading.",
    "hs_lastmessage": "Lader viser rødt lys",
    "email": "test@example.com",
    "hs_ticket_category": null,
    "subcategory": null
  }
}
```

## Output (Webhook response)

The workflow responds with JSON under `response`:

```json
{
  "ticket_id": "12345",
  "category": "Technical",
  "subcategory": "Charger offline",
  "confidence": 0.82,
  "rationale": "Short reason",
  "next_steps": ["Step 1", "Step 2"],
  "suggested_reply": "Short customer reply",
  "sources": ["training_conversations:<id>", "documents:<id>"]
}
```

## Allowed labels

**Categories:**
General, Administrative, Technical, Payment, Technical Support, RFID Support,
Order Support, Documentation, Unknown

**Subcategories:**
Other, App, Invoice, Ordering, Charger offline, Subscription and pricing,
Onboarding, Unstable charging, Hardware failure, User error, Termination,
Charging, Service, RFID, IT / Cloud error

## Notes

- The rules-based classifier provides a quick pre-tag to steer retrieval.
- The AI agent uses vector search to find similar tickets and relevant KB/Notion
  docs before final classification.
- The workflow now stores trial results in `volterra_kb.hubspot_ticket_categorization_trials`
  for live A/B evaluation (no HubSpot updates made).
- The workflow skips processing if Ops labels are already present in the webhook
  payload (`hs_ticket_category` or `subcategory`).

## Live Trial (Ops Comparison)

Goal: Capture the workflow’s predicted category/subcategory for new HubSpot
tickets, then compare against Ops labels once they are set (without modifying
HubSpot from n8n).

### Storage table

Create the table in Supabase (migration):

`supabase/migrations/20260116144500_add_hubspot_ticket_categorization_trials.sql`

Create the sync function (migration):

`supabase/migrations/20260116150500_add_sync_hubspot_trial_ops_labels.sql`

### Flow

1) HubSpot webhook → n8n workflow (`hubspot-ticket-categorizer`)  
2) n8n stores predictions into `hubspot_ticket_categorization_trials`  
3) Ops labels tickets in HubSpot  
4) HubSpot sync updates `training_conversations`  
5) Compare predictions vs Ops labels and update trial table (hourly)

### Ops comparison sync (n8n)

- **Workflow:** `HubSpot Ticket Categorizer - Ops Comparison Sync` (`6jivr1yvU1Y3mt5i`)
- **Schedule:** hourly
- **Schema note:** RPC call uses `Accept-Profile: volterra_kb` and `Content-Profile: volterra_kb`

### Trial runbook (quick re-evaluation)

Use this checklist when re-running the live trial assessment:

1) **Confirm webhook + enrollment rules**
   - HubSpot workflow is ON
   - Enrollment: `hs_ticket_category` is unknown AND `subcategory` is unknown
   - Re-enrollment OFF
2) **Confirm storage + sync**
   - Migrations applied:
     - `20260116144500_add_hubspot_ticket_categorization_trials.sql`
     - `20260116150500_add_sync_hubspot_trial_ops_labels.sql`
   - n8n sync workflow active: `6jivr1yvU1Y3mt5i`
3) **Let data collect**
   - Wait at least 24–72 hours of ticket volume
4) **Run health check**
   - Execute the SQL in “Live trial health check” and record:
     - total rows, rows last 24h, pending ops labels, match rates
5) **Snapshot results**
   - Export last 7/30 days for deeper analysis (optional)
   - Capture confusion pairs if needed for rule updates

### Live trial health check (SQL)

```sql
SELECT
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE received_at >= NOW() - INTERVAL '24 hours') AS rows_last_24h,
  COUNT(*) FILTER (WHERE ops_subcategory IS NULL) AS pending_ops_labels,
  COUNT(*) FILTER (WHERE ops_subcategory IS NOT NULL) AS labeled_rows,
  ROUND(AVG(CASE WHEN ops_subcategory IS NOT NULL THEN (match_category::int) END)::numeric, 3) AS category_match_rate,
  ROUND(AVG(CASE WHEN ops_subcategory IS NOT NULL THEN (match_subcategory::int) END)::numeric, 3) AS subcategory_match_rate
FROM volterra_kb.hubspot_ticket_categorization_trials;
```

### Comparison query (run in Supabase SQL editor)

```sql
UPDATE volterra_kb.hubspot_ticket_categorization_trials t
SET
  ops_category = c.category,
  ops_subcategory = c.subcategory,
  ops_set_at = NOW(),
  match_category = (c.category = t.predicted_category),
  match_subcategory = (c.subcategory = t.predicted_subcategory)
FROM volterra_kb.training_conversations c
WHERE c.hubspot_ticket_id = t.hubspot_ticket_id
  AND t.ops_subcategory IS NULL
  AND c.subcategory IS NOT NULL;
```

## Accuracy Review (2026-01-19)

Full evaluation across all labeled HubSpot conversations with embeddings.

### Dataset coverage

- Labeled conversations with subcategory: **11,803**
- Conversations with embeddings: **11,398**
- Successful predictions: **11,307**
- Errors: **91**
- Runtime: **1,742.1s**

### Deterministic baseline (majority-vote)

- Subcategory accuracy: **59.99%**
- Category accuracy: **90.58%**

### Artifacts

- `docs/auto-ticket-categorizer-performance-2026-01-19.md`
- `docs/auto-ticket-categorizer-errors-2026-01-19.csv`
- `docs/auto-ticket-categorizer-subcategory-accuracy-2026-01-19.csv`
- `docs/auto-ticket-categorizer-category-accuracy-2026-01-19.csv`
- `docs/auto-ticket-categorizer-subcategory-confusion-2026-01-19.csv`
- `docs/auto-ticket-categorizer-category-confusion-2026-01-19.csv`
- `docs/auto-ticket-categorizer-confusion-summary-2026-01-19.json`

## Accuracy Review (2026-01-17)

Stratified sample across top labels (historical snapshot).

### Sample + artifacts

- Sample size: **2,019** tickets (top 10 subcategories + top 6 categories, deduped)
- Embeddings: **2,019** / 2,019
- Errors: **0**
- Artifacts:
  - `docs/hubspot-categorizer-eval-2026-01-17.json`
  - `docs/hubspot-categorizer-eval-2026-01-17.csv`

### Category precision/recall (top categories)

- General: **P 0.86 / R 0.98 / F1 0.91** (support 972)
- Administrative: **P 0.80 / R 0.64 / F1 0.71** (support 337)
- Technical: **P 0.82 / R 0.83 / F1 0.82** (support 358)
- Payment: **P 0.86 / R 0.76 / F1 0.81** (support 239)
- Technical Support: **P 0.81 / R 0.37 / F1 0.51** (support 60)
- RFID Support: **P 0.97 / R 0.73 / F1 0.84** (support 52)

### Subcategory precision/recall (top subcategories)

- Other: **P 0.70 / R 0.55 / F1 0.62** (support 290)
- Invoice: **P 0.73 / R 0.74 / F1 0.74** (support 288)
- App: **P 0.51 / R 0.53 / F1 0.52** (support 182)
- Charger offline: **P 0.60 / R 0.77 / F1 0.67** (support 239)
- Subscription and pricing: **P 0.77 / R 0.53 / F1 0.63** (support 146)
- Ordering: **P 0.46 / R 0.63 / F1 0.53** (support 156)
- Onboarding: **P 0.48 / R 0.32 / F1 0.38** (support 152)
- Unstable charging: **P 0.54 / R 0.43 / F1 0.48** (support 142)
- Hardware failure: **P 0.64 / R 0.50 / F1 0.56** (support 149)
- User error: **P 0.66 / R 0.51 / F1 0.57** (support 144)

### Focus areas (next improvements)

- Lowest recall: **Technical Support**, **Onboarding**, **Unstable charging**, **Hardware failure**
- High-overlap clusters: **App vs Ordering vs Subscription**, **Charger offline vs Unstable charging**

## Ongoing accuracy improvements (continuous)

Use both legacy and new tickets to drive improvements:

- **Weekly evaluation:** re-run a stratified sample and store JSON/CSV under `docs/`
- **Targeted relabeling:** sample mismatches for low-recall labels and add correct examples
- **Current relabeling batch:** `docs/hubspot-categorizer-relabeling-batch-2026-01-17.csv`
- **Confusion relabeling batch:** `docs/hubspot-categorizer-relabeling-batch-confusions-2026-01-17.csv`
- **Legacy backfill:** label older tickets for thin categories (Technical Support, RFID)
- **Hard negatives:** add counter-examples for App/Ordering/Subscription and Charger offline/Unstable charging
- **Monitor Ops trial:** compare predictions vs Ops labels via the trial table weekly

## Accuracy Review (2026-01-16)

Evaluated against **all** labeled HubSpot conversations in Supabase.
Superseded by the 2026-01-19 full evaluation above.

### Dataset coverage

- Labeled conversations with subcategory: **11,366**
- Conversations with stored embeddings: **11,366** (used for vector evaluation)
- Category labels are inconsistent (many subcategories are still labeled `General`)

### Vector majority-vote baseline (current deterministic step)

Using `match_training_conversations` (top 5, threshold 0.5) with majority vote:

- Subcategory accuracy: **59.6%** (6,770 / 11,366)
- Category accuracy: **90.0%** (10,227 / 11,366)
- RPC errors: **86**
- Runtime: **1,700.7s**

### Lowest-accuracy subcategories

- Charging: **19.7%** (46 / 233)
- IT / Cloud error: **28.0%** (44 / 157)
- Onboarding: **42.1%** (256 / 608)
- Unstable charging: **46.3%** (214 / 462)
- User error: **50.3%** (193 / 384)
- Hardware failure: **52.7%** (226 / 429)

### Top confusion pairs

- Onboarding → Ordering (21.5% of Onboarding)
- Unstable charging → Charger offline (21.6% of Unstable charging)
- App → Ordering (9.0% of App)
- Invoice → Ordering (8.0% of Invoice)
- Ordering → App (7.4% of Ordering)

### Actions taken

- Expanded keyword hints (Issue Classifier) to better separate:
  - Onboarding vs Ordering
  - Charger offline vs Unstable charging vs Charging
  - Hardware failure vs Service vs User error
- Added disambiguation guidance + auto-match confidence handling to the AI Agent prompt.

### Conclusion

Keyword rules alone are not sufficient. The workflow relies on vector retrieval
plus the AI Agent. The Agent is instructed to:

1) Query `Supabase Training Conversations` with full ticket text  
2) Use top matches and majority vote for subcategory  
3) Derive category from retrieved matches (fallback to `General` if conflicting)  
4) Use the auto-match confidence + disambiguation hints when signals conflict

### Re-run evaluation

```bash
python3 -u scripts/evaluate-hubspot-categorizer.py --full --max-workers 4
```

Outputs:

- `/tmp/hubspot_eval_summary.json`
- `/tmp/hubspot_eval_confusion.json`

### Backfill missing embeddings

```bash
npm run training:embed
```
