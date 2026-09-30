# mcpLocalHelper

Experimental MCP developer tooling for local-model assistance, code analysis and task delegation.

**Status: engineering prototype and portfolio case study. Not production-ready.** This repository preserves a working design and its development/testing material. It has not been certified for production security, reliability or compatibility with every current model and MCP client. Start with a disposable workspace and non-sensitive examples.

## The problem I was exploring

Developer agents can spend substantial context on tool descriptions and raw repository output. Local models can take on some analysis, but integrating them means dealing with workspace boundaries, model capabilities, failures and the hand-off back to the calling agent.

I built this project to explore that integration: expose useful analysis through MCP, let an IDE agent delegate bounded work, and make local and optional external backends configurable. The value of this repository is the implementation and the decisions it makes visible, rather than a claim that MCP or hybrid inference was invented here.

## What the code demonstrates

- **Protocol and model integration:** MCP tool registration and adapters for local model servers, with optional external backends
- **Code-analysis tooling:** duplicate-file, similar-function and duplicate-code analysis, evolved from earlier Python utilities
- **Context management:** a small initial tool surface with discovery and progressive expansion instead of presenting every tool at once
- **Operational concerns:** workspace configuration, input limits, backend timeouts, concurrency controls and failure reporting
- **Evaluation practice:** deterministic tests alongside prompt-based evaluation material, with model output treated as something to review

These are inspectable engineering choices. They are not evidence of customer adoption, measured business impact or an enterprise deployment.

## Project history

The project started as private MCP experiments in August 2025 and evolved across earlier repositories before this cleaned public release.

| Date | Development milestone |
| --- | --- |
| August 2025 | Python MCP prototype, followed by duplicate-file/function/code analysis tools |
| November 2025 | TypeScript server implementation with local-model adapters and configurable external-model access |
| December 2025 | Migration of the Python analysis tools and addition of progressive tool discovery |
| February 2026 | Clean public release as mcpLocalHelper |

