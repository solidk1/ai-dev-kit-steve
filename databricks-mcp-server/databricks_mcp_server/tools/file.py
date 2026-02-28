"""File tools - Upload files and folders to Databricks workspace."""

from typing import Dict, Any

from databricks_tools_core.file import (
    delete_workspace_path as _delete_workspace_path,
    list_workspace_files as _list_workspace_files,
    read_workspace_file as _read_workspace_file,
    upload_folder as _upload_folder,
    upload_file as _upload_file,
    write_workspace_file as _write_workspace_file,
)

from ..server import mcp


@mcp.tool
def read_workspace_file(workspace_path: str) -> Dict[str, Any]:
    """
    Read a Databricks workspace file as UTF-8 text.

    Args:
        workspace_path: Workspace file path
            (e.g., "/Workspace/Users/user@example.com/script.py").

    Returns:
        Dictionary with workspace_path and content.
    """
    return _read_workspace_file(workspace_path=workspace_path)


@mcp.tool
def write_workspace_file(
    workspace_path: str,
    content: str,
    overwrite: bool = True,
) -> Dict[str, Any]:
    """
    Write text content to a Databricks workspace file.

    Args:
        workspace_path: Destination workspace file path.
        content: UTF-8 text content to write.
        overwrite: Whether to overwrite existing files.

    Returns:
        Dictionary with write status and bytes_written.
    """
    return _write_workspace_file(
        workspace_path=workspace_path,
        content=content,
        overwrite=overwrite,
    )


@mcp.tool
def delete_workspace_path(workspace_path: str, recursive: bool = False) -> Dict[str, Any]:
    """
    Delete a file or directory in Databricks workspace.

    Args:
        workspace_path: Workspace file/folder path to delete.
        recursive: Required when deleting non-empty directories.

    Returns:
        Dictionary with delete status.
    """
    return _delete_workspace_path(
        workspace_path=workspace_path,
        recursive=recursive,
    )


@mcp.tool
def list_workspace_files(
    workspace_path: str,
    recursive: bool = False,
    max_results: int = 500,
) -> Dict[str, Any]:
    """
    List files and folders in Databricks workspace paths.

    Args:
        workspace_path: Workspace path to list
            (e.g., "/Workspace/Users/user@example.com", "/Users/user@example.com").
        recursive: If True, recursively lists subdirectories.
        max_results: Maximum number of items to return (default: 500, max: 1000).

    Returns:
        Dictionary with:
        - workspace_path: Requested workspace path
        - returned_count: Number of returned items
        - truncated: Whether results were truncated at max_results
        - files: Array of file/folder entries
    """
    return _list_workspace_files(
        workspace_path=workspace_path,
        recursive=recursive,
        max_results=max_results,
    )


@mcp.tool
def upload_folder(
    local_folder: str,
    workspace_folder: str,
    max_workers: int = 10,
    overwrite: bool = True,
) -> Dict[str, Any]:
    """
    Upload an entire local folder to Databricks workspace.

    Uses parallel uploads with ThreadPoolExecutor for performance.
    Automatically handles all file types.

    Args:
        local_folder: Path to local folder to upload
        workspace_folder: Target path in Databricks workspace
            (e.g., "/Workspace/Users/user@example.com/my-project")
        max_workers: Maximum parallel upload threads (default: 10)
        overwrite: Whether to overwrite existing files (default: True)

    Returns:
        Dictionary with upload statistics:
        - local_folder: Source folder path
        - remote_folder: Target workspace path
        - total_files: Number of files found
        - successful: Number of successful uploads
        - failed: Number of failed uploads
        - success: True if all uploads succeeded
    """
    result = _upload_folder(
        local_folder=local_folder,
        workspace_folder=workspace_folder,
        max_workers=max_workers,
        overwrite=overwrite,
    )
    return {
        "local_folder": result.local_folder,
        "remote_folder": result.remote_folder,
        "total_files": result.total_files,
        "successful": result.successful,
        "failed": result.failed,
        "success": result.success,
        "failed_uploads": [{"local_path": r.local_path, "error": r.error} for r in result.get_failed_uploads()]
        if result.failed > 0
        else [],
    }


@mcp.tool
def upload_file(
    local_path: str,
    workspace_path: str,
    overwrite: bool = True,
) -> Dict[str, Any]:
    """
    Upload a single file to Databricks workspace.

    Args:
        local_path: Path to local file
        workspace_path: Target path in Databricks workspace
        overwrite: Whether to overwrite existing file (default: True)

    Returns:
        Dictionary with:
        - local_path: Source file path
        - remote_path: Target workspace path
        - success: True if upload succeeded
        - error: Error message if failed
    """
    result = _upload_file(
        local_path=local_path,
        workspace_path=workspace_path,
        overwrite=overwrite,
    )
    return {
        "local_path": result.local_path,
        "remote_path": result.remote_path,
        "success": result.success,
        "error": result.error,
    }
