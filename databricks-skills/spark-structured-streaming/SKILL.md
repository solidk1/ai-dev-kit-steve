---
name: spark-structured-streaming
description: Comprehensive guide to Spark Structured Streaming for production workloads. Use when building streaming pipelines, implementing real-time data processing, handling stateful operations, or optimizing streaming performance.
---

# Spark Structured Streaming

Production-ready streaming pipelines with Spark Structured Streaming. This skill provides navigation to detailed patterns and best practices.

## Quick Start

```python
from pyspark.sql.functions import col, from_json

# Basic Kafka to Delta streaming
df = (spark
    .readStream
    .format("kafka")
    .option("kafka.bootstrap.servers", "broker:9092")
    .option("subscribe", "topic")
    .load()
    .select(from_json(col("value").cast("string"), schema).alias("data"))
    .select("data.*")
)

df.writeStream \
    .format("delta") \
    .outputMode("append") \
    .option("checkpointLocation", "/Volumes/catalog/checkpoints/stream") \
    .trigger(processingTime="30 seconds") \
    .start("/delta/target_table")
```

## Core Patterns

| Pattern | Description | Reference |
|---------|-------------|-----------|
| **Kafka Streaming** | Kafka to Delta, Kafka to Kafka, Real-Time Mode | See [kafka-streaming.md](kafka-streaming.md) |
| **Stream Joins** | Stream-stream joins, stream-static joins | See [stream-stream-joins.md](stream-stream-joins.md), [stream-static-joins.md](stream-static-joins.md) |
| **Multi-Sink Writes** | Write to multiple tables, parallel merges | See [multi-sink-writes.md](multi-sink-writes.md) |
| **Merge Operations** | MERGE performance, parallel merges, optimizations | See [merge-operations.md](merge-operations.md) |

## Configuration

| Topic | Description | Reference |
|-------|-------------|-----------|
| **Checkpoints** | Checkpoint management and best practices | See [checkpoint-best-practices.md](checkpoint-best-practices.md) |
| **Watermarks** | Late data handling, watermark configuration | See [watermark-configuration.md](watermark-configuration.md) |
| **State Store** | State management, RocksDB configuration | See [state-store-management.md](state-store-management.md) |
| **Triggers** | Processing time, available now, real-time mode | See [trigger-tuning.md](trigger-tuning.md) |

## Performance

| Topic | Description | Reference |
|-------|-------------|-----------|
| **Partitioning** | Partitioning strategies, Liquid Clustering | See [partitioning-strategy.md](partitioning-strategy.md) |
| **Cost Tuning** | Scheduled streaming, cluster sizing | See [cost-tuning.md](cost-tuning.md) |
| **Deduplication** | Streaming deduplication at scale | See [streaming-deduplication-scale.md](streaming-deduplication-scale.md) |

## Operations

| Topic | Description | Reference |
|-------|-------------|-----------|
| **Monitoring** | Observability, metrics, Spark UI | See [monitoring-observability.md](monitoring-observability.md) |
| **Error Handling** | Recovery patterns, dead letter queues | See [error-handling-recovery.md](error-handling-recovery.md) |
| **Backfill** | Reprocessing historical data | See [backfill-patterns.md](backfill-patterns.md) |
| **Late Data** | Handling late-arriving events | See [late-data-handling.md](late-data-handling.md) |

## Ingestion

| Topic | Description | Reference |
|-------|-------------|-----------|
| **Auto Loader** | Schema evolution, file ingestion | See [auto-loader-schema-drift.md](auto-loader-schema-drift.md) |
| **DLT vs Jobs** | Choosing between DLT and Databricks Jobs | See [dlt-vs-jobs.md](dlt-vs-jobs.md) |

## Governance

| Topic | Description | Reference |
|-------|-------------|-----------|
| **Unity Catalog** | UC integration, volumes, access control | See [unity-catalog-streaming.md](unity-catalog-streaming.md) |

## Best Practices

| Topic | Description | Reference |
|-------|-------------|-----------|
| **Production Checklist** | Comprehensive best practices | See [streaming-best-practices.md](streaming-best-practices.md) |

## Production Checklist

- [ ] Checkpoint location is persistent (UC volumes, not DBFS)
- [ ] Unique checkpoint per stream
- [ ] Fixed-size cluster (no autoscaling for streaming)
- [ ] Monitoring configured (input rate, lag, batch duration)
- [ ] Exactly-once verified (txnVersion/txnAppId)
- [ ] Watermark configured for stateful operations
- [ ] Left joins for stream-static (not inner)
