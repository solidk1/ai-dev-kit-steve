"""Tests for recovering from stale Claude CLI resume sessions."""

from server.services.agent import _is_missing_resume_session


def test_missing_resume_session_matches_requested_session():
    session_id = '602a12bf-0ba3-4acb-bc12-d070843e9a61'

    assert _is_missing_resume_session(
        [f'No conversation found with session ID: {session_id}'],
        session_id,
    )


def test_missing_resume_session_ignores_other_process_errors():
    assert not _is_missing_resume_session(
        ['Authentication failed', 'Command failed with exit code 1'],
        'expected-session',
    )