This chronology describes development history, not an earlier public release. The public history starts with [the initial release on 10 February 2026](https://github.com/rodhayl/mcpLocalHelper/commit/78b39901e09ea3b5787b7786ea8a3e65e5bfdda2). Its short commit history is a publication snapshot rather than the full development history. The earlier working repositories remain private.

## Scope and safety limits

- **Local execution is a configuration choice, not an end-to-end privacy guarantee.** External adapters can send data off-device. An MCP client may also forward tool results to its own cloud model, even when this server used a local backend
- Redaction and path restrictions are safeguards with limitations. They do not establish complete secret detection, a hardened execution sandbox or regulatory compliance
- Model-generated findings, edits and plans require review. Optional execution tools should only be evaluated with restricted permissions and disposable data
- Client configuration examples below reflect the development period. Check the current client's MCP schema, supported tools and trust settings before using them
- Test commands and historical evaluation material are retained for reproducibility. This documentation update does not constitute a fresh execution of those suites

**Reviewed positioning: 30 September 2026.** The ecosystem has developed since this work began. Use this as a case study in building and assessing integrations; evaluate maintained alternatives against your present requirements before adopting it.

---

## Documentation Map

- `docs/API_REFERENCE.md` - full tool schemas and usage
- `docs/TOOL_VISIBILITY_TIERS.md` - tool surfacing strategy (core/discoverable/hidden)
- `docs/examples/client-configuration-guide.md` - IDE/client setup patterns
- `docs/operations/scripts-guide.md` - operational scripts and maintenance
- `docs/operations/test-utils.md` - test harness utilities
- `docs/prompts/` - curated prompt suites for QA/regression workflows

## Prerequisites

- Node.js 20+ and npm
- One local LLM backend running (LM Studio or Ollama)
- Python 3.10+ (only required for `run_all_tests_ALL.py`)

## Quick Start

### Windows Users - Automated Setup

```cmd
# Start the server (auto-installs dependencies if needed)
start.bat

# Stop the server
stop.bat
```

### Manual Installation

```bash
# Install dependencies from the project root
npm install
npm run build

# Configure (optional)
cp env.settings.example env.settings

# Start
npm start
```

### VS Code Integration

There are several ways to configure MCP Local LLM with VS Code. Choose the method that best fits your workflow.

#### Option 1: Environment Variable (Recommended for Distribution)

**Step 1:** Set an environment variable pointing to your mcpLocalLLM installation:

**Windows (PowerShell - add to profile for persistence):**
```powershell
$env:MCP_LOCAL_LLM_PATH = "C:\path\to\mcpLocalLLM"
[Environment]::SetEnvironmentVariable("MCP_LOCAL_LLM_PATH", "C:\path\to\mcpLocalLLM", "User")
```

**macOS/Linux:**
```bash
# Add to ~/.bashrc or ~/.zshrc
export MCP_LOCAL_LLM_PATH="/path/to/mcpLocalLLM"
```

**Step 2:** Create `.vscode/mcp.json` in any project:
```json
{
  "mcp": {
    "servers": {
      "mcp-local-llm": {
        "command": "node",
        "args": [
          "${env:MCP_LOCAL_LLM_PATH}/dist/index.js",
          "--settings",
          "${env:MCP_LOCAL_LLM_PATH}/env.settings"
        ]
      }
    }
  }
}
```

This same configuration works across all projects without modification.

#### Option 2: Absolute Path (Simple, Project-Specific)

Create `.vscode/mcp.json` with the full path:
```json
{
  "mcp": {
    "servers": {
      "mcp-local-llm": {
        "command": "node",
        "args": [
          "C:/Users/yourname/mcpLocalLLM/dist/index.js",
          "--settings",
          "C:/Users/yourname/mcpLocalLLM/env.settings"
        ]
      }
    }
  }
}
```

> **Note:** Pass `--settings <path>` to ensure the server uses the intended settings file (especially when you have multiple installs).

#### Option 3: Per-Project Configuration with Custom Workspace

For projects that need custom workspace settings, create a project-local `env.settings`:

**Step 1:** Copy `env.settings.example` to your project as `env.settings`

**Step 2:** Configure workspace roots + allowlist via the Web UI (`http://127.0.0.1:3000/`) or by editing `[config] CONFIG_JSON` in `env.settings`.

**Step 3:** Point your `.vscode/mcp.json` to this settings file:
```json
{
  "mcp": {
    "servers": {
      "mcp-local-llm": {
        "command": "node",
        "args": [
          "${env:MCP_LOCAL_LLM_PATH}/dist/index.js",
          "--settings",
          "${workspaceFolder}/env.settings"
        ]
      }
    }
  }
}
```

#### Optional: OpenRouter for Testing

If you want to test with an external SOTA backend (not needed for normal use):
```json
{
  "mcp": {
    "servers": {
      "mcp-local-llm": {
        "command": "node",
        "args": [
          "${env:MCP_LOCAL_LLM_PATH}/dist/index.js",
          "--settings",
          "${env:MCP_LOCAL_LLM_PATH}/env.settings"
        ],
        "env": {
          "TESTING_MODE_ENABLED": "true",
          "OPENROUTER_API_KEY": "sk-or-v1-your-key-here"
        }
      }
    }
  }
}
```

### Other IDEs

#### Cursor

Create `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "mcp-local-llm": {
      "command": "node",
      "args": ["${env:MCP_LOCAL_LLM_PATH}/dist/index.js"],
      "env": {
        "WORKSPACE_ROOT": "${workspaceFolder}"
      }
    }
  }
}
```

#### Windsurf

Create `.windsurf/mcp.json`:
```json
{
  "mcpServers": {
    "mcp-local-llm": {
      "command": "node",
      "args": ["${env:MCP_LOCAL_LLM_PATH}/dist/index.js"],
      "env": {
        "WORKSPACE_ROOT": "${workspaceFolder}"
      }
    }
  }
}
```

#### Claude Desktop

Add to `claude_desktop_config.json`:
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mcp-local-llm": {
      "command": "node",
      "args": ["C:/path/to/mcpLocalLLM/dist/index.js"],
      "env": {
        "WORKSPACE_ROOT": "C:/path/to/your/project"
      }
    }
  }
}
```

> **Important:** Set `WORKSPACE_ROOT` to your project for proper path resolution.

#### Roo Code / Kilo Code

```json
{
  "mcpServers": {
    "mcp-local-llm": {
      "command": "node",
      "args": ["C:/path/to/mcpLocalLLM/dist/index.js"],
      "env": {
        "WORKSPACE_ROOT": "C:/path/to/your/project"
      }
    }
  }
}
```

#### Zed

```json
{
  "mcpServers": {
    "mcp-local-llm": {
      "command": "node",
      "args": ["/path/to/mcpLocalLLM/dist/index.js"],
      "env": {
        "WORKSPACE_ROOT": "/path/to/your/project"
      }
    }
  }
}
```



## Available Tools (48 registered; 47 enabled by default)

The tool surface is consolidated into three tiers to keep ListTools small while preserving full capability.

### Core Tools (always exposed via ListTools)

| Tool | Description |
|------|-------------|
| `agent_task` | Autonomous multi-step task execution |
| `mcp_health` | Server health and diagnostics |
| `search` | Unified search (intelligent/structured/gather/filenames) |
| `analyze_file` | LLM-powered file analysis |
| `suggest_edit` | LLM-powered edit suggestions |
| `local_code_review` | Model-assisted code review with configurable backend |
| `security` | Secret scanning, risk analysis, redaction, and fixes |
| `summarize` | File/directory/repo summaries |
| `workspace` | Workspace metadata, snapshots, and exploration |
| `discover_tools` | Find additional tools by category or capability |

### Discoverable Tools (via `discover_tools`)

Categories:
- `code_analysis` - find_duplicates, code_quality_analyzer, analyze_file, code_helper, mcp_analyze_complexity
- `security` - security, local_code_review, analyze_impact
- `testing` - analyze_test_gaps
- `documentation` - generate_docs, mcp_diff_summarizer, summarize, generate_agents_md
- `refactoring` - suggest_refactoring, refactor_helper, suggest_edit, draft_file, find_and_fix
- `planning` - agent_task, mcp_plan_implementation, cli_orchestrate
- `search` - search, codebase_qa, todos, index_symbols, cross_file_links
- `llm_assistance` - code_helper, regex_helper, refactor_helper, mcp_error_explainer, mcp_translate_code, mcp_summarize_logs
- `execution` - linter, formatter
- `workspace` - workspace, analyze_file
- `system` - mcp_health

### Agent-Only Tools (hidden from ListTools)

Hidden by default but callable by name (or via `agent_task`):
`llm_chat`, `agent_task_result`, `agent_queue_status`, `mcp_server`, `mcp_ask`, `system_profile`, `model_info`, `mcp_debug`, `mcp_terminal_command`, `refine_prompt`, `read_file`, `verify_plan`

For complete schemas and usage examples, see docs/API_REFERENCE.md.

## MCP Prompts (Guided Workflows)

Invoke these prompts to run multi-tool workflows:

| Prompt | Description |
|--------|-------------|
| `/analyze-security` | Comprehensive security analysis |
| `/find-todos` | Find and prioritize technical debt |
| `/review-changes` | Guided code-review workflow |
| `/explain-code` | Detailed code explanation |
| `/generate-tests` | Generate comprehensive tests |
| `/suggest-improvements` | Get refactoring suggestions |

## Automated Prompt-Based QA

This repository uses a second QA layer in addition to unit/integration/e2e tests:
prompt-driven black-box evaluations stored in `docs/prompts/`.

### Why This Exists

- Deterministic tests catch functional regressions quickly.
- Prompt-based QA catches behavior quality issues that static assertions miss:
  prompt interpretation quality, report usefulness, orchestration behavior, and real-world operator ergonomics.

### Prompt Catalog (`docs/prompts/`)

| Prompt File | Primary Use |
|-------------|-------------|
| `00_smoke.md` | Fast smoke validation |
| `10_regression_feedback_4_5.md` | Regression checks for historical feedback batches 4/5 |
| `20_regression_feedback_6.md` | Regression checks for historical feedback batch 6 |
| `30_edge_cases.md` | Edge-case behavior and failure-mode validation |
| `40_production_readiness.md` | Production-readiness checklist run |
| `MCP_TEST_BLACK_BOX_COMPACT.md` | Compact black-box evaluation for small local models |
| `MCP_TEST_BLACK_BOX_STANDARD.md` | Standard black-box evaluation |
| `MCP_TEST_COMPACT_V2.md` | Compact black-box evaluation v2 |
| `MCP_TEST_COMPREHENSIVE_V2.md` | Comprehensive black-box evaluation v2 |
| `MCP_TEST_CRITICAL_COMPACT.md` | Compact critical bug hunt |
| `MCP_TEST_CRITICAL_STANDARD.md` | Standard critical-component validation |
| `MCP_FINAL_TEST.md` | Single comprehensive final validation prompt |
| `AGENT_TEST_PROMPT.md` | End-to-end agent-oriented tool testing prompt |
| `DEBUG-FIX-PROMPT.md` | Turn accumulated QA reports into a focused fix pass |
| `QA_feedback_empty.md` | Template for recording findings in a consistent format |

### Recommended QA Workflow

1. Run deterministic baseline tests first:
   - `python run_all_tests_ALL.py`
   - `npm test`
2. Execute prompt suites against target backends/models (local and/or CLI backends).
3. Save each run report using the `QA_feedback_empty.md` structure into a reports folder (for example `TEST_PROMPTS/REPORTS/QA_feedback_01.md`, `QA_feedback_02.md`, etc.).
4. For each finding, explicitly classify:
   - real repository issue, or
   - evaluator/model mistake (false positive or prompt misunderstanding).
5. Use `docs/prompts/DEBUG-FIX-PROMPT.md` with the reports folder to drive an implementation pass.
6. Re-run deterministic tests and at least one black-box prompt before publishing.

### Automation vs Manual Testing Effectiveness

| Dimension | Prompt-Based QA | Manual Testing |
|-----------|------------------|----------------|
| Breadth per run | High (many behaviors covered quickly) | Medium |
| Repeatability | High when prompts + config are versioned | Medium/Low |
| Speed to first signal | High | Medium/Low |
| False-positive risk | Medium (model/evaluator noise exists) | Low/Medium |
| UX/intent nuance detection | Medium/High | High |
| Best use | Continuous regression sweeps | Final human sign-off and edge judgment |

Practical guidance:
- Do not replace manual testing with prompt automation.
- Use prompt-based QA for scale and regression detection, then use manual testing for final adjudication and release confidence.

## Why These Tools?

### Choosing a focused tool surface

The design aims to complement an IDE's existing file and terminal tools. Client behavior varies; duplicate-tool suppression is not a compatibility guarantee. The project explored:

1. **Local-model assistance**: Model-assisted analysis alongside deterministic tools
2. **Configurable processing**: Local analysis where selected, with external paths requiring separate data-sharing review
3. **Redaction safeguards**: Pattern-based filtering of some sensitive data, with incomplete coverage
4. **Symbol Awareness**: Understands code structure, not just text
5. **Security Scanning**: Built-in vulnerability detection

### Tools delegated to the client

Some overlapping tools were removed from the default exposed surface or retained only as hidden aliases. Where appropriate, use your client's supported equivalents:
- `read_file` (hidden alias of `analyze_file`, not exposed via ListTools) -> Use VS Code's `#readFile`
- `edit_file` -> Use VS Code's `#editFiles`
- `create_file` -> Use VS Code's `#createFile`
- `list_dir` -> Use VS Code's `#listDirectory`
- `git_status/diff/log/commit` -> Use VS Code's Source Control
- `execute_script` -> Use VS Code's `#runInTerminal`
- `run_tests` -> Use VS Code's `#runTests`

