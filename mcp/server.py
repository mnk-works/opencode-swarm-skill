"""
OpenCode Swarm MCP Server

Provides coordination primitives for multi-agent peer collaboration.
Each agent connects to this server via MCP and gets access to swarm.* tools.
"""

from mcp.server.fastmcp import FastMCP as _FastMCP
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from datetime import datetime
import json
import uuid
import asyncio
import sys

# ============================================================
# Port override (must be set before run(); module name "mcp"
# shadows the installed mcp package, so imports are lazy here)
# ============================================================

_PORT = 8765
for _i, _a in enumerate(sys.argv):
    if _a == "--port":
        try:
            _PORT = int(sys.argv[_i + 1])
        except (ValueError, IndexError):
            pass


class FastMCP(_FastMCP):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.settings.host = "127.0.0.1"
        self.settings.port = _PORT
        # Stateless streamable-HTTP: any number of agent clients can POST
        # without per-connection SSE sessions (no stale-session 404s).
        self.settings.stateless_http = True


mcp = FastMCP("opencode-swarm")

# ============================================================
# In-memory shared state (ephemeral, per-session)
# ============================================================

@dataclass
class SwarmState:
    agents: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    messages: List[Dict[str, Any]] = field(default_factory=list)
    tasks: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    votes: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    human_requests: List[Dict[str, Any]] = field(default_factory=list)
    config: Dict[str, Any] = field(default_factory=dict)

state = SwarmState()


# ============================================================
# MCP Tools
# ============================================================

@mcp.tool()
async def swarm_register(agent_id: str, model: str, role: str = "") -> Dict[str, Any]:
    """Register this agent with the swarm. Call once on startup."""
    state.agents[agent_id] = {
        "model": model,
        "role": role,
        "joined_at": datetime.now().isoformat(),
        "last_seen": datetime.now().isoformat(),
    }
    return {
        "status": "registered",
        "agent_id": agent_id,
        "swarm_size": len(state.agents),
        "config": state.config,
    }


@mcp.tool()
async def swarm_heartbeat(agent_id: str) -> Dict[str, Any]:
    """Update last_seen timestamp. Call periodically."""
    if agent_id in state.agents:
        state.agents[agent_id]["last_seen"] = datetime.now().isoformat()
    return {"status": "ok", "agent_id": agent_id}


@mcp.tool()
async def swarm_broadcast(agent_id: str, finding: str, tags: List[str] = None) -> Dict[str, Any]:
    """Share a finding with all agents in the swarm."""
    msg = {
        "id": str(uuid.uuid4())[:8],
        "type": "broadcast",
        "from": agent_id,
        "content": finding,
        "tags": tags or [],
        "timestamp": datetime.now().isoformat(),
    }
    state.messages.append(msg)
    return {"status": "broadcast", "message_id": msg["id"]}


@mcp.tool()
async def swarm_read_context(agent_id: str, since: str = None) -> Dict[str, Any]:
    """Get full shared context: messages, tasks, votes, agents."""
    messages = state.messages
    if since:
        messages = [m for m in messages if m["timestamp"] > since]
    return {
        "agents": state.agents,
        "messages": messages,
        "tasks": state.tasks,
        "votes": state.votes,
        "human_requests": state.human_requests,
        "config": state.config,
    }


@mcp.tool()
async def swarm_propose_task(
    agent_id: str,
    subtask: str,
    assignee: str = None,
    context: str = None
) -> Dict[str, Any]:
    """Propose a subtask for another agent (or any agent) to pick up."""
    task_id = str(uuid.uuid4())[:8]
    task = {
        "id": task_id,
        "proposed_by": agent_id,
        "assignee": assignee,
        "subtask": subtask,
        "context": context,
        "status": "proposed",
        "created_at": datetime.now().isoformat(),
        "claimed_by": None,
        "result": None,
    }
    state.tasks[task_id] = task
    return {"status": "proposed", "task_id": task_id, "task": task}


@mcp.tool()
async def swarm_claim_task(agent_id: str, task_id: str) -> Dict[str, Any]:
    """Claim a proposed task."""
    if task_id not in state.tasks:
        return {"status": "error", "error": f"Task {task_id} not found"}
    task = state.tasks[task_id]
    if task["status"] != "proposed":
        return {"status": "error", "error": f"Task {task_id} already {task['status']}"}
    task["status"] = "claimed"
    task["claimed_by"] = agent_id
    task["claimed_at"] = datetime.now().isoformat()
    return {"status": "claimed", "task": task}


