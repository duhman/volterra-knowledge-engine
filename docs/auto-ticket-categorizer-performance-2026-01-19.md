# Auto Ticket Categorizer Performance Report (2026-01-19 UTC)

Data source: n8n executions (API v1) for the two workflows linked in the request. All timestamps are UTC.

## Categorizer Accuracy (full)

- Evaluation run: 2026-01-19
- Labeled total: 11,803
- Items with embeddings: 11398
- Successful predictions: 11307
- Subcategory accuracy: 59.99%
- Category accuracy: 90.58%
- Evaluation errors: 91
- Runtime: 1742.1s

## Subcategory Accuracy (all, n=15)

- Source: auto-ticket-categorizer-subcategory-accuracy-2026-01-19.csv
| Subcategory | Total | Accuracy |
| --- | ---: | ---: |
| RFID | 227 | 71.37% |
| Charger offline | 1106 | 70.80% |
| Other | 2135 | 69.56% |
| Ordering | 1196 | 68.06% |
| Termination | 357 | 66.11% |
| Invoice | 1374 | 65.72% |
| App | 1538 | 57.28% |
| Service | 238 | 57.14% |
| Subscription and pricing | 748 | 53.07% |
| Hardware failure | 445 | 50.79% |
| User error | 397 | 49.37% |
| Unstable charging | 483 | 44.51% |
| Onboarding | 653 | 39.36% |
| IT / Cloud error | 166 | 26.51% |
| Charging | 244 | 19.67% |

## Confusion Matrices (CSV)

- Subcategory confusion: auto-ticket-categorizer-subcategory-confusion-2026-01-19.csv
- Category confusion: auto-ticket-categorizer-category-confusion-2026-01-19.csv
- Category accuracy: auto-ticket-categorizer-category-accuracy-2026-01-19.csv

## AI agent support - HubSpot ticket categorizer (YOUR_WORKFLOW_ID)

- Status: active
- Time window: 2026-01-15 23:32:54 to 2026-01-19 22:44:03
- Executions: 450
- Success: 437 (97.11%)
- Errors: 13 (2.89%)
- Duration (sec): p50 8.068, p95 12.586, avg 8.071, min 0.033, max 21.067
- Mode distribution: webhook 450

Error details (node + message per failed execution):
- 2026-01-19 18:27:29 | execution 722 | OpenAI Chat Model (@n8n/n8n-nodes-langchain.lmChatOpenAi) | NodeApiError: Connection error.
- 2026-01-16 16:54:59 | execution 238 | Extract Message | SyntaxError: Invalid or unexpected token 
- 2026-01-16 16:54:18 | execution 237 | Extract Message | SyntaxError: Invalid or unexpected token 
- 2026-01-16 12:16:43 | execution 219 | Match Training Conversations (RPC) | AxiosError: Request failed with status code 500 
- 2026-01-16 12:15:42 | execution 218 | Generate Embedding (MCP) | Embedding parse failed [line 24]
- 2026-01-16 12:14:46 | execution 217 | Generate Embedding (MCP) | ReferenceError: fetch is not defined [line 2]
- 2026-01-16 12:13:37 | execution 216 | Parse Embedding | Embedding parse failed [line 11]
- 2026-01-16 12:12:44 | execution 215 | Generate Embedding (MCP) (n8n-nodes-base.httpRequest) | NodeApiError: Bad request - please check your parameters (http 400)
- 2026-01-16 12:12:08 | execution 214 | Generate Embedding (MCP) | ExpressionError: access to env vars denied
- 2026-01-16 12:11:33 | execution 213 | Generate Embedding (MCP) | ExpressionError: access to env vars denied
- 2026-01-16 12:10:00 | execution 212 | Supabase Training Conversations Deterministic (@n8n/n8n-nodes-langchain.vectorStoreSupabase) | NodeOperationError: Only the "load", "update", "insert", and "retrieve-as-tool" operation modes are supported with execute
- 2026-01-16 12:08:25 | execution 211 | Deterministic Match | Embeddings not found on item [line 5]
- 2026-01-15 23:32:54 | execution 206 | Simple Memory (@n8n/n8n-nodes-langchain.memoryBufferWindow) | NodeOperationError: Error in sub-node Simple Memory

Last 7 days (daily execution counts):
- 2026-01-13: 0
- 2026-01-14: 0
- 2026-01-15: 4
- 2026-01-16: 49
- 2026-01-17: 78
- 2026-01-18: 82
- 2026-01-19: 237

## HubSpot Ticket Categorizer - Ops Comparison Sync (6jivr1yvU1Y3mt5i)

- Status: active
- Time window: 2026-01-16 17:00:00 to 2026-01-19 23:00:00
- Executions: 79
- Success: 78 (98.73%)
- Errors: 1 (1.27%)
- Duration (sec): p50 0.340, p95 0.534, avg 0.362, min 0.116, max 0.699
- Mode distribution: trigger 79

Error details (node + message per failed execution):
- 2026-01-16 17:00:00 | execution 241 | Sync Ops Labels | AxiosError: Request failed with status code 404 

Last 7 days (daily execution counts):
- 2026-01-13: 0
- 2026-01-14: 0
- 2026-01-15: 0
- 2026-01-16: 7
- 2026-01-17: 24
- 2026-01-18: 24
- 2026-01-19: 24

## Error details CSV

- File: auto-ticket-categorizer-errors-2026-01-19.csv
