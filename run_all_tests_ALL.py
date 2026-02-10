#!/usr/bin/env python3
"""MCP Local LLM unified test runner with benchmarking support.

This script runs the full test suite across multiple backends (local, copilot-cli, opencode-cli)
and generates comparison reports for debugging and performance analysis.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterable, Optional

# Default timeout values (in seconds)
CLI_VERSION_TIMEOUT = 30  # Timeout for cli --version checks
BUILD_TIMEOUT = 300  # Timeout for npm run build (5 minutes) 
TEST_GROUP_TIMEOUT = 600  # Timeout for each test group (10 minutes) 
OPENCODE_REAL_E2E_TIMEOUT = 1200  # e2e suite can exceed 10m with opencode-cli
OPENCODE_AGENT_SCENARIOS_TIMEOUT = 900  # opencode-cli can be slower for agent scenario runs
OPENCODE_REAL_E2E_AND_AGENT_TIMEOUT = OPENCODE_REAL_E2E_TIMEOUT + OPENCODE_AGENT_SCENARIOS_TIMEOUT
# copilot-cli e2e can exceed 20m on some machines/networks (auth, rate limits, cold starts).
# Keep this high enough to avoid false negatives in benchmarking runs.
COPILOT_REAL_E2E_TIMEOUT = 2400
COPILOT_AGENT_SCENARIOS_TIMEOUT = 2400  # copilot-cli agent scenarios can exceed 10m
COPILOT_REAL_E2E_AND_AGENT_TIMEOUT = COPILOT_REAL_E2E_TIMEOUT + COPILOT_AGENT_SCENARIOS_TIMEOUT
MOCK_ALL_TIMEOUT = 1200
LOCAL_REAL_E2E_AND_AGENT_TIMEOUT = 1800
SINGLE_TEST_TIMEOUT = 180  # Timeout for single test file re-run (3 minutes) 

REPO_ROOT = Path(__file__).resolve().parent
SETTINGS_CANDIDATES = [
    REPO_ROOT / "config" / "env-automated-tests.settings",
    REPO_ROOT / "env-automated-tests.settings",
]
PURE_CLI_SETTINGS_CANDIDATES = [
    REPO_ROOT / "config" / "env-opencode-optimized.settings",
    REPO_ROOT / "env-opencode-optimized.settings",
]
ENV_SETTINGS = next((path for path in SETTINGS_CANDIDATES if path.exists()), SETTINGS_CANDIDATES[0])
PURE_CLI_SETTINGS = next(
    (path for path in PURE_CLI_SETTINGS_CANDIDATES if path.exists()),
    PURE_CLI_SETTINGS_CANDIDATES[0],
)
RESULTS_DIR = REPO_ROOT / "test-results"
REAL_MCP_RESULTS_DIR = REPO_ROOT / "tests" / "real-mcp" / "results"

REAL_MCP_FILES = [
    "tests/real-mcp/real.base-tools.test.ts",
    "tests/real-mcp/real.analysis-quality.matrix.test.ts",
    "tests/real-mcp/real.stress-config.matrix.test.ts",
    "tests/real-mcp/real.agent-task.test.ts",
    "tests/real-mcp/real.code-assistance.test.ts",
    "tests/real-mcp/real.config-edge.test.ts",
]

REAL_AGENT_FILES = [
    "tests/agent_tasks/agent.scenarios.e2e.test.ts",
    "tests/agent_tasks/e2e.agent_task.schema.test.ts",
]

REAL_E2E_ADDITIONAL = [
    "tests/copilot.e2e.scenarios.test.ts",
]


def discover_all_tests() -> list[str]:
    test_root = REPO_ROOT / "tests"
    tests = sorted(
        str(path.relative_to(REPO_ROOT).as_posix())
        for path in test_root.rglob("*.test.ts")
    )
    include_timeout_benchmark = os.environ.get("MCP_INCLUDE_TIMEOUT_BENCHMARKS") == "1"
    if not include_timeout_benchmark:
        tests = [t for t in tests if t != "tests/timeout-benchmark.test.ts"]
    return tests


def build_groups() -> dict[str, dict[str, list[str] | str]]:
    all_tests = discover_all_tests()

    real_mcp = sorted({*REAL_MCP_FILES, *[t for t in all_tests if t.startswith("tests/real-mcp/")]})
    real_e2e = sorted({*([t for t in all_tests if t.startswith("tests/e2e.")]), *[t for t in REAL_E2E_ADDITIONAL if t in all_tests]})
    real_agent = [t for t in REAL_AGENT_FILES if t in all_tests]

    real_set = set(real_mcp + real_e2e + real_agent)
    mock_agent = sorted([t for t in all_tests if t.startswith("tests/agent_tasks/") and t not in real_set])
    mock_general = sorted([t for t in all_tests if t not in real_set and t not in mock_agent])
    mock_all = sorted({*mock_agent, *mock_general})
    real_e2e_and_agent = sorted({*real_e2e, *real_agent})
    return {
        "mock_all": {
            "label": "MOCK: Unified suite (agent + general)",
            "files": mock_all,
        },
        "real_e2e_and_agent": {
            "label": "REAL: End-to-end + agent scenarios",
            "files": real_e2e_and_agent,
        },
        "real_mcp_matrix": {
            "label": "REAL: Real MCP matrices",
            "files": real_mcp,
        },
    }


GROUPS_MOCK = ["mock_all"]
GROUPS_REAL = ["real_e2e_and_agent", "real_mcp_matrix"]
GROUPS_ALL = GROUPS_MOCK + GROUPS_REAL

REAL_MCP_SUITES = {
    "core": "real.base-tools.test.ts",
    "llm": "real.base-tools.test.ts",
    "agent": "real.agent-task.test.ts",
    "security": "real.base-tools.test.ts",
    "analysis": "real.analysis-quality.matrix.test.ts",
    "stress": "real.stress-config.matrix.test.ts",
    "assistance": "real.code-assistance.test.ts",
    "edge": "real.config-edge.test.ts",
}


@dataclass
class GroupResult:
    key: str
    label: str
    files: list[str]
    duration_seconds: float
    exit_code: int
    json_path: str
    log_path: str


@dataclass
class RunResult:
    name: str
    suite: str
    backend: str
    timestamp: str
    duration_seconds: float
    exit_code: int
    report_file: str | None
    summary_file: str | None
    group_results: list[GroupResult]


def timestamp() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def relative_path(path_value: str) -> str:
    try:
        return str(Path(path_value).resolve().relative_to(REPO_ROOT))
    except ValueError:
        return path_value


def ensure_settings() -> None:
    if ENV_SETTINGS.exists():
        return

    expected = ", ".join(str(path.relative_to(REPO_ROOT)) for path in SETTINGS_CANDIDATES)
    raise SystemExit(f"Missing settings file. Expected one of: {expected}")


def resolve_executable(name: str) -> str:
    return shutil.which(name) or name


def vitest_prefix() -> list[str]:
    """Return a command prefix for running Vitest without hitting Windows .cmd length limits.

    Prefer `node node_modules/vitest/vitest.mjs` when available (works cross-platform and
    avoids invoking `npx.cmd`/`cmd.exe`, which has a much smaller command-line limit).
    """
    vitest_mjs = REPO_ROOT / "node_modules" / "vitest" / "vitest.mjs"
    if vitest_mjs.exists():
        node = resolve_executable("node")
        return [node, str(vitest_mjs)]

    npx = resolve_executable("npx")
    return [npx, "vitest"]


def build_vitest_run_cmd(test_files: list[str], output_json: Path) -> list[str]:
    return [*vitest_prefix(), "run", *test_files, "--reporter=json", f"--outputFile={output_json}"]


def log(message: str, flush: bool = True) -> None:
    """Print a message with optional flush for immediate output."""
    print(message, flush=flush)


def check_cli_available(cli_name: str) -> None:
    """Check if a CLI tool is available and responsive.
    
    Raises SystemExit if the CLI is not found or doesn't respond within timeout.
    """
    cli_path = shutil.which(cli_name)
    if not cli_path:
        raise SystemExit(f"[ERROR] {cli_name} not found in PATH.")
    try:
        version = subprocess.run(
            [cli_path, "--version"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            env=os.environ.copy(),
            timeout=CLI_VERSION_TIMEOUT,
            stdin=subprocess.DEVNULL,
        )
        if version.returncode != 0:
            raise SystemExit(f"[ERROR] {cli_name} returned non-zero exit code.")
        log(f"[OK] {cli_name} available: {version.stdout.strip()[:50]}")
    except subprocess.TimeoutExpired:
        raise SystemExit(f"[ERROR] {cli_name} --version timed out after {CLI_VERSION_TIMEOUT}s")
    except Exception as e:
        raise SystemExit(f"[ERROR] {cli_name} check failed: {e}")


def read_settings_text() -> str:
    return ENV_SETTINGS.read_text(encoding="utf-8")


def enforce_model_settings(settings_text: str, backend: str) -> None:
    settings_path = str(ENV_SETTINGS.relative_to(REPO_ROOT))
    if backend == "copilot-cli":
        if "copilot-cli" not in settings_text:
            raise SystemExit(f"[ERROR] Missing copilot-cli backend in {settings_path}")
        if "gpt-5-mini" not in settings_text:
            raise SystemExit(f"[ERROR] copilot-cli must use model gpt-5-mini in {settings_path}")
    if backend == "opencode-cli":
        if "opencode-cli" not in settings_text:
            raise SystemExit(f"[ERROR] Missing opencode-cli backend in {settings_path}")
        if "opencode/big-pickle" not in settings_text:
            raise SystemExit(f"[ERROR] opencode-cli must use model opencode/big-pickle in {settings_path}")


def check_lm_studio() -> bool:
    try:
        req = urllib.request.Request("http://127.0.0.1:1234/v1/models")
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status == 200
    except (urllib.error.URLError, TimeoutError):
        return False


def ensure_build() -> None: 
    """Ensure the project is built.
    
    Runs build if dist/index.js is missing OR appears stale compared to src/ and build inputs.
    """ 
    dist_path = REPO_ROOT / "dist" / "index.js" 
    if dist_path.exists():
        try:
            dist_mtime = dist_path.stat().st_mtime

            def newest_mtime(root: Path) -> float:
                latest = 0.0
                if not root.exists():
                    return latest
                for p in root.rglob("*"):
                    try:
                        if p.is_file():
                            latest = max(latest, p.stat().st_mtime)
                    except OSError:
                        # Best-effort: ignore unreadable transient files
                        continue
                return latest

            src_latest = newest_mtime(REPO_ROOT / "src")
            build_inputs = [
                REPO_ROOT / "tsconfig.json",
                REPO_ROOT / "tsconfig.build.json",
                REPO_ROOT / "package.json",
                REPO_ROOT / "package-lock.json",
            ]
            inputs_latest = max(
                [dist_mtime, src_latest]
                + [p.stat().st_mtime for p in build_inputs if p.exists()]
            )

            if inputs_latest <= dist_mtime:
                log("[OK] Build verified")
                return

            log("[BUILD] dist is stale; rebuilding (npm run build)...")
        except OSError:
            # If we can't stat something, fall back to rebuilding.
            log("[BUILD] Build check failed; rebuilding (npm run build)...")
    else:
        log("[BUILD] Running npm run build...") 
    npm = resolve_executable("npm") 
    try: 
        result = subprocess.run( 
            [npm, "run", "build"], 
            cwd=REPO_ROOT,
            env=os.environ.copy(),
            timeout=BUILD_TIMEOUT,
            stdin=subprocess.DEVNULL,
        )
        if result.returncode != 0:
            raise SystemExit("[ERROR] Build failed.")
        log("[OK] Build verified")
    except subprocess.TimeoutExpired:
        raise SystemExit(f"[ERROR] Build timed out after {BUILD_TIMEOUT}s")


def make_env(backend: str) -> dict[str, str]:
    env = os.environ.copy()
    env["MCP_LOCAL_LLM_SETTINGS_PATH"] = str(ENV_SETTINGS)
    
    # Set MCP_LOCAL_LLM_BACKEND_ID to route ALL LLM calls through the selected backend
    # This affects llm_chat, analyze_file, summarize, and ALL other LLM tool calls
    if backend == "copilot-cli":
        env["MCP_LOCAL_LLM_BACKEND_ID"] = "copilot-cli"
    elif backend == "opencode-cli":
        env["MCP_LOCAL_LLM_BACKEND_ID"] = "opencode-cli"
    else:
        # For "local" backend, use LM Studio (HTTP-based, fast)
        env["MCP_LOCAL_LLM_BACKEND_ID"] = "lmstudio"
        env["CLI_ORCHESTRATION_ENABLED"] = "false"
        # Enable LM Studio tests (required for tests/setup.ts to set VITEST_LMSTUDIO_READY=true)
        env["MCP_RUN_LMSTUDIO_TESTS"] = "true"
        if "CLI_ORCHESTRATION_BACKENDS" in env:
            env.pop("CLI_ORCHESTRATION_BACKENDS", None)
    return env


def run_command( 
    cmd: list[str], 
    env: dict[str, str], 
    log_path: Path, 
    timeout: Optional[int] = None, 
) -> tuple[int, bool]: 
    """Run a command and log output to a file.
    
    Args:
        cmd: Command and arguments to run
        env: Environment variables
        log_path: Path to write stdout/stderr
        timeout: Optional timeout in seconds (None = use default TEST_GROUP_TIMEOUT)
    
    Returns:
        Tuple of (exit_code, timed_out)
    """
    if timeout is None: 
        timeout = TEST_GROUP_TIMEOUT 
     
    log_path.parent.mkdir(parents=True, exist_ok=True) 
    timed_out = False 
    exit_code = -1 
    start_time = time.time()
    last_heartbeat = start_time
    heartbeat_seconds = 30  # show progress so long-running suites don't look hung
     
    try: 
        with log_path.open("w", encoding="utf-8") as log_file: 
            proc = subprocess.Popen( 
                cmd, 
                cwd=REPO_ROOT, 
                env=env, 
                stdout=log_file, 
                stderr=subprocess.STDOUT, 
                stdin=subprocess.DEVNULL, 
                text=True, 
            ) 
            try:
                # Poll so we can emit heartbeats and handle Ctrl+C cleanly.
                while True:
                    rc = proc.poll()
                    if rc is not None:
                        exit_code = rc
                        break

                    now = time.time()
                    elapsed = now - start_time
                    if elapsed >= timeout:
                        timed_out = True
                        exit_code = -1
                        log_file.write(f"\n\n[TIMEOUT] Command timed out after {timeout}s\n")
                        try:
                            if os.name == "nt":
                                subprocess.run(
                                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                                    stdout=log_file,
                                    stderr=log_file,
                                    timeout=30,
                                )
                            else:
                                proc.kill()
                        except Exception as kill_err:
                            log_file.write(f"[WARN] Failed to terminate process tree: {kill_err}\n")
                        try:
                            proc.wait(timeout=30)
                        except Exception:
                            pass
                        break

                    if now - last_heartbeat >= heartbeat_seconds:
                        last_heartbeat = now
                        # Keep console output minimal but reassuring (logs remain in file).
                        log(f"    ...still running ({int(elapsed)}s elapsed)")
                    time.sleep(0.25)
            except KeyboardInterrupt:
                # Root-cause fix: if the user interrupts, ensure we tear down the spawned process tree
                # (otherwise "hangs" can persist across reruns).
                try:
                    log_file.write("\n\n[INTERRUPT] KeyboardInterrupt received; terminating process tree...\n")
                    if os.name == "nt":
                        subprocess.run(
                            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                            stdout=log_file,
                            stderr=log_file,
                            timeout=30,
                        )
                    else:
                        proc.kill()
                except Exception as kill_err:
                    log_file.write(f"[WARN] Failed to terminate process tree: {kill_err}\n")
                raise
    except subprocess.TimeoutExpired: 
        timed_out = True 
        exit_code = -1 
        # Append timeout message to log 
        with log_path.open("a", encoding="utf-8") as log_file: 
            log_file.write(f"\n\n[TIMEOUT] Command timed out after {timeout}s\n") 
    except Exception as e:
        exit_code = -1
        with log_path.open("a", encoding="utf-8") as log_file:
            log_file.write(f"\n\n[ERROR] Command failed: {e}\n")
    
    return exit_code, timed_out


def parse_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def collect_failed_test_files(results_files: Iterable[Path]) -> list[str]:
    failed = set()
    for json_file in results_files:
        payload = parse_json(json_file)
        for test_result in payload.get("testResults", []):
            name = test_result.get("name")
            status = test_result.get("status")
            assertions = test_result.get("assertionResults", [])
            has_failure = status == "failed" or any(ar.get("status") == "failed" for ar in assertions)
            if has_failure and name:
                failed.add(name)
    return sorted(failed)


def rerun_failures(failing_files: list[str], env: dict[str, str], timestamp_value: str) -> tuple[list[str], list[str]]: 
    """Re-run failing test files individually to identify flaky tests.""" 
    rerun_passed: list[str] = [] 
    rerun_failed: list[str] = [] 
    backend_id = env.get("MCP_LOCAL_LLM_BACKEND_ID", "")

    for test_file in failing_files: 
        safe_name = Path(test_file).name.replace(".test.ts", "") 
        output_json = RESULTS_DIR / f"rerun_{safe_name}_{timestamp_value}.json" 
        log_path = RESULTS_DIR / f"rerun_{safe_name}_{timestamp_value}.log" 
        cmd = build_vitest_run_cmd([test_file], output_json) 
        timeout = SINGLE_TEST_TIMEOUT
        # Some suites are intentionally long-running; use a more realistic timeout when rerunning on opencode-cli.
        if backend_id == "opencode-cli":
            if test_file.endswith("tests/agent_tasks/agent.scenarios.e2e.test.ts"):
                timeout = OPENCODE_AGENT_SCENARIOS_TIMEOUT
            elif test_file.endswith("tests/e2e.improvements.test.ts"):
                timeout = OPENCODE_REAL_E2E_TIMEOUT
            elif test_file.endswith("tests/e2e.smoke.test.ts"):
                timeout = max(timeout, 300)
        elif backend_id == "copilot-cli":
            if test_file.endswith("tests/agent_tasks/agent.scenarios.e2e.test.ts"):
                timeout = COPILOT_AGENT_SCENARIOS_TIMEOUT
            elif test_file.endswith("tests/e2e.improvements.test.ts"):
                timeout = COPILOT_REAL_E2E_TIMEOUT
            elif test_file.endswith("tests/e2e.smoke.test.ts"):
                timeout = max(timeout, 300)
        exit_code, timed_out = run_command(cmd, env, log_path, timeout=timeout) 
        if exit_code == 0 and not timed_out: 
            rerun_passed.append(test_file) 
        else: 
            rerun_failed.append(test_file) 
            if timed_out: 
                log(f"    [TIMEOUT] {test_file} timed out after {timeout}s") 
 
    (RESULTS_DIR / "rerun_passed.txt").write_text("\n".join(rerun_passed), encoding="utf-8") 
    (RESULTS_DIR / "rerun_failed.txt").write_text("\n".join(rerun_failed), encoding="utf-8") 
    return rerun_passed, rerun_failed 


def write_report(
    report_path: Path,
    timestamp_value: str,
    suite: str,
    lm_available: bool,
    total_groups: int,
    total_files: int,
    total_passed: int,
    total_failed: int,
    failed_groups: list[str],
    groups: dict[str, dict[str, list[str] | str]],
    group_json_files: dict[str, Path],
    group_results: list[GroupResult],
    rerun_passed: list[str],
    rerun_failed: list[str],
) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    lines.append("# MCP Local LLM Test Report")
    lines.append("")
    lines.append(f"**Timestamp:** {timestamp_value}")
    lines.append("")
    lines.append(f"**Suite:** {suite}")
    lines.append("")
    lines.append(f"**LM Studio:** {'yes' if lm_available else 'no'}")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## Results")
    lines.append("")
    lines.append(f"- **Groups:** {total_groups}")
    lines.append(f"- **Files:** {total_files}")
    lines.append(f"- **Passed:** {total_passed}")
    lines.append(f"- **Failed:** {total_failed}")

    if failed_groups:
        lines.append("")
        lines.append("## Failed Tests")
        lines.append("")
        for group in failed_groups:
            label = str(groups[group]["label"])
            files = " ".join(groups[group]["files"])
            lines.append(f"- {label}")
            lines.append(f"  Files: {files}")

        lines.append("")
        lines.append("## Failure Details")
        lines.append("")
        for group in failed_groups:
            json_file = group_json_files.get(group)
            if json_file and json_file.exists():
                label = str(groups[group]["label"])
                lines.append(f"### {label}")
                lines.append("")
                lines.append("```json")
                lines.append(json_file.read_text(encoding="utf-8"))
                lines.append("```")
                lines.append("")
    else:
        lines.append("")
        lines.append("## Status: ALL TESTS PASSED")
        lines.append("")
        lines.append(f"All {total_passed} groups passed successfully.")

    if group_results:
        lines.append("")
        lines.append("## Group Timing")
        lines.append("")
        lines.append("| Group | Duration (s) | Status | Files | Log | JSON |")
        lines.append("|---|---:|:---:|---:|---|---|")
        for result in group_results:
            status = "PASS" if result.exit_code == 0 else "FAIL"
            log_path = relative_path(result.log_path)
            json_path = relative_path(result.json_path)
            lines.append(
                f"| {result.label} | {result.duration_seconds:.1f} | {status} | {len(result.files)} | {log_path} | {json_path} |"
            )

    if rerun_passed or rerun_failed:
        lines.append("")
        lines.append("---")
        lines.append("")
        lines.append("## Re-run Results")
        lines.append("")
        lines.append(f"- **Original Failures:** {total_failed}")
        lines.append(f"- **Now Passing [Flaky]:** {len(rerun_passed)}")
        lines.append(f"- **Still Failing:** {len(rerun_failed)}")

        if rerun_passed:
            lines.append("")
            lines.append("### Tests Now Passing (Flaky)")
            lines.append("")
            for test_file in rerun_passed:
                lines.append(f"- {test_file}")

        if rerun_failed:
            lines.append("")
            lines.append("### Tests Still Failing")
            lines.append("")
            for test_file in rerun_failed:
                lines.append(f"- {test_file}")

    report_path.write_text("\n".join(lines), encoding="utf-8")


def run_full_suite(backend: str) -> RunResult:
    """Run the full test suite for a given backend."""
    ensure_settings()

    settings_text = read_settings_text()
    enforce_model_settings(settings_text, backend)

    if backend == "copilot-cli":
        check_cli_available("copilot")
    if backend == "opencode-cli":
        check_cli_available("opencode")

    group_map = build_groups()
    groups = [group for group in GROUPS_ALL if group_map[group]["files"]]
    suite = "full"

    log("============================================")
    log("MCP LOCAL LLM - TEST RUNNER")
    log("============================================")
    log("")

    timestamp_value = timestamp()
    log(f"Timestamp: {timestamp_value}")
    log(f"Suite:     {suite}")
    log(f"Backend:   {backend}")
    log(f"Results:   {RESULTS_DIR}")
    log("")

    ensure_build()

    lm_available = check_lm_studio()
    if lm_available:
        log("[OK] LM Studio available")
    else:
        log("[WARN] LM Studio not available")

    env = make_env(backend)

    total_passed = 0
    total_failed = 0
    total_files = 0
    failed_groups: list[str] = []
    timed_out_groups: list[str] = []
    group_json_files: dict[str, Path] = {}
    group_results: list[GroupResult] = []

    start_time = time.perf_counter()

    for index, group_key in enumerate(groups, start=1):
        group = group_map[group_key]
        label = str(group["label"])
        files = group["files"]
        group_file_count = len(files)
        total_files += group_file_count

        log(f"[{index}/{len(groups)}] {label} ({group_file_count} files)")

        json_path = RESULTS_DIR / f"{group_key}_{timestamp_value}.json"
        log_path = RESULTS_DIR / f"{group_key}_{timestamp_value}.log"
        group_json_files[group_key] = json_path

        cmd = build_vitest_run_cmd(list(files), json_path) 
        group_start = time.perf_counter() 
        group_timeout = TEST_GROUP_TIMEOUT
        if group_key == "mock_all":
            group_timeout = MOCK_ALL_TIMEOUT
        elif group_key == "real_e2e_and_agent":
            if backend == "opencode-cli":
                group_timeout = OPENCODE_REAL_E2E_AND_AGENT_TIMEOUT
            elif backend == "copilot-cli":
                group_timeout = COPILOT_REAL_E2E_AND_AGENT_TIMEOUT
            else:
                group_timeout = LOCAL_REAL_E2E_AND_AGENT_TIMEOUT
        exit_code, timed_out = run_command(cmd, env, log_path, timeout=group_timeout) 
        group_duration = time.perf_counter() - group_start 

        # Use -1 exit code for timeouts
        effective_exit_code = -1 if timed_out else exit_code

        group_results.append(
            GroupResult(
                key=group_key,
                label=label,
                files=list(files),
                duration_seconds=group_duration,
                exit_code=effective_exit_code,
                json_path=str(json_path),
                log_path=str(log_path),
            )
        )

        if timed_out: 
            log(f"    TIMEOUT (after {group_timeout}s)") 
            total_failed += 1 
            failed_groups.append(group_key) 
            timed_out_groups.append(group_key) 
        elif exit_code == 0:
            log("    PASS")
            total_passed += 1
        else:
            log("    FAIL")
            total_failed += 1
            failed_groups.append(group_key)

    duration = time.perf_counter() - start_time

    rerun_passed: list[str] = []
    rerun_failed: list[str] = []

    # Only rerun non-timeout failures
    non_timeout_failed = [g for g in failed_groups if g not in timed_out_groups]
    if non_timeout_failed:
        log("")
        log("============================================")
        log("RE-RUNNING FAILING TESTS")
        log("============================================")
        log("")

        failed_json_files = [group_json_files[group] for group in non_timeout_failed]
        failing_files = collect_failed_test_files(failed_json_files)
        if failing_files:
            rerun_passed, rerun_failed = rerun_failures(failing_files, env, timestamp_value)

    report_path = RESULTS_DIR / f"report_{timestamp_value}.md"
    summary_path = RESULTS_DIR / f"summary_{timestamp_value}.txt"

    write_report(
        report_path,
        timestamp_value,
        suite,
        lm_available,
        len(groups),
        total_files,
        total_passed,
        total_failed,
        failed_groups,
        group_map,
        group_json_files,
        group_results,
        rerun_passed,
        rerun_failed,
    )

    summary_lines = [
        "MCP Local LLM Test Summary",
        "===========================",
        f"Timestamp: {timestamp_value}",
        f"Suite: {suite}",
        f"Backend: {backend}",
        f"Groups: {len(groups)}",
        f"Files: {total_files}",
        f"Passed: {total_passed}",
        f"Failed: {total_failed}",
        f"DurationSeconds: {duration:.1f}",
    ]
    summary_lines.append("")
    summary_lines.append("Group Timings:")
    for result in group_results:
        status = "PASS" if result.exit_code == 0 else "FAIL"
        summary_lines.append(
            f"- {result.label}: {result.duration_seconds:.1f}s ({status}) [{len(result.files)} files]"
        )
    summary_path.write_text("\n".join(summary_lines), encoding="utf-8")

    final_exit_code = 0
    if failed_groups:
        if rerun_failed or timed_out_groups:
            final_exit_code = 1
        elif not rerun_passed:
            final_exit_code = 1

    log("")
    log("============================================")
    log("SUMMARY")
    log("============================================")
    log("")
    log(f"Groups: {len(groups)}")
    log(f"Files:  {total_files}")
    log(f"Passed: {total_passed}")
    log(f"Failed: {total_failed}")
    if timed_out_groups:
        log(f"Timeouts: {len(timed_out_groups)}")
    log("")

    if not failed_groups:
        log("[SUCCESS] All tests passed!")
    elif timed_out_groups:
        log("[TIMEOUT] Some test groups timed out:")
        for group_key in timed_out_groups:
            log(f"  - {group_map[group_key]['label']}")
        if rerun_failed:
            log("[FAILED] Some tests still failing:")
            for test_file in rerun_failed:
                log(f"  - {test_file}")
    elif rerun_failed:
        log("[FAILED] Some tests still failing:")
        for test_file in rerun_failed:
            log(f"  - {test_file}")
    elif rerun_passed:
        log("[SUCCESS] All previously failing tests now pass!")
        log("[INFO] Some tests were flaky but passed on re-run.")
    else:
        log("[FAILED] Some tests failed and could not be re-run.")

    log("")
    log(f"Report: {report_path}")
    log("")

    return RunResult(
        name="full-suite",
        suite=suite,
        backend=backend,
        timestamp=timestamp_value,
        duration_seconds=duration,
        exit_code=final_exit_code,
        report_file=str(report_path),
        summary_file=str(summary_path),
        group_results=group_results,
    )


def run_real_mcp_suite(suite: str, backend: str, verbose: bool, fail_fast: bool) -> RunResult:
    """Run the real MCP server test suite."""
    ensure_settings()

    settings_text = read_settings_text()
    enforce_model_settings(settings_text, backend)

    if backend == "copilot-cli":
        check_cli_available("copilot")
    if backend == "opencode-cli":
        check_cli_available("opencode")

    suite = suite.lower()
    if suite not in {"all", "core", "llm", "agent", "security", "analysis", "stress", "assistance", "edge", "quick"}:
        raise SystemExit(f"Unknown MCP suite: {suite}")

    if not check_lm_studio():
        raise SystemExit("[ERROR] LM Studio is not available at http://127.0.0.1:1234")

    ensure_build()

    env = make_env(backend)
    timestamp_value = timestamp()

    if suite == "all":
        tests_to_run = list(REAL_MCP_SUITES.values())
    elif suite == "quick":
        tests_to_run = [REAL_MCP_SUITES["core"], REAL_MCP_SUITES["agent"]]
    else:
        tests_to_run = [REAL_MCP_SUITES[suite]]

    REAL_MCP_RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    log("============================================")
    log("MCP REAL SERVER TEST RUNNER (Python)")
    log("============================================")
    log("")
    log(f"Timestamp: {timestamp_value}")
    log(f"Suite: {suite}")
    log(f"Backend: {backend}")
    log(f"Results Dir: {REAL_MCP_RESULTS_DIR}")
    log("")

    results = []
    total_passed = 0
    total_failed = 0
    total_skipped = 0
    failed_suites: list[str] = []
    timed_out_suites: list[str] = []
    start_time = time.perf_counter()

    for test_file in tests_to_run:
        log("")
        log(f"[RUNNING] {test_file}")
        log("----------------------------------------")

        test_path = f"tests/real-mcp/{test_file}"
        output_json = REAL_MCP_RESULTS_DIR / f"{Path(test_file).stem}_{timestamp_value}.json"
        log_file_path = REAL_MCP_RESULTS_DIR / f"{Path(test_file).stem}_{timestamp_value}.log"

        cmd = build_vitest_run_cmd([test_path], output_json)
        start = time.perf_counter()
        exit_code, timed_out = run_command(cmd, env, log_file_path)
        test_duration = time.perf_counter() - start

        data = parse_json(output_json)
        passed = data.get("numPassedTests", 0) or 0
        failed_count = data.get("numFailedTests", 0) or 0
        skipped = data.get("numPendingTests", 0) or 0
        total_passed += passed
        total_failed += failed_count
        total_skipped += skipped

        if timed_out:
            log(f"[TIMEOUT] {test_file} timed out after {TEST_GROUP_TIMEOUT}s")
            failed_suites.append(test_file)
            timed_out_suites.append(test_file)
        elif exit_code == 0:
            log(f"[PASSED] {test_file} ({passed} tests, {test_duration:.1f}s)")
        else:
            log(f"[FAILED] {test_file} ({failed_count} failed, {passed} passed)")
            failed_suites.append(test_file)

            if verbose:
                for tr in data.get("testResults", []):
                    for ar in tr.get("assertionResults", []):
                        if ar.get("status") == "failed":
                            message = "\n".join(ar.get("failureMessages", []))
                            log(f"  - {ar.get('title')}\n    {message}")

            if fail_fast:
                log("\n[FAILFAST] Stopping due to test failure")
                break

        results.append(
            {
                "file": test_file,
                "exitCode": -1 if timed_out else exit_code,
                "timedOut": timed_out,
                "duration": test_duration,
                "passed": passed,
                "failed": failed_count,
                "skipped": skipped,
            }
        )

    total_duration = time.perf_counter() - start_time

    llm_report = REAL_MCP_RESULTS_DIR / f"llm_analysis_{timestamp_value}.md"
    summary_file = REAL_MCP_RESULTS_DIR / f"summary_{timestamp_value}.json"

    success_rate = round((total_passed / max(1, total_passed + total_failed)) * 100, 1)
    report_lines = [
        "# MCP Real Server Test Results",
        "## LLM Analysis Report",
        "",
        f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"Suite: {suite}",
        "",
        "## Summary",
        "",
        "| Metric | Count |",
        "|--------|-------|",
        f"| Total Passed | {total_passed} |",
        f"| Total Failed | {total_failed} |",
        f"| Total Skipped | {total_skipped} |",
        f"| Success Rate | {success_rate}% |",
        "",
    ]

    if not failed_suites:
        report_lines.extend(
            [
                "## Status: ✅ ALL TESTS PASSED",
                "",
                "All test suites completed successfully.",
                "No fixes required.",
                "",
            ]
        )
    else:
        report_lines.extend(
            [
                "## Status: ❌ SOME TESTS FAILED",
                "",
                f"Failed Suites: {', '.join(failed_suites)}",
                "",
                "## Failed Test Details",
                "",
            ]
        )
        for result in results:
            if result["failed"] > 0:
                report_lines.extend(
                    [
                        f"### {result['file']}",
                        "",
                        f"- Passed: {result['passed']}",
                        f"- Failed: {result['failed']}",
                        f"- Duration: {result['duration']:.1f}s",
                        "",
                    ]
                )

    llm_report.write_text("\n".join(report_lines), encoding="utf-8")

    summary_payload = {
        "timestamp": timestamp_value,
        "suite": suite,
        "totalPassed": total_passed,
        "totalFailed": total_failed,
        "totalSkipped": total_skipped,
        "successRate": success_rate,
        "failedSuites": failed_suites,
        "results": results,
        "durationSeconds": round(total_duration, 1),
    }
    summary_file.write_text(json.dumps(summary_payload, indent=2), encoding="utf-8")

    final_exit_code = 1 if failed_suites else 0

    log("")
    log("============================================")
    log("END OF TEST RUN")
    log("============================================")

    return RunResult(
        name="real-mcp",
        suite=suite,
        backend=backend,
        timestamp=timestamp_value,
        duration_seconds=total_duration,
        exit_code=final_exit_code,
        report_file=str(llm_report),
        summary_file=str(summary_file),
        group_results=[],
    )


def write_benchmark_report(results: list[RunResult]) -> Path:
    benchmark_timestamp = timestamp()
    report_path = RESULTS_DIR / f"benchmark_{benchmark_timestamp}.md"
    json_path = RESULTS_DIR / f"benchmark_{benchmark_timestamp}.json"

    backend_order = [r.backend for r in results]
    result_by_backend = {r.backend: r for r in results}
    group_map: dict[str, dict[str, GroupResult]] = {
        backend: {gr.key: gr for gr in result.group_results}
        for backend, result in result_by_backend.items()
    }

    group_keys: list[str] = []
    if results and results[0].group_results:
        group_keys = [gr.key for gr in results[0].group_results]

    lines: list[str] = [
        "# MCP Local LLM Benchmark Report",
        "",
        f"Generated: {benchmark_timestamp}",
        "",
        "## Summary",
        "",
        "| Backend | Suite | Duration (s) | Exit Code | Report | Summary |",
        "|---|---|---:|---:|---|---|",
    ]

    for backend in backend_order:
        result = result_by_backend[backend]
        lines.append(
            "| {backend} | {suite} | {duration:.1f} | {exit_code} | {report} | {summary} |".format(
                backend=backend,
                suite=result.suite,
                duration=result.duration_seconds,
                exit_code=result.exit_code,
                report=relative_path(result.report_file or ""),
                summary=relative_path(result.summary_file or ""),
            )
        )

    if group_keys:
        lines.extend([
            "",
            "## Group Timing Comparison",
            "",
        ])

        header = ["Group", "Files"] + [f"{backend} (s)" for backend in backend_order] + ["Fastest", "Slowest", "Δ Slow-Fast (s)"]
        lines.append("| " + " | ".join(header) + " |")
        lines.append("|" + "|".join(["---"] * len(header)) + "|")

        for key in group_keys:
            row: list[str] = []
            label = group_map[backend_order[0]][key].label
            files_count = str(len(group_map[backend_order[0]][key].files))
            row.append(label)
            row.append(files_count)

            duration_map: dict[str, float] = {}
            duration_cells: list[str] = []
            for backend in backend_order:
                group = group_map[backend].get(key)
                if group:
                    duration_map[backend] = group.duration_seconds
                    duration_cells.append(f"{group.duration_seconds:.1f}")
                else:
                    duration_cells.append("n/a")

            row.extend(duration_cells)

            if duration_map:
                fastest_backend, fastest = min(duration_map.items(), key=lambda item: item[1])
                slowest_backend, slowest = max(duration_map.items(), key=lambda item: item[1])
                row.append(f"{fastest_backend} ({fastest:.1f}s)")
                row.append(f"{slowest_backend} ({slowest:.1f}s)")
                row.append(f"{(slowest - fastest):.1f}")
            else:
                row.extend(["n/a", "n/a", "n/a"])

            lines.append("| " + " | ".join(row) + " |")

        lines.extend([
            "",
            "## Group Logs",
            "",
            "| Backend | Group | Log | JSON |",
            "|---|---|---|---|",
        ])

        for backend in backend_order:
            for group in results[0].group_results:
                backend_group = group_map[backend].get(group.key)
                if backend_group:
                    lines.append(
                        "| {backend} | {label} | {log} | {json} |".format(
                            backend=backend,
                            label=backend_group.label,
                            log=relative_path(backend_group.log_path),
                            json=relative_path(backend_group.json_path),
                        )
                    )

    report_path.write_text("\n".join(lines), encoding="utf-8")

    json_payload = {
        "generated": benchmark_timestamp,
        "backends": backend_order,
        "summary": [
            {
                "backend": r.backend,
                "suite": r.suite,
                "timestamp": r.timestamp,
                "durationSeconds": r.duration_seconds,
                "exitCode": r.exit_code,
                "reportFile": relative_path(r.report_file or ""),
                "summaryFile": relative_path(r.summary_file or ""),
            }
            for r in results
        ],
        "groups": {
            backend: {
                gr.key: {
                    "label": gr.label,
                    "files": gr.files,
                    "durationSeconds": gr.duration_seconds,
                    "exitCode": gr.exit_code,
                    "logPath": relative_path(gr.log_path),
                    "jsonPath": relative_path(gr.json_path),
                }
                for gr in result_by_backend[backend].group_results
            }
            for backend in backend_order
        },
    }

    json_path.write_text(json.dumps(json_payload, indent=2), encoding="utf-8")

    return report_path


def main() -> int:
    parser = argparse.ArgumentParser(description="MCP Local LLM unified test runner")
    parser.add_argument("--backend", default="local", help="Backend: local, copilot-cli, opencode-cli")
    parser.add_argument(
        "--all-backends",
        action="store_true",
        help="Run the full test suite sequentially with local, opencode-cli, and copilot-cli",
    )
    parser.add_argument(
        "--benchmarking",
        action="store_true",
        help="Run the full suite across local, opencode-cli, and copilot-cli and compare group timings",
    )
    parser.add_argument(
        "--pure-cli",
        action="store_true",
        help="Use pure CLI mode with config/env-opencode-optimized.settings (root fallback supported)",
    )
    parser.add_argument("--mcp-suite", default="", help="Run real-mcp suite only: all, core, llm, agent, security, analysis, stress, assistance, edge, quick")
    parser.add_argument("--verbose", action="store_true", help="Show detailed failure output for real-mcp runs")
    parser.add_argument("--fail-fast", action="store_true", help="Stop on first failure for real-mcp runs")

    args = parser.parse_args()

    if args.benchmarking and args.mcp_suite:
        raise SystemExit("[ERROR] --benchmarking cannot be combined with --mcp-suite")

    if args.all_backends and args.mcp_suite:
        raise SystemExit("[ERROR] --all-backends cannot be combined with --mcp-suite")

    # V24: Handle --pure-cli flag - uses optimized settings with zero LLM overhead
    if args.pure_cli:
        rel_pure_cli_settings = str(PURE_CLI_SETTINGS.relative_to(REPO_ROOT))
        log(f"[PURE-CLI] Using {rel_pure_cli_settings} for zero LLM overhead")
        os.environ["MCP_LOCAL_LLM_SETTINGS_PATH"] = str(PURE_CLI_SETTINGS)
        args.backend = "opencode-cli"  # Force opencode backend

    if args.benchmarking:
        benchmark_results: list[RunResult] = []
        for backend in ["local", "opencode-cli", "copilot-cli"]:
            log(f"\n{'='*60}")
            log(f"BENCHMARKING: Running full suite with backend '{backend}'")
            log(f"{'='*60}\n")
            benchmark_results.append(run_full_suite(backend))

        report_path = write_benchmark_report(benchmark_results)
        log("")
        log(f"Benchmark report: {report_path}")
        return 1 if any(r.exit_code != 0 for r in benchmark_results) else 0

    if args.all_backends:
        all_backend_results: list[RunResult] = []
        for backend in ["local", "opencode-cli", "copilot-cli"]:
            log(f"\n{'='*60}")
            log(f"Running full suite with backend '{backend}'")
            log(f"{'='*60}\n")
            all_backend_results.append(run_full_suite(backend))

        log("")
        log("="*60)
        log("FINAL SUMMARY")
        log("="*60)
        for result in all_backend_results:
            status = "OK" if result.exit_code == 0 else "FAIL"
            log(f"[{status}] {result.backend}: {result.duration_seconds:.1f}s")

        return 1 if any(r.exit_code != 0 for r in all_backend_results) else 0

    backend = args.backend
    if backend not in {"local", "copilot-cli", "opencode-cli"}:
        raise SystemExit(f"Unknown backend: {backend}")

    if args.mcp_suite:
        result = run_real_mcp_suite(args.mcp_suite, backend, args.verbose, args.fail_fast)
    else:
        result = run_full_suite(backend)

    return result.exit_code


if __name__ == "__main__":
    sys.exit(main())