@mcp.tool()
async def swarm_complete_task(agent_id: str, task_id: str, result: str) -> Dict[str, Any]:
    """Mark a task complete with result."""
    if task_id not in state.tasks:
        return {"status": "error", "error": f"Task {task_id} not found"}
    task = state.tasks[task_id]
    if task["claimed_by"] != agent_id:
        return {"status": "error", "error": "Only claimant can complete"}
    task["status"] = "completed"
    task["result"] = result
    task["completed_at"] = datetime.now().isoformat()
    return {"status": "completed", "task": task}


@mcp.tool()
async def swarm_vote(agent_id: str, proposal_id: str, choice: str, reasoning: str = "") -> Dict[str, Any]:
    """Vote on a proposal. Choices: yes/no/abstain."""
    if proposal_id not in state.votes:
        state.votes[proposal_id] = {
            "id": proposal_id,
            "created_at": datetime.now().isoformat(),
            "votes": {},
        }
    vote = state.votes[proposal_id]
    vote["votes"][agent_id] = {
        "choice": choice,
        "reasoning": reasoning,
        "timestamp": datetime.now().isoformat(),
    }
    return {"status": "voted", "proposal_id": proposal_id, "tally": _tally(vote)}


@mcp.tool()
async def swarm_propose_vote(agent_id: str, question: str, options: List[str] = None) -> Dict[str, Any]:
    """Create a new vote proposal."""
    proposal_id = str(uuid.uuid4())[:8]
    state.votes[proposal_id] = {
        "id": proposal_id,
        "question": question,
        "options": options or ["yes", "no", "abstain"],
        "proposed_by": agent_id,
        "created_at": datetime.now().isoformat(),
        "votes": {},
    }
    return {"status": "proposed", "proposal_id": proposal_id}


@mcp.tool()
async def swarm_read_vote(proposal_id: str) -> Dict[str, Any]:
    """Read current vote tally."""
    if proposal_id not in state.votes:
        return {"status": "error", "error": "Proposal not found"}
    vote = state.votes[proposal_id]
    return {"proposal": vote, "tally": _tally(vote)}


@mcp.tool()
async def swarm_request_human(agent_id: str, question: str, context: str = None) -> Dict[str, Any]:
    """Escalate a question to the human operator."""
    req = {
        "id": str(uuid.uuid4())[:8],
        "from": agent_id,
        "question": question,
        "context": context,
        "timestamp": datetime.now().isoformat(),
        "response": None,
    }
    state.human_requests.append(req)
    return {"status": "escalated", "request_id": req["id"]}


@mcp.tool()
async def swarm_get_config() -> Dict[str, Any]:
    """Get the swarm configuration."""
    return state.config


def _tally(vote: Dict[str, Any]) -> Dict[str, int]:
    tally = {opt: 0 for opt in vote.get("options", ["yes", "no", "abstain"])}
    for v in vote["votes"].values():
        if v["choice"] in tally:
            tally[v["choice"]] += 1
    return tally


# ============================================================
# Resources (for debugging/inspection)
# ============================================================

@mcp.resource("swarm://state")
async def get_state() -> str:
    """Full swarm state as JSON."""
    return json.dumps({
        "agents": state.agents,
        "messages": state.messages,
        "tasks": state.tasks,
        "votes": state.votes,
        "human_requests": state.human_requests,
        "config": state.config,
    }, indent=2)


@mcp.resource("swarm://agents")
async def get_agents() -> str:
    """List of registered agents."""
    return json.dumps(state.agents, indent=2)


@mcp.resource("swarm://messages")
async def get_messages() -> str:
    """All broadcast messages."""
    return json.dumps(state.messages, indent=2)


@mcp.resource("swarm://tasks")
async def get_tasks() -> str:
    """All tasks."""
    return json.dumps(state.tasks, indent=2)


@mcp.resource("swarm://votes")
async def get_votes() -> str:
    """All votes."""
    return json.dumps(state.votes, indent=2)


# ============================================================
# Entry point
# ============================================================

if __name__ == "__main__":
    mcp.run(transport='streamable-http')