## Configuration

### Initial Setup

```bash
# Copy the example settings
cp env.settings.example env.settings

# Edit to match your setup (optional - defaults work for most users)
# The example file is well-commented and explains all options
```

Note: The repository `env.settings.example` is the canonical source of defaults. When building the npm package the build process copies this file into `dist_package/env.settings.example` (via `node scripts/generate_package_files.js`) so the package uses the same example. A parity test (`tests/config.settings-parity.test.ts`) runs in CI to ensure the packaged example always matches the repository file, preventing accidental drift.

### Backend Configuration (`env.settings`)

Backends/defaults live in `[config] CONFIG_JSON` inside `env.settings` (or configure via the Web UI at `http://127.0.0.1:3000/`).

### Workspace Configuration

Workspace roots + allowlist live in `[config] CONFIG_JSON` inside `env.settings`.

> **Tip:** Relative paths in `env.settings` are resolved relative to the settings file's directory, not the current working directory.

### Dynamic Workspace Detection

The MCP server automatically detects your workspace using this priority:

1. **MCP Client Roots** (if supported): The server requests workspace roots from the client via the MCP protocol (`roots/list`). This happens automatically on connection.
2. **`WORKSPACE_ROOT` Environment Variable**: Fallback for explicit control.
3. **Global Install Auto-Detection**: When config is in a global location (`~/.mcp-local-llm`, npm global), **the current working directory is used as workspace automatically**.
4. **Project Auto-Detection**: If launched from a directory containing `package.json`, `pyproject.toml`, `.git`, etc., that directory is used.
5. **Settings File Default**: Falls back to `workspace.roots` from `env.settings`

