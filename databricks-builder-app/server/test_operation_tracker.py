import time

from server.services.operation_tracker import claim_operation_poll, create_operation


def test_claim_operation_poll_enforces_minimum_interval():
    operation_id = create_operation("demo_tool", {"x": 1})

    operation, retry_after = claim_operation_poll(operation_id, min_interval_seconds=5.0)
    assert operation is not None
    assert retry_after == 0.0

    operation, retry_after = claim_operation_poll(operation_id, min_interval_seconds=5.0)
    assert operation is not None
    assert retry_after > 0
    assert retry_after <= 5.0


def test_claim_operation_poll_allows_retry_after_interval():
    operation_id = create_operation("demo_tool", {"x": 1})

    operation, retry_after = claim_operation_poll(operation_id, min_interval_seconds=0.05)
    assert operation is not None
    assert retry_after == 0.0

    time.sleep(0.06)

    operation, retry_after = claim_operation_poll(operation_id, min_interval_seconds=0.05)
    assert operation is not None
    assert retry_after == 0.0
