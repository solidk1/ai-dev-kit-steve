import base64
import json
from unittest import mock
from urllib.parse import quote

from databricks.sdk.errors.sdk import OperationFailed
from databricks_tools_core.compute import (
    execute_databricks_command,
    run_code_on_serverless,
    run_file_on_serverless,
)
from databricks_tools_core.compute.execution import ClusterSelectionResult, ExecutionResult
from databricks_tools_core.compute.serverless import (
    _get_run_output,
    _render_notebook_source,
)


def _notebook_model_html(model: dict) -> str:
    encoded_model = base64.b64encode(quote(json.dumps(model)).encode('utf-8')).decode('utf-8')
    return (
        '<!DOCTYPE html><html><head><title>serverless_test - Databricks</title></head>'
        f"<body><script>var __DATABRICKS_NOTEBOOK_MODEL = '{encoded_model}';</script></body></html>"
    )


def test_compute_package_exports_serverless_helpers():
    from databricks_tools_core.compute import ServerlessRunResult

    assert ServerlessRunResult is not None
    assert callable(run_code_on_serverless)
    assert callable(run_file_on_serverless)


class TestRunCodeOnServerlessValidation:
    def test_rejects_empty_code(self):
        result = run_code_on_serverless(code='')

        assert result.success is False
        assert result.state == 'INVALID_INPUT'
        assert 'empty' in result.error.lower()

    def test_rejects_unsupported_language(self):
        result = run_code_on_serverless(code='println(42)', language='scala')

        assert result.success is False
        assert result.state == 'INVALID_INPUT'
        assert 'python' in result.error.lower() or 'sql' in result.error.lower()


class TestRunFileOnServerless:
    @mock.patch('databricks_tools_core.compute.serverless.run_code_on_serverless')
    def test_reads_python_file_and_delegates(self, mock_run, tmp_path):
        mock_run.return_value = mock.Mock(success=True)
        script = tmp_path / 'test.py'
        script.write_text('print("hi")', encoding='utf-8')

        result = run_file_on_serverless(str(script))

        assert result.success is True
        call_kwargs = mock_run.call_args.kwargs
        assert call_kwargs['code'] == 'print("hi")'
        assert call_kwargs['language'] == 'python'

    def test_missing_file_returns_structured_error(self):
        result = run_file_on_serverless('/tmp/missing.py')

        assert result.success is False
        assert result.state == 'INVALID_INPUT'
        assert 'not found' in result.error.lower()