> **Global npm install users:** Workspace is now detected automatically from your project's working directory. No configuration needed.

> **Troubleshooting:** If tools report "Outside workspace" errors, check the startup logs for `[Config] Workspace from cwd...` messages.


### Tool Groups

Tools are organized into groups that can be enabled/disabled (examples only; see docs/API_REFERENCE.md for the full list):

| Group | Example Tools | Purpose |
|-------|---------------|---------|
| `core.summary` | summarize | LLM summarization |
| `core.chat` | llm_chat | Direct LLM access |
| `core.discovery` | discover_tools | Tool discovery |
| `planning` | agent_task, verify_plan, cli_orchestrate | Planning and delegation |
| `analysis.extended` | workspace, todos, codebase_qa, analyze_test_gaps, analyze_impact | Codebase analysis |
| `privacy` | security | Security tools |
| `llm.enhanced` | analyze_file, search, local_code_review, generate_docs, suggest_refactoring, suggest_edit, find_and_fix | LLM-enhanced tools |
| `code.analysis` | find_duplicates, code_quality_analyzer | Code quality |
| `llm.assistance` | code_helper, regex_helper, refactor_helper, mcp_error_explainer, mcp_translate_code | LLM assistance |
| `execution` | linter, formatter | Code quality automation |
| `system.info` | mcp_health, system_profile, model_info, mcp_debug | System diagnostics |
| `mcp.client` | mcp_server, mcp_ask | External MCP integration |

