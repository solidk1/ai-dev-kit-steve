---
name: sdp
description: "Create, configure, or update Databricks' Lakeflow Spark Declarative Pipelines (SDP), also known as LDP, or historically Delta Live Tables (DLT). User should guide on using SQL or Python syntax."
---

# Lakeflow Spark Declarative Pipelines (SDP)

## Official Documentation

- **[Lakeflow Spark Declarative Pipelines Overview](https://docs.databricks.com/aws/en/ldp/)** - Main documentation hub
- **[SQL Language Reference](https://docs.databricks.com/aws/en/ldp/developer/sql-dev)** - SQL syntax for streaming tables and materialized views
- **[Python Language Reference](https://docs.databricks.com/aws/en/ldp/developer/python-ref)** - `pyspark.pipelines` API
- **[Loading Data](https://docs.databricks.com/aws/en/ldp/load)** - Auto Loader, Kafka, Kinesis ingestion
- **[Change Data Capture (CDC)](https://docs.databricks.com/aws/en/ldp/cdc)** - AUTO CDC, SCD Type 1/2
- **[Developing Pipelines](https://docs.databricks.com/aws/en/ldp/develop)** - File structure, testing, validation
- **[Liquid Clustering](https://docs.databricks.com/aws/en/delta/clustering)** - Modern data layout optimization

---

## Development Workflow with MCP Tools

Use MCP tools to create, run, and iterate on SDP pipelines. The **primary tool is `create_or_update_pipeline`** which handles the entire lifecycle.

### Step 1: Write Pipeline Files Locally

Create `.sql` or `.py` files in a local folder:

```
my_pipeline/
├── bronze/
│   └── ingest_orders.sql
├── silver/
│   └── clean_orders.sql
└── gold/
    └── daily_summary.sql
```

**Example bronze layer** (`bronze/ingest_orders.sql`):
```sql
CREATE OR REFRESH STREAMING TABLE bronze_orders
CLUSTER BY (order_date)
AS
SELECT
  *,
  current_timestamp() AS _ingested_at,
  _metadata.file_path AS _source_file
FROM read_files(
  '/Volumes/catalog/schema/raw/orders/',
  format => 'json',
  schemaHints => 'order_id STRING, customer_id STRING, amount DECIMAL(10,2), order_date DATE'
);
```

### Step 2: Upload to Databricks Workspace

```python
# MCP Tool: upload_folder
upload_folder(
    local_folder="/path/to/my_pipeline",
    workspace_folder="/Workspace/Users/user@example.com/my_pipeline"
)
```

### Step 3: Create/Update and Run Pipeline

Use **`create_or_update_pipeline`** - the main entry point. It:
1. Searches for an existing pipeline with the same name (or uses `id` from `extra_settings`)
2. Creates a new pipeline or updates the existing one
3. Optionally starts a pipeline run
4. Optionally waits for completion and returns detailed results

```python
# MCP Tool: create_or_update_pipeline
result = create_or_update_pipeline(
    name="my_orders_pipeline",
    root_path="/Workspace/Users/user@example.com/my_pipeline",
    catalog="my_catalog",
    schema="my_schema",
    workspace_file_paths=[
        "/Workspace/Users/user@example.com/my_pipeline/bronze/ingest_orders.sql",
        "/Workspace/Users/user@example.com/my_pipeline/silver/clean_orders.sql",
        "/Workspace/Users/user@example.com/my_pipeline/gold/daily_summary.sql"
    ],
    start_run=True,           # Start immediately
    wait_for_completion=True, # Wait and return final status
    full_refresh=True,        # Full refresh all tables
    timeout=1800              # 30 minute timeout
)
```

**Result contains actionable information:**
```python
{
    "success": True,                    # Did the operation succeed?
    "pipeline_id": "abc-123",           # Pipeline ID for follow-up operations
    "pipeline_name": "my_orders_pipeline",
    "created": True,                    # True if new, False if updated
    "state": "COMPLETED",               # COMPLETED, FAILED, TIMEOUT, etc.
    "catalog": "my_catalog",            # Target catalog
    "schema": "my_schema",              # Target schema
    "duration_seconds": 45.2,           # Time taken
    "message": "Pipeline created and completed successfully in 45.2s. Tables written to my_catalog.my_schema",
    "error_message": None,              # Error summary if failed
    "errors": []                        # Detailed error list if failed
}
```

### Step 4: Handle Results

**On Success:**
```python
if result["success"]:
    # Verify output tables
    stats = get_table_details(
        catalog="my_catalog",
        schema="my_schema",
        table_names=["bronze_orders", "silver_orders", "gold_daily_summary"]
    )
```

**On Failure:**
```python
if not result["success"]:
    # Message includes suggested next steps
    print(result["message"])
    # "Pipeline created but run failed. State: FAILED. Error: Column 'amount' not found.
    #  Use get_pipeline_events(pipeline_id='abc-123') for full details."

    # Get detailed errors
    events = get_pipeline_events(pipeline_id=result["pipeline_id"], max_results=50)
```

### Step 5: Iterate Until Working

1. Review errors from result or `get_pipeline_events`
2. Fix issues in local files
3. Re-upload with `upload_folder`
4. Run `create_or_update_pipeline` again (it will update, not recreate)
5. Repeat until `result["success"] == True`

---

## Quick Reference: MCP Tools

### Primary Tool

| Tool | Description |
|------|-------------|
| **`create_or_update_pipeline`** | **Main entry point.** Creates or updates pipeline, optionally runs and waits. Returns detailed status with `success`, `state`, `errors`, and actionable `message`. |

### Pipeline Management

| Tool | Description |
|------|-------------|
| `find_pipeline_by_name` | Find existing pipeline by name, returns pipeline_id |
| `get_pipeline` | Get pipeline configuration and current state |
| `start_update` | Start pipeline run (`validate_only=True` for dry run) |
| `get_update` | Poll update status (QUEUED, RUNNING, COMPLETED, FAILED) |
| `stop_pipeline` | Stop a running pipeline |
| `get_pipeline_events` | Get error messages for debugging failed runs |
| `delete_pipeline` | Delete a pipeline |

### Supporting Tools

| Tool | Description |
|------|-------------|
| `upload_folder` | Upload local folder to workspace (parallel) |
| `get_table_details` | Verify output tables have expected schema and row counts |
| `execute_sql` | Run ad-hoc SQL to inspect data |

---

## Core SQL Patterns

All examples use Unity Catalog: `catalog.schema.table`

### Bronze Layer (Ingestion)

```sql
CREATE OR REFRESH STREAMING TABLE bronze_orders
CLUSTER BY (order_date)
AS
SELECT
  *,
  current_timestamp() AS _ingested_at,
  _metadata.file_path AS _source_file
FROM read_files(
  '/Volumes/catalog/schema/raw/orders/',
  format => 'json',
  schemaHints => 'order_id STRING, amount DECIMAL(10,2), order_date DATE'
);
```

### Silver Layer (Cleansing with Expectations)

```sql
CREATE OR REFRESH STREAMING TABLE silver_orders (
  CONSTRAINT valid_order_id EXPECT (order_id IS NOT NULL) ON VIOLATION DROP ROW,
  CONSTRAINT valid_amount EXPECT (amount > 0) ON VIOLATION DROP ROW
)
CLUSTER BY (customer_id, order_date)
AS
SELECT
  order_id,
  customer_id,
  CAST(order_date AS DATE) AS order_date,
  CAST(amount AS DECIMAL(10,2)) AS amount
FROM STREAM bronze_orders;
```

### Gold Layer (Aggregation)

```sql
CREATE OR REFRESH MATERIALIZED VIEW gold_daily_sales
CLUSTER BY (order_day)
AS
SELECT
  date_trunc('day', order_date) AS order_day,
  COUNT(DISTINCT order_id) AS order_count,
  SUM(amount) AS daily_sales
FROM silver_orders
GROUP BY date_trunc('day', order_date);
```

### SCD Type 2 (History Tracking)

```sql
CREATE OR REFRESH STREAMING TABLE customers_history;

CREATE FLOW customers_cdc_flow AS
AUTO CDC INTO customers_history
FROM STREAM customers_cdc_source
KEYS (customer_id)
SEQUENCE BY event_timestamp
STORED AS SCD TYPE 2
TRACK HISTORY ON *;
```

---

## Reference Documentation (Local)

Load these for detailed patterns:

- **[ingestion-patterns.md](ingestion-patterns.md)** - Auto Loader, Kafka, Event Hub, file formats
- **[streaming-patterns.md](streaming-patterns.md)** - Deduplication, windowing, stateful operations
- **[scd-query-patterns.md](scd-query-patterns.md)** - Querying SCD2 history tables
- **[python-api-versions.md](python-api-versions.md)** - Modern `dp` API vs legacy `dlt` API
- **[performance-tuning.md](performance-tuning.md)** - Liquid Clustering, optimization
- **[dlt-migration-guide.md](dlt-migration-guide.md)** - Migrating from DLT to SDP

---

## Best Practices (2025)

### Language Selection

Ask user if not specified:
- **SQL**: Simple transformations, SQL teams, declarative style
- **Python**: Complex logic, UDFs, Python teams (use modern `dp` API)

### Modern Defaults

- **Use `CLUSTER BY`** (Liquid Clustering), not `PARTITION BY`
- **Use raw `.sql`/`.py` files**, not notebooks
- **All pipelines are serverless** and use Unity Catalog
- **Use `read_files()`** for cloud storage ingestion

### File Structure

```
pipeline_name/
├── bronze/     # Raw ingestion
├── silver/     # Cleansed, validated
└── gold/       # Aggregated business layer
```

---

## Common Issues

| Issue | Solution |
|-------|----------|
| **Empty output tables** | Use `get_table_details` to verify, check upstream sources |
| **Pipeline stuck INITIALIZING** | Normal for serverless, wait a few minutes |
| **"Column not found"** | Check `schemaHints` match actual data |
| **Streaming reads fail** | Use `FROM STREAM(table)` for streaming sources |
| **Timeout during run** | Increase `timeout`, or use `wait_for_completion=False` and poll with `get_update` |
| **MV doesn't refresh** | Enable row tracking on source tables |
| **SCD2 schema errors** | Let SDP infer START_AT/END_AT columns |

**For detailed errors**, the `result["message"]` from `create_or_update_pipeline` includes suggested next steps. Use `get_pipeline_events(pipeline_id=...)` for full stack traces.

---

## Advanced Pipeline Configuration (`extra_settings`)

By default, pipelines are created with serverless compute and Unity Catalog. Use the `extra_settings` parameter to customize pipeline behavior for advanced use cases.

### When to Use `extra_settings`

- **Non-serverless compute**: Use dedicated clusters with instance pools
- **Development mode**: Faster iteration with relaxed validation
- **Continuous pipelines**: Real-time streaming instead of triggered runs
- **Custom compute**: Photon, specific editions, cluster configurations
- **Event logging**: Custom event log table location
- **Pipeline metadata**: Tags, configuration variables

### `extra_settings` Parameter Reference

#### Top-Level Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `serverless` | bool | `true` | Use serverless compute. Set `false` for dedicated clusters. |
| `continuous` | bool | `false` | `true` = always running (real-time), `false` = triggered runs |
| `development` | bool | `false` | Development mode: faster startup, relaxed validation, no retries |
| `photon` | bool | `false` | Enable Photon vectorized query engine |
| `edition` | str | `"CORE"` | `"CORE"`, `"PRO"`, or `"ADVANCED"`. Advanced required for CDC. |
| `channel` | str | `"CURRENT"` | `"CURRENT"` (stable) or `"PREVIEW"` (latest features) |
| `clusters` | list | `[]` | Cluster configs (required if `serverless=false`) |
| `configuration` | dict | `{}` | Spark config key-value pairs (all values must be strings) |
| `tags` | dict | `{}` | Pipeline metadata tags (max 25 tags) |
| `event_log` | dict | auto | Custom event log table location |
| `notifications` | list | `[]` | Email/webhook alerts on pipeline events |
| `id` | str | - | Force update of specific pipeline ID |
| `allow_duplicate_names` | bool | `false` | Allow multiple pipelines with same name |
| `budget_policy_id` | str | - | Budget policy ID for cost tracking |
| `storage` | str | - | DBFS root directory for checkpoints/tables (legacy, use Unity Catalog instead) |
| `target` | str | - | **Deprecated**: Use `schema` parameter instead |
| `dry_run` | bool | `false` | Validate pipeline without creating (create only) |
| `run_as` | dict | - | Run pipeline as specific user/service principal |
| `restart_window` | dict | - | Maintenance window for continuous pipeline restarts |
| `filters` | dict | - | Include/exclude specific paths from pipeline |
| `trigger` | dict | - | **Deprecated**: Use `continuous` instead |
| `deployment` | dict | - | Deployment method (BUNDLE or DEFAULT) |
| `environment` | dict | - | Python pip dependencies for serverless |
| `gateway_definition` | dict | - | CDC gateway pipeline configuration |
| `ingestion_definition` | dict | - | Managed ingestion settings (Salesforce, Workday, etc.) |
| `usage_policy_id` | str | - | Usage policy ID |

#### `clusters` Array - Cluster Configuration

Each cluster object supports these fields:

| Field | Type | Description |
|-------|------|-------------|
| `label` | str | **Required**. `"default"` for main cluster, `"maintenance"` for maintenance tasks |
| `num_workers` | int | Fixed number of workers (use this OR autoscale, not both) |
| `autoscale` | dict | `{"min_workers": 1, "max_workers": 4, "mode": "ENHANCED"}` |
| `node_type_id` | str | Instance type, e.g., `"i3.xlarge"`, `"Standard_DS3_v2"` |
| `driver_node_type_id` | str | Driver instance type (defaults to node_type_id) |
| `instance_pool_id` | str | Use instances from this pool (faster startup) |
| `driver_instance_pool_id` | str | Pool for driver node |
| `spark_conf` | dict | Spark configuration for this cluster |
| `spark_env_vars` | dict | Environment variables |
| `custom_tags` | dict | Tags applied to cloud resources |
| `init_scripts` | list | Init script locations |
| `aws_attributes` | dict | AWS-specific: `{"availability": "SPOT", "zone_id": "us-west-2a"}` |
| `azure_attributes` | dict | Azure-specific: `{"availability": "SPOT_AZURE"}` |
| `gcp_attributes` | dict | GCP-specific settings |

**Autoscale modes**: `"LEGACY"` or `"ENHANCED"` (recommended, optimizes for DLT workloads)

#### `event_log` Object - Custom Event Log Location

| Field | Type | Description |
|-------|------|-------------|
| `catalog` | str | Unity Catalog name for event log table |
| `schema` | str | Schema name for event log table |
| `name` | str | Table name for event logs |

#### `notifications` Array - Alert Configuration

Each notification object:

| Field | Type | Description |
|-------|------|-------------|
| `email_recipients` | list | List of email addresses |
| `alerts` | list | Events to alert on: `"on-update-success"`, `"on-update-failure"`, `"on-update-fatal-failure"`, `"on-flow-failure"` |

#### `configuration` Dict - Spark/Pipeline Config

Common configuration keys (all values must be strings):

| Key | Description |
|-----|-------------|
| `spark.sql.shuffle.partitions` | Number of shuffle partitions (`"auto"` recommended) |
| `pipelines.numRetries` | Number of retries on transient failures |
| `pipelines.trigger.interval` | Trigger interval for continuous pipelines, e.g., `"1 hour"` |
| `spark.databricks.delta.preview.enabled` | Enable Delta preview features (`"true"`) |

#### `run_as` Object - Pipeline Execution Identity

Specify which user or service principal runs the pipeline:

| Field | Type | Description |
|-------|------|-------------|
| `user_name` | str | Email of workspace user (can only set to your own email) |
| `service_principal_name` | str | Application ID of service principal (requires servicePrincipal/user role) |

**Note**: Only one of `user_name` or `service_principal_name` can be set.

#### `restart_window` Object - Continuous Pipeline Restart Schedule

For continuous pipelines, define when restarts can occur:

| Field | Type | Description |
|-------|------|-------------|
| `start_hour` | int | **Required**. Hour (0-23) when 5-hour restart window begins |
| `days_of_week` | list | Days allowed: `"MONDAY"`, `"TUESDAY"`, etc. (default: all days) |
| `time_zone_id` | str | Timezone, e.g., `"America/Los_Angeles"` (default: UTC) |

#### `filters` Object - Path Filtering

Include or exclude specific paths from the pipeline:

| Field | Type | Description |
|-------|------|-------------|
| `include` | list | List of paths to include |
| `exclude` | list | List of paths to exclude |

#### `environment` Object - Python Dependencies (Serverless)

Install pip dependencies for serverless pipelines:

| Field | Type | Description |
|-------|------|-------------|
| `dependencies` | list | List of pip requirements (e.g., `["pandas==2.0.0", "requests"]`) |

#### `deployment` Object - Deployment Method

| Field | Type | Description |
|-------|------|-------------|
| `kind` | str | `"BUNDLE"` (Databricks Asset Bundles) or `"DEFAULT"` |
| `metadata_file_path` | str | Path to deployment metadata file |

#### Edition Comparison

| Feature | CORE | PRO | ADVANCED |
|---------|------|-----|----------|
| Streaming tables | Yes | Yes | Yes |
| Materialized views | Yes | Yes | Yes |
| Expectations (data quality) | Yes | Yes | Yes |
| Change Data Capture (CDC) | No | No | Yes |
| SCD Type 1/2 | No | No | Yes |

### Example: Development Mode Pipeline

```python
result = create_or_update_pipeline(
    name="my_dev_pipeline",
    root_path="/Workspace/Users/user@example.com/my_pipeline",
    catalog="dev_catalog",
    schema="dev_schema",
    workspace_file_paths=[...],
    start_run=True,
    extra_settings={
        "development": True,  # Faster iteration
        "tags": {"environment": "development", "owner": "data-team"}
    }
)
```

### Example: Non-Serverless with Dedicated Cluster

```python
result = create_or_update_pipeline(
    name="prod_pipeline",
    root_path="/Workspace/Users/user@example.com/my_pipeline",
    catalog="prod_catalog",
    schema="prod_schema",
    workspace_file_paths=[...],
    extra_settings={
        "serverless": False,
        "clusters": [{
            "label": "default",
            "num_workers": 4,
            "node_type_id": "i3.xlarge",
            "custom_tags": {"cost_center": "analytics"}
        }],
        "photon": True,
        "edition": "ADVANCED"
    }
)
```

### Example: Continuous Streaming Pipeline

```python
result = create_or_update_pipeline(
    name="realtime_pipeline",
    root_path="/Workspace/Users/user@example.com/my_pipeline",
    catalog="streaming_catalog",
    schema="realtime",
    workspace_file_paths=[...],
    extra_settings={
        "continuous": True,  # Always running, processes data as it arrives
        "configuration": {
            "spark.sql.shuffle.partitions": "auto"
        }
    }
)
```

### Example: Using Instance Pool

```python
result = create_or_update_pipeline(
    name="pool_pipeline",
    root_path="/Workspace/Users/user@example.com/my_pipeline",
    catalog="my_catalog",
    schema="my_schema",
    workspace_file_paths=[...],
    extra_settings={
        "serverless": False,
        "clusters": [{
            "label": "default",
            "instance_pool_id": "0727-104344-hauls13-pool-xyz",
            "num_workers": 2,
            "custom_tags": {"project": "analytics"}
        }]
    }
)
```

### Example: Custom Event Log Location

```python
result = create_or_update_pipeline(
    name="audited_pipeline",
    root_path="/Workspace/Users/user@example.com/my_pipeline",
    catalog="my_catalog",
    schema="my_schema",
    workspace_file_paths=[...],
    extra_settings={
        "event_log": {
            "catalog": "audit_catalog",
            "schema": "pipeline_logs",
            "name": "my_pipeline_events"
        }
    }
)
```

### Example: Pipeline with Email Notifications

```python
result = create_or_update_pipeline(
    name="monitored_pipeline",
    root_path="/Workspace/Users/user@example.com/my_pipeline",
    catalog="my_catalog",
    schema="my_schema",
    workspace_file_paths=[...],
    extra_settings={
        "notifications": [{
            "email_recipients": ["team@example.com", "oncall@example.com"],
            "alerts": ["on-update-failure", "on-update-fatal-failure", "on-flow-failure"]
        }]
    }
)
```

### Example: Production Pipeline with Autoscaling

```python
result = create_or_update_pipeline(
    name="prod_autoscale_pipeline",
    root_path="/Workspace/Users/user@example.com/my_pipeline",
    catalog="prod_catalog",
    schema="prod_schema",
    workspace_file_paths=[...],
    extra_settings={
        "serverless": False,
        "development": False,
        "photon": True,
        "edition": "ADVANCED",
        "clusters": [{
            "label": "default",
            "autoscale": {
                "min_workers": 2,
                "max_workers": 8,
                "mode": "ENHANCED"
            },
            "node_type_id": "i3.xlarge",
            "spark_conf": {
                "spark.sql.adaptive.enabled": "true"
            },
            "custom_tags": {"environment": "production"}
        }],
        "notifications": [{
            "email_recipients": ["data-team@example.com"],
            "alerts": ["on-update-failure"]
        }]
    }
)
```

### Example: Run as Service Principal

```python
result = create_or_update_pipeline(
    name="scheduled_pipeline",
    root_path="/Workspace/Users/user@example.com/my_pipeline",
    catalog="my_catalog",
    schema="my_schema",
    workspace_file_paths=[...],
    extra_settings={
        "run_as": {
            "service_principal_name": "00000000-0000-0000-0000-000000000000"
        }
    }
)
```

### Example: Continuous Pipeline with Restart Window

```python
result = create_or_update_pipeline(
    name="realtime_pipeline",
    root_path="/Workspace/Users/user@example.com/my_pipeline",
    catalog="my_catalog",
    schema="my_schema",
    workspace_file_paths=[...],
    extra_settings={
        "continuous": True,
        "restart_window": {
            "start_hour": 2,  # 2 AM
            "days_of_week": ["SATURDAY", "SUNDAY"],
            "time_zone_id": "America/Los_Angeles"
        }
    }
)
```

### Example: Serverless with Python Dependencies

```python
result = create_or_update_pipeline(
    name="ml_pipeline",
    root_path="/Workspace/Users/user@example.com/my_pipeline",
    catalog="my_catalog",
    schema="my_schema",
    workspace_file_paths=[...],
    extra_settings={
        "serverless": True,
        "environment": {
            "dependencies": [
                "scikit-learn==1.3.0",
                "pandas>=2.0.0",
                "requests"
            ]
        }
    }
)
```

### Example: Update Existing Pipeline by ID

If you have a pipeline ID from the Databricks UI, you can force an update:

```python
result = create_or_update_pipeline(
    name="my_pipeline",
    root_path="/Workspace/Users/user@example.com/my_pipeline",
    catalog="my_catalog",
    schema="my_schema",
    workspace_file_paths=[...],
    extra_settings={
        "id": "554f4497-4807-4182-bff0-ffac4bb4f0ce"  # Forces update of this pipeline
    }
)
```

### Full JSON Export from Databricks UI

You can copy pipeline settings from the Databricks UI (Pipeline Settings > JSON) and pass them directly. Invalid fields like `pipeline_type` are automatically filtered:

```python
# JSON from Databricks UI
ui_settings = {
    "id": "554f4497-4807-4182-bff0-ffac4bb4f0ce",
    "pipeline_type": "WORKSPACE",  # Automatically filtered out
    "continuous": False,
    "development": True,
    "photon": False,
    "edition": "ADVANCED",
    "channel": "CURRENT",
    "clusters": [{
        "label": "default",
        "num_workers": 1,
        "instance_pool_id": "0727-104344-pool-xyz"
    }],
    "configuration": {
        "catalog": "main",
        "schema": "my_schema"
    }
}

result = create_or_update_pipeline(
    name="my_pipeline",
    root_path="/Workspace/...",
    catalog="main",
    schema="my_schema",
    workspace_file_paths=[...],
    extra_settings=ui_settings  # Pass the whole dict
)
```

**Note**: Explicit parameters (`name`, `root_path`, `catalog`, `schema`, `workspace_file_paths`) always take precedence over values in `extra_settings`.

---

## Platform Constraints

| Constraint | Details |
|------------|---------|
| **Unity Catalog** | Required for all serverless pipelines |
| **CDC Features** | Requires serverless or Pro/Advanced edition |
| **Schema Evolution** | Streaming tables require full refresh for incompatible changes |
| **SQL Limitations** | PIVOT clause unsupported |
| **Sinks** | Python only, streaming only, append flows only |
