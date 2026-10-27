# opencode-swarm-skill

> *"The swarm will not be denied."*
> — Sarah Kerrigan, *StarCraft II: Heart of the Swarm* ([Opening Cinematic](https://www.youtube.com/watch?v=MVbeoSPqRs4))

Run a multi-model agent swarm with peer collaboration via MCP. Spawns multiple OpenCode sessions (each with a different model/provider) that coordinate through an embedded MCP server.

## Features

- **Zero-friction reuse**: Install once, configure once, run with `opencode-swarm start`
- **Model-agnostic**: Works with ANY models from ANY providers configured in OpenCode
- **Flat peers**: All agents are equals (`agent-1`, `agent-2`, ...) — no hardcoded roles or hierarchy
- **Explicit configuration**: `init` is interactive by default; nothing is auto-picked without your say-so
- **Live roster editing**: `add` / `remove` agents without re-initializing
- **Free-model awareness**: `models --free` filters to `:free` models so you don't burn credits
- **Native MCP coordination**: Agents share findings, propose tasks, vote, and escalate via `swarm.*` tools
- **Human-in-the-loop**: You stay in control — agents escalate decisions via `swarm_request_human()`
- **Ephemeral by default**: Shared state lives in-memory per session; no cleanup needed

## Quick Start

```bash
# 1. Install the skill (one-time, manual — see Installation)
git clone https://github.com/mnk-works/opencode-swarm-skill ~/.opencode/skill/opencode-swarm
ln -sf ~/.opencode/skill/opencode-swarm/commands/swarm.js /usr/local/bin/opencode-swarm
pip install mcp

# 2. In your project, configure the swarm (interactive by default)
opencode-swarm init

# 3. Browse available models anytime
opencode-swarm models            # everything
opencode-swarm models --free     # only :free models
opencode-swarm models -p openrouter

# 4. Start the swarm (also wires the MCP server into project config)
opencode-swarm start

# 5. Check status / logs
opencode-swarm status
opencode-swarm logs -f
```

## Installation

OpenCode (v2.2.0) has no `opencode skill install` subcommand, so install manually:

```bash
git clone https://github.com/mnk-works/opencode-swarm-skill ~/.opencode/skill/opencode-swarm
cd ~/.opencode/skill/opencode-swarm
npm install js-yaml --prefix .        # for the CLI's YAML handling
pip install mcp                       # for the MCP server
sudo ln -sf ~/.opencode/skill/opencode-swarm/commands/swarm.js /usr/local/bin/opencode-swarm
chmod +x ~/.opencode/skill/opencode-swarm/commands/swarm.js
```

Verify: `opencode-swarm` (prints usage) and `opencode-swarm models`.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Your Project                             │
│  .opencode/swarm.yaml    ← Config: agent ids + models      │
│  opencode.json           ← MCP server URL (written by start)│
└─────────────────────────────────────────────────────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │ agent-1  │  │ agent-2  │  │ agent-3  │
        │ Model 1  │  │ Model 2  │  │ Model 3  │
        └────┬─────┘  └────┬─────┘  └────┬─────┘
             │             │             │
             └─────────────┼─────────────┘
                           ▼
                  ┌──────────────────┐
                  │  MCP Server      │
                  │ swarm.* tools    │
                  │ (stateless HTTP) │
                  └──────────────────┘
```

`opencode-swarm start` does three things:

1. Finds a free port (from 8765) and launches `mcp/server.py` (FastMCP, stateless streamable-HTTP)
2. Writes the server URL into the project's `opencode.json` (`mcp.servers.swarm`) so every spawned session loads the `swarm.*` tools automatically
3. Spawns one `opencode run` session per configured agent, each with a flat-peer system prompt

## MCP Tools (available to every agent)

| Tool | Purpose |
|------|---------|
| `swarm_register(agent_id, model, role)` | Register on startup |
| `swarm_broadcast(finding, tags?)` | Share finding with all agents |
| `swarm_read_context(agent_id)` | Get full shared state |
| `swarm_propose_task(subtask, assignee?, context?)` | Delegate work |
| `swarm_claim_task(task_id)` | Claim a proposed task |
| `swarm_complete_task(task_id, result)` | Mark task done |
| `swarm_propose_vote(question, options?)` | Start a vote |
| `swarm_vote(proposal_id, choice, reasoning?)` | Vote |
| `swarm_read_vote(proposal_id)` | Check tally |
| `swarm_request_human(question, context?)` | Escalate to you |
| `swarm_get_config()` | Read swarm.yaml |

## Commands

| Command | Description |
|---------|-------------|
| `opencode-swarm init` | Create `.opencode/swarm.yaml` — interactive by default |
| `opencode-swarm init -n` | Simplified setup (pick provider + model per agent) |
| `opencode-swarm models` | List all available models grouped by provider |
| `opencode-swarm models --free` | Only `:free` models |
| `opencode-swarm models -p openrouter` | Filter models by provider |
| `opencode-swarm list` | Show current swarm roster |
| `opencode-swarm add --id agent-4 --model X [--role R]` | Add an agent to the roster |
| `opencode-swarm remove agent-2` | Remove an agent (peer prompts regenerate) |
| `opencode-swarm start` | Launch MCP server + all agents |
| `opencode-swarm stop` | Stop all swarm agents |
| `opencode-swarm status` | Show agent status |
| `opencode-swarm logs [--follow]` | View recent broadcasts |

### Editing the roster without re-initializing

```bash
opencode-swarm list
opencode-swarm add --id agent-4 --model openrouter/google/gemini-3.5-flash
opencode-swarm remove agent-2     # remaining agents' prompts regenerate automatically
```

Changes apply on the next `opencode-swarm start` (stop first if a swarm is running).

### Free models

Many providers expose free tiers both with and without a `:free` suffix. `opencode-swarm models --free` shows `:free`-suffixed entries; for providers that bill nothing at all (e.g. your OpenCode plan's built-ins), check `opencode-swarm models` output and a live bench (e.g. the `successful.md` from a latency benchmark) to find which plain models respond without cost.

## Configuration

`init` produces `.opencode/swarm.yaml`:

```yaml
coordination_mode: peer_collaboration
context_ttl: session
agents:
  - id: agent-1
    model: nvidia/nvidia/nemotron-3-ultra-550b-a55b
    role: Swarm agent
    system_prompt: |
      You are agent-1 in a 3-agent swarm.
      All agents are equal peers — no fixed roles, no hierarchy.
      Peers: agent-2, agent-3.
      ...
  - id: agent-2
    model: mistral/mistral-small-2603
    ...
mcp:
  host: localhost
  port: 8765        # actual port written by `start`
human:
  approve_on: [task_completion, final_output]
  notification: terminal
```

Each agent gets a flat-peer system prompt listing its peers and the `swarm.*` tools — no researcher/critic/synthesizer labels; agents self-organize.

## Agent Workflow

```python
# Agent automatically runs this on startup:
await tools.swarm_register("agent-2", "mistral/mistral-small-2603", "swarm agent")
# Then:
context = await tools.swarm_read_context(agent_id="agent-2")
# Then starts working, broadcasting findings:
await tools.swarm_broadcast("Found root cause in parser at line 234", tags=["bug", "parser"])
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `Error: spawn python ENOENT` | Install Python 3: `apt install python3` or `brew install python3` |
| `Add credits to continue` / `balance too low` | That provider/model costs money — swap it: `opencode-swarm remove <id>` then `add` a `:free` model |
| Agents stop immediately | Check `.opencode/swarm-logs/<agent>.log` — usually rate limits or auth issues |
| `WARNING: MCP server did not open port` | Check `.opencode/swarm-logs/mcp.log`; ensure `pip install mcp` succeeded |
| MCP tools not found in agent sessions | Ensure `opencode-swarm start` ran in the project root (it writes `opencode.json`); restart agents after config changes |
| Stale agents from an old run still active | `pkill -f "opencode run -m"` then `opencode-swarm start` again |
| Old port still referenced | `start` rewrites `opencode.json` and the global `mcp.servers.swarm` entry on every launch |

## Requirements

- OpenCode CLI (`opencode`)
- Python 3.8+ with `mcp` package (`pip install mcp`)
- Node.js (for the CLI script)
- At least 2 configured model providers in OpenCode

## License

MIT