## Privacy & Security

- **Backend selection:** inspect the active configuration and the MCP client's own data flow; local adapters do not make the entire session offline
- **Content redaction:** filters known patterns but can miss secrets, proprietary content and contextual identifiers
- **Path restrictions:** configured allowlists narrow intended access; they are not a substitute for OS isolation
- **Size limits:** bound some inputs; verify effective limits for the selected workflow

Use only data you are permitted to share with every participating service. Review execution tools and external-provider settings before enabling them.

## Agent Scenarios Testing

The project includes agent-scenario tests for selected workflows and external MCP integrations. Passing them in one setup does not validate every backend, client, security property or deployment.

### Running Agent Scenarios Tests

#### Basic Tests (No External Services Required)

```bash
# Run configuration and structure validation tests
npx vitest run tests/agent_tasks/agent.scenarios.basic.test.ts

# Run all basic tests together
npx vitest run tests/agent_tasks/agent.scenarios.basic.test.ts
```

#### Full End-to-End Tests (Requires External Services)

```bash
# Run complete agent scenarios (requires LM Studio, local server, MCP servers)
npx vitest run tests/agent_tasks/agent.scenarios.e2e.test.ts

# Run specific test suites
npx vitest run tests/agent_tasks/agent.scenarios.e2e.test.ts -t "Read-Only Operations"
npx vitest run tests/agent_tasks/agent.scenarios.e2e.test.ts -t "Chrome DevTools"
npx vitest run tests/agent_tasks/agent.scenarios.e2e.test.ts -t "Context7"
```

