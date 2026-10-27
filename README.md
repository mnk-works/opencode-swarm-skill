# opencode-swarm-skill

> *"The swarm will not be denied."*
> — Sarah Kerrigan, *StarCraft II: Heart of the Swarm* ([Opening Cinematic](https://www.youtube.com/watch?v=MVbeoSPqRs4))

Run a multi-model agent swarm with peer collaboration via MCP. Spawns multiple OpenCode sessions (each with a different model/provider) that coordinate through an embedded MCP server.

## Features

- **Zero-friction reuse**: Install once, configure once, run with `opencode swarm start`
- **Model-agnostic**: Works with ANY models from ANY providers configured in OpenCode
- **Smart auto-detection**: `opencode swarm init` auto-finds Nemotron (or any) models across providers
- **Interactive model selection**: `opencode swarm init --interactive` lets you pick models visually
- **Model discovery**: `opencode swarm models` lists all available models grouped by provider
- **Native MCP coordination**: Agents share findings, propose tasks, vote, and escalate via `swarm.*` tools
- **Human-in-the-loop**: You stay in control — agents escalate decisions via `swarm.request_human()`
- **Ephemeral by default**: Shared state lives in-memory per session; no cleanup needed
- **Cross-platform**: Works on Linux, macOS, Windows

## Quick Start

```bash
# 1. Install the skill (one-time)
opencode skill install github.com/mnk-works/opencode-swarm-skill

# 2. In your project, initialize config (auto-detects models)
opencode swarm init

# 3. Or interactively pick your models
opencode swarm init --interactive

# 4. Browse available models anytime
opencode swarm models
opencode swarm models --provider openrouter

# 5. Start the swarm
opencode swarm start

# 6. Check status
opencode swarm status

# 7. View logs
opencode swarm logs
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Your Project                             │
│  .opencode/swarm.yaml    ← Config: models, roles, rules    │
└─────────────────────────────────────────────────────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │ Agent A  │  │ Agent B  │  │ Agent C  │
        │Researcher│  │  Critic  │  │Synthesizer│
        │ Model 1  │  │ Model 2  │  │ Model 3  │
        └────┬─────┘  └────┬─────┘  └────┬─────┘
             │             │             │
             └─────────────┼─────────────┘
                           ▼
                  ┌──────────────────┐
                  │  MCP Server      │
                  │  (in-process)    │
                  │  swarm.* tools   │
                  └──────────────────┘
```

## MCP Tools (available to every agent)

| Tool | Purpose |
|------|---------|
| `swarm_register(id, model, role)` | Register on startup |
| `swarm_broadcast(finding, tags?)` | Share finding with all agents |
| `swarm_read_context(since?)` | Get full shared state |
| `swarm_propose_task(subtask, assignee?, context?)` | Delegate work |
| `swarm_claim_task(task_id)` | Claim a proposed task |
| `swarm_complete_task(task_id, result)` | Mark task done |
| `swarm_propose_vote(question, options?)` | Start a vote |
| `swarm_vote(proposal_id, choice, reasoning?)` | Vote |
| `swarm_read_vote(proposal_id)` | Check tally |
| `swarm_request_human(question, context?)` | Escalate to you |
| `swarm_get_config()` | Read swarm.yaml |

## Default Configuration

The `opencode swarm init` creates `.opencode/swarm.yaml` by auto-detecting available models. It prefers:

1. **Nemotron models** from different providers (if available)
2. **Any models** from different providers (fallback)

Example output (varies by your configured providers):

```yaml
agents:
  - id: researcher
    model: cloudflare-workers-ai/@cf/nvidia/nemotron-3-120b-a12b
    role: "Deep technical analysis, find root causes, propose solutions"
  
  - id: critic
    model: kilo/nvidia/nemotron-3-nano-30b-a3b
    role: "Challenge assumptions, find gaps, stress-test proposals"
  
  - id: synthesizer
    model: nano-gpt/Envoid/Llama-3.05-Nemotron-Tenyxchat-Storybreaker-70B
    role: "Merge findings, resolve conflicts, produce final output"
```

Each agent gets a tailored system prompt with:
- Their role and responsibilities
- List of peer agents
- Instructions to use `swarm.*` tools for coordination

## Commands

| Command | Description |
|---------|-------------|
| `opencode swarm init` | Create `.opencode/swarm.yaml` (auto-detects models) |
| `opencode swarm init -i` | Interactive model selection |
| `opencode swarm models` | List all available models grouped by provider |
| `opencode swarm models -p openrouter` | Filter models by provider |
| `opencode swarm start` | Launch all agents (background processes with logs) |
| `opencode swarm stop` | Stop all swarm agents |
| `opencode swarm status` | Show agent status and recent activity |
| `opencode swarm logs` | View recent broadcasts (use `--follow` to tail) |

## Agent Prompts

Each agent receives a system prompt from `swarm.yaml` that includes:
- Their role and responsibilities
- Instructions to use `swarm.*` tools for coordination
- The full swarm config so they know their peers

Example agent startup sequence:
```python
# Agent automatically runs this on startup:
await swarm_register("researcher", "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", "Deep technical analysis...")
# Then:
context = await swarm_read_context()
# Then starts working, broadcasting findings:
await swarm_broadcast("Found root cause in parser at line 234", tags=["bug", "parser"])
```

## Coordination Modes

| Mode | Description |
|------|-------------|
| `peer_collaboration` | All agents work together, sharing findings freely (default) |
| `pipeline` | Agent A → Agent B → Agent C (sequential stages) |
| `consensus` | Agents vote on key decisions before proceeding |
| `delegation` | One lead agent delegates subtasks to others |

## Publishing

```bash
# From the skill directory:
git init
git add .
git commit -m "Initial release"
git remote add origin https://github.com/mnk-works/opencode-swarm-skill.git
git push -u origin main

# Tag a release
git tag v0.1.0
git push origin v0.1.0
```

Users can then install with:
```bash
opencode skill install github.com/mnk-works/opencode-swarm-skill
# Or specific version:
opencode skill install github.com/mnk-works/opencode-swarm-skill@v0.1.0
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `Error: spawn python ENOENT` | Install Python 3: `apt install python3` or `brew install python3` |
| `Add credits to continue` | Use models with free tiers, or add credits to your provider accounts |
| `Expected a string starting with "ses"` | Fixed in v0.1.0+ — session IDs now auto-generated correctly |
| Agents stop immediately | Check logs with `opencode swarm logs` — usually rate limits or auth issues |
| MCP tools not found | Ensure `pip install mcp` succeeded; check Python path |

## Requirements

- OpenCode CLI (`opencode`)
- Python 3.8+ with `mcp` package (`pip install mcp`)
- At least 2 configured model providers in OpenCode

## License

MIT