class TestRunCodeOnServerlessResultShape:
    @mock.patch('databricks_tools_core.compute.serverless.get_current_username', return_value='user@example.com')
    @mock.patch('databricks_tools_core.compute.serverless.get_workspace_client')
    def test_successful_run_returns_metadata(self, mock_get_client, _mock_user):
        mock_client = mock.Mock()
        mock_get_client.return_value = mock_client

        wait = mock.Mock()
        wait.run_id = 123
        mock_client.jobs.submit.return_value = wait

        run = mock.Mock()
        run.run_page_url = 'https://example/run/123'
        run.tasks = [mock.Mock(run_id=456)]
        run.state = mock.Mock(result_state=mock.Mock(value='SUCCESS'), state_message=None)
        wait.result.return_value = run

        run_details = mock.Mock(run_page_url='https://example/run/123')
        mock_client.jobs.get_run.return_value = run_details

        run_output = mock.Mock(
            notebook_output=mock.Mock(result='hello'),
            logs=None,
            error=None,
            error_trace=None,
        )
        mock_client.jobs.get_run_output.return_value = run_output

        result = run_code_on_serverless(code='dbutils.notebook.exit("hello")')

        assert result.success is True
        assert result.output == 'hello'
        assert result.run_id == 123
        assert result.run_url == 'https://example/run/123'
        assert result.state == 'SUCCESS'

    @mock.patch('databricks_tools_core.compute.serverless.get_workspace_client')
    def test_get_run_output_returns_plain_notebook_result(self, mock_get_client):
        mock_client = mock.Mock()
        mock_get_client.return_value = mock_client
        mock_client.jobs.get_run_output.return_value = mock.Mock(
            notebook_output=mock.Mock(result='hello from notebook'),
            logs=None,
            error=None,
            error_trace=None,
        )

        output = _get_run_output(123)

        assert output['output'] == 'hello from notebook'
        assert output['error'] is None

    @mock.patch('databricks_tools_core.compute.serverless.get_workspace_client')
    def test_get_run_output_falls_back_to_exported_notebook_view_as_clean_text(self, mock_get_client):
        mock_client = mock.Mock()
        mock_get_client.return_value = mock_client
        mock_client.jobs.get_run_output.return_value = mock.Mock(
            notebook_output=None,
            logs=None,
            error=None,
            error_trace=None,
        )
        mock_client.jobs.export_run.return_value = mock.Mock(
            views=[
                mock.Mock(
                    content=(
                        '<html><body>'
                        '<h1>Run Output</h1>'
                        '<p>Hello <b>world</b></p>'
                        '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'
                        '</body></html>'
                    )
                )
            ]
        )

        output = _get_run_output(123, 456)

        assert output['output'] == 'Run Output\n\nHello world\n\nA | B\n1 | 2'
        assert output['error'] is None

    @mock.patch('databricks_tools_core.compute.serverless.get_workspace_client')
    def test_get_run_output_reads_output_and_error_from_exported_notebook_model(self, mock_get_client):
        mock_client = mock.Mock()
        mock_get_client.return_value = mock_client
        mock_client.jobs.get_run_output.return_value = mock.Mock(
            notebook_output=mock.Mock(result='serverless_test - Databricks'),
            logs=None,
            error=None,
            error_trace=None,
        )
        mock_client.jobs.export_run.return_value = mock.Mock(
            views=[
                mock.Mock(
                    content=_notebook_model_html(
                        {
                            'name': 'serverless_test',
                            'commands': [
                                {
                                    'results': {
                                        'type': 'raw',
                                        'data': '1\n',
                                    },
                                    'errorSummary': 'Traceback: boom',
                                }
                            ],
                        }
                    )
                )
            ]
        )

        output = _get_run_output(123, 456)

        assert output['output'] == '1'
        assert output['error'] == 'Traceback: boom'

    @mock.patch('databricks_tools_core.compute.serverless.get_workspace_client')
    def test_get_run_output_reads_list_results_from_exported_notebook_model(self, mock_get_client):
        mock_client = mock.Mock()
        mock_get_client.return_value = mock_client
        mock_client.jobs.get_run_output.return_value = mock.Mock(
            notebook_output=None,
            logs=None,
            error=None,
            error_trace=None,
        )
        mock_client.jobs.export_run.return_value = mock.Mock(
            views=[
                mock.Mock(
                    content=_notebook_model_html(
                        {
                            'name': 'serverless_test',
                            'commands': [
                                {
                                    'results': {
                                        'type': 'listResults',
                                        'data': [
                                            {
                                                'type': 'ansi',
                                                'data': '3\n',
                                                'name': 'stdout',
                                            }
                                        ],
                                    }
                                }
                            ],
                        }
                    )
                )
            ]
        )

        output = _get_run_output(123, 456)

        assert output['output'] == '3'
        assert output['error'] is None

    def test_render_notebook_source_keeps_python_code_as_is(self):
        rendered = _render_notebook_source('print("hi")', 'python')

        assert rendered == '# Databricks notebook source\nprint("hi")'

    @mock.patch('databricks_tools_core.compute.serverless.get_current_username', return_value='user@example.com')
    @mock.patch('databricks_tools_core.compute.serverless.get_workspace_client')
    def test_failed_run_returns_exported_output_when_wait_raises_operation_failed(self, mock_get_client, _mock_user):
        mock_client = mock.Mock()
        mock_get_client.return_value = mock_client

        wait = mock.Mock()
        wait.run_id = 123
        wait.result.side_effect = OperationFailed('job failed')
        mock_client.jobs.submit.return_value = wait

        failed_run = mock.Mock()
        failed_run.run_page_url = 'https://example/run/123'
        failed_run.tasks = [mock.Mock(run_id=456)]
        failed_run.state = mock.Mock(result_state=mock.Mock(value='FAILED'), state_message='Task failed')
        mock_client.jobs.get_run.return_value = failed_run
        mock_client.jobs.get_run_output.return_value = mock.Mock(
            notebook_output=None,
            logs=None,
            error=None,
            error_trace=None,
        )
        mock_client.jobs.export_run.return_value = mock.Mock(
            views=[
                mock.Mock(
                    content=_notebook_model_html(
                        {
                            'name': 'serverless_test',
                            'commands': [
                                {
                                    'results': {
                                        'type': 'listResults',
                                        'data': [
                                            {
                                                'type': 'ansi',
                                                'data': '1\n',
                                                'name': 'stdout',
                                            }
                                        ],
                                    },
                                    'errorSummary': 'ValueError: boom',
                                }
                            ],
                        }
                    )
                )
            ]
        )

        result = run_code_on_serverless(code='print(1)\nraise ValueError("boom")')

        assert result.success is False
        assert result.output == '1'
        assert result.error == 'ValueError: boom'


class TestExecuteDatabricksCommandRouting:
    @mock.patch('databricks_tools_core.compute.execution._execute_on_context')
    @mock.patch('databricks_tools_core.compute.execution.create_context', return_value='ctx-123')
    @mock.patch(
        'databricks_tools_core.compute.execution._select_best_cluster',
        return_value=ClusterSelectionResult(cluster_id='abc-123', cluster_name='Shared Compute'),
    )
    def test_auto_selects_classic_cluster_and_surfaces_selected_cluster(
        self,
        _mock_select,
        _mock_create_context,
        mock_execute,
    ):
        mock_execute.return_value = ExecutionResult(
            success=True,
            output='ok',
            cluster_id='abc-123',
            cluster_name='Shared Compute',
            context_id='ctx-123',
            context_destroyed=False,
            execution_mode='cluster',
        )

        result = execute_databricks_command(code='print("hi")')

        assert result.success is True
        assert result.cluster_id == 'abc-123'
        assert result.cluster_name == 'Shared Compute'
        assert result.execution_mode == 'cluster'

    @mock.patch('databricks_tools_core.compute.execution.run_code_on_serverless')
    @mock.patch(
        'databricks_tools_core.compute.execution._select_best_cluster',
        return_value=ClusterSelectionResult(cluster_id=None),
    )
    def test_falls_back_to_serverless_when_no_classic_cluster(
        self,
        _mock_select,
        mock_serverless,
    ):
        mock_serverless.return_value = mock.Mock(
            success=True,
            output='serverless ok',
            error=None,
            run_id=321,
            run_url='https://example/runs/321',
            state='SUCCESS',
            message='Executed on serverless.',
        )

        result = execute_databricks_command(code='print("hi")', language='python')

        assert result.success is True
        assert result.output == 'serverless ok'
        assert result.cluster_id is None
        assert result.cluster_name == 'Serverless Jobs'
        assert result.execution_mode == 'serverless'
        assert result.run_id == 321
        assert result.run_url == 'https://example/runs/321'