### Test Requirements

| Test Suite | Requirements | Description |
|------------|--------------|-------------|
| **Basic Tests** | None | Configuration loading and structure validation |
| **Read-Only Operations** | LM Studio backend | Repo audits, security analysis |
| **Chrome DevTools** | Chrome DevTools MCP | Browser automation, screenshots |
| **Context7** | Context7 MCP | Library documentation validation |
| **Local Server** | Local MCP server | API integration, server management |

### Configuration

The test runner uses centralized automated settings (via `run_all_tests_ALL.py`):

- **Canonical Settings File**: `config/env-automated-tests.settings`
- **Compatibility Fallback**: `env-automated-tests.settings` (root)
- **Primary Backend**: configured in `[config] CONFIG_JSON` (defaults)
- **MCP Servers**: configured under `mcpServers` (optional)
- **Workspace**: configured under `workspace` / `policy.allowlistPaths`
- **Tool Groups**: configured under `toolGroups` / `[advanced] TOOL_GROUP_MODE`
- **Runner Usage**:
  - Full suite: `python run_all_tests_ALL.py`
  - Force Copilot CLI: `python run_all_tests_ALL.py --backend copilot-cli`
  - Force OpenCode CLI: `python run_all_tests_ALL.py --backend opencode-cli`
  - All backends: `python run_all_tests_ALL.py --all-backends`
  - Benchmark backends: `python run_all_tests_ALL.py --benchmarking`

### Test Output

- **Configuration Tests**: 11 tests validating all configuration aspects
- **Structure Tests**: 5 tests validating test framework structure
- **E2E Tests**: 27 comprehensive scenarios covering all major workflows
- **Output Location**: `tests/.mcp_cache/agent_scenarios/`

### Development Mode

```bash
# Run tests with UI for development
npx vitest tests/agent_tasks/agent.scenarios.*

# Run specific test with debugging
npx vitest run tests/agent_tasks/agent.scenarios.basic.test.ts --reporter=verbose
```

## Development

```bash
npm run dev    # Development mode with auto-reload
npm test       # Run tests (auto-prepares + auto-cleans transient test artifacts)
npm run build  # Build for production
npm run cleanup:runtime  # Prune runtime artifact dirs (.mcp-backups, .orchestration-plans)
```

### Runtime Artifact Cleanup

The server can accumulate local runtime artifacts over time:
- `.mcp-backups/` from edit/auto-fix backup snapshots
- `.orchestration-plans/` from persisted CLI orchestration plans

Use:

```bash
npm run cleanup:runtime
```

Default pruning behavior:
- Removes `.mcp-backups/tests/` (test-only backup artifacts)
- Removes backup files older than 14 days
- Caps remaining backups to the newest 1000 files
- Removes orchestration plans older than 14 days
- Caps remaining plans to the newest 200 directories
- Removes orphan `*.tmp` files under `.orchestration-plans/`

Optional dry-run:

```bash
node scripts/cleanup-runtime-artifacts.js --dry-run
```

## Architecture

```text
+-----------------------------+
|       VS Code Copilot       |
+--------------+--------------+
               |
               v
      MCP Protocol (stdio)
               |
               v
+-----------------------------+
|     MCP Local LLM Server    |
| - LLM-Enhanced Tools        |
| - Data filtering            |
| - Analysis Tools            |
+--------------+--------------+
               |
               v
 Backend Adapters: Ollama | LM Studio | OpenRouter | Generic OpenAI
               |
               v
      Selected model backend
    (local or explicitly external)
```

## License

ISC
