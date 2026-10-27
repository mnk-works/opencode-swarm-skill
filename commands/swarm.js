#!/usr/bin/env node

/**
 * opencode-swarm command
 * 
 * Usage:
 *   opencode-swarm init [--interactive]  # Create .opencode/swarm.yaml (interactive model selection)
 *   opencode-swarm models [--provider X] # List available models grouped by provider
 *   opencode-swarm start                 # Launch all agents
 *   opencode-swarm stop                  # Stop all swarm agents
 *   opencode-swarm status                # Show swarm state
 *   opencode-swarm logs [--follow]       # Show recent broadcast messages
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const os = require('os');

const SWARM_DIR = '.opencode';
const CONFIG_FILE = path.join(SWARM_DIR, 'swarm.yaml');
const PID_FILE = path.join(SWARM_DIR, '.swarm-pids');
const SESSIONS_FILE = path.join(SWARM_DIR, '.swarm-sessions');
const LOG_DIR = path.join(SWARM_DIR, 'swarm-logs');
const RUNNER_FILE = path.join(SWARM_DIR, 'swarm-runner.sh');
const PROMPT_DIR = path.join(SWARM_DIR, 'swarm-prompts');

function printUsage() {
  console.log(`
opencode-swarm - Multi-agent swarm coordination

USAGE
  opencode-swarm <command> [options]

COMMANDS
  init [--interactive|-i] [--non-interactive|-n]  Create .opencode/swarm.yaml
  models [--provider X] [--free]                  List models grouped by provider
  add [--id ID] [--model MODEL] [--role ROLE]     Add agent to swarm
  remove [ID]                                     Remove agent from swarm
  list                                            List current swarm agents
  start [--attach|-a] [--detached|-d]             Launch swarm (tmux panes by default)
  stop                                            Stop all swarm agents
  status                                          Show agent status and activity
  logs [--follow]                                 Show recent broadcasts
  task "objective"                                Give the swarm work (live or next round)
  say <agent-id> "message"                        Direct-message one agent's session
  inbox                                           Show agents' requests for you

EXAMPLES
  opencode-swarm init                    # Interactive setup (default)
  opencode-swarm init -i                 # Interactive setup (explicit)
  opencode-swarm init -n                 # Simplified setup
  opencode-swarm models                  # See all models
  opencode-swarm models -p openrouter    # Filter by provider
  opencode-swarm models --free           # Only free models
  opencode-swarm add --id agent-4 --model openrouter/nemotron-3-ultra:free
  opencode-swarm remove agent-2
  opencode-swarm list
  opencode-swarm start                   # tmux: one pane per agent + live dashboard
  opencode-swarm start -a                # start and attach immediately
  opencode-swarm start -d                # detached, log files only
  opencode-swarm status
  opencode-swarm logs -f
  opencode-swarm task "Refactor the parser module and broadcast your plan first"
  opencode-swarm say agent-1 "prioritize the failing tests"
  opencode-swarm inbox
`);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error(`Config not found: ${CONFIG_FILE}. Run 'opencode-swarm init' first.`);
    process.exit(1);
  }
  const yaml = require('js-yaml');
  return yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function savePids(pids) {
  fs.writeFileSync(PID_FILE, JSON.stringify(pids, null, 2));
}

function loadPids() {
  if (!fs.existsSync(PID_FILE)) return {};
  return JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
}

function ensureDirs() {
  const absSwarmDir = path.resolve(SWARM_DIR);
  const absLogDir = path.resolve(LOG_DIR);
  if (!fs.existsSync(absSwarmDir)) fs.mkdirSync(absSwarmDir, { recursive: true });
  if (!fs.existsSync(absLogDir)) fs.mkdirSync(absLogDir, { recursive: true });
  return { swarmDir: absSwarmDir, logDir: absLogDir };
}

function findAvailablePort(startPort = 8765) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const server = net.createServer();
    server.unref();
    server.on('error', () => {
      // Port in use, try next
      resolve(findAvailablePort(startPort + 1));
    });
    server.listen(startPort, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

// Write/merge the swarm MCP server into a project's opencode.json so that
// spawned `opencode run` sessions load the swarm.* tools automatically.
function writeMcpConfig(projectRoot, mcpUrl) {
  const configFile = path.join(projectRoot, 'opencode.json');
  let config = {};
  try {
    if (fs.existsSync(configFile)) {
      config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    }
  } catch (e) {
    console.error(`  WARNING: could not parse ${configFile}: ${e.message}`);
    return;
  }
  
  config.mcp = config.mcp || {};
  config.mcp.servers = config.mcp.servers || {};
  config.mcp.servers.swarm = { type: 'remote', url: mcpUrl };
  
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
}

// ============================================================
// tmux mode — one pane per agent, live output, Enter-to-rerun
// ============================================================

function tmuxAvailable() {
  return spawnSync('which', ['tmux']).status === 0;
}

function tmuxSessionName() {
  const base = path.basename(process.cwd()).replace(/[^a-zA-Z0-9_-]/g, '') || 'proj';
  return `swarm-${base}`;
}

// Kill stray agents/servers from previous launches so restarts are clean.
function killStraySwarmProcesses() {
  spawnSync('pkill', ['-f', 'ses[-]swarm-'], { stdio: 'ignore' });
  spawnSync('pkill', ['-f', 'server[.]py --port'], { stdio: 'ignore' });
}

// Liveness: is an opencode turn actually running for this session id?
function agentTurnRunning(sessionId) {
  if (!sessionId) return false;
  // [-]-session avoids pgrep interpreting the leading dash as an option
  return spawnSync('pgrep', ['-f', `[-]-session ${sessionId}`]).status === 0;
}

// The per-agent pane loop: run one turn, tee to log, wait for Enter, repeat.
function writeRunnerScript() {
  const script = `#!/usr/bin/env bash
# opencode-swarm agent runner (one tmux pane per agent)
# [Enter] after a turn = another round for this agent; Ctrl-C = stop this agent.
AGENT_ID="$1"; MODEL="$2"; SESSION_ID="$3"; PROMPT_FILE="$4"; LOG_FILE="$5"
sleep 3  # let the MCP server pane come up first
while true; do
  echo "=== [$AGENT_ID] turn start $(date '+%H:%M:%S') ==="
  opencode run -m "$MODEL" --session "$SESSION_ID" "$(cat "$PROMPT_FILE")" 2>&1 | tee -a "$LOG_FILE"
  echo
  echo "=== [$AGENT_ID] turn finished $(date '+%H:%M:%S') — [Enter] next round, Ctrl-C quit ==="
  read || break
done
`;
  fs.writeFileSync(RUNNER_FILE, script);
  fs.chmodSync(RUNNER_FILE, 0o755);
}

// Live dashboard pane: renders the swarm's shared state every 5 seconds.
function writeMonitorScript(port) {
  const script = `#!/usr/bin/env python3
"""opencode-swarm live monitor — renders shared state (messages, tasks, escalations)."""
import json, subprocess, sys, time

PORT = ${port}

def fetch():
    body = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "swarm_read_context", "arguments": {"agent_id": "monitor"}},
    })
    r = subprocess.run([
        "curl", "-s", "-m", "4", "-X", "POST", f"http://127.0.0.1:{PORT}/mcp",
        "-H", "Content-Type: application/json",
        "-H", "Accept: application/json, text/event-stream",
        "-d", body,
    ], capture_output=True, text=True)
    for line in r.stdout.splitlines():
        if line.startswith("data: "):
            payload = json.loads(line[6:])
            return json.loads(payload["result"]["content"][0]["text"])
    return None

subprocess.run(["clear"])
state = fetch()
if state is None:
    print(f"swarm monitor: MCP server not reachable on :{PORT}")
    sys.exit(0)

agents = state.get("agents", {})
tasks = state.get("tasks", {})
msgs = state.get("messages", [])
reqs = state.get("human_requests", [])

print("=" * 78)
print(f" OPENCODE SWARM   agents={len(agents)}  messages={len(msgs)}  "
      f"tasks={len(tasks)}  escalations={len(reqs)}")
print("=" * 78)
print("\\nAGENTS")
for aid, a in sorted(agents.items()):
    print(f"  {aid:<12} {a.get('model', '?')[:50]}  joined {a.get('joined_at', '?')[11:19]}")
print("\\nTASKS")
if not tasks:
    print("  (none)")
for tid, t in tasks.items():
    print(f"  [{t.get('status', '?'):<9}] {tid[:8]}  {t.get('claimed_by') or t.get('assignee') or '-':<12} "
          f"{t.get('subtask', '')[:70]}")
print("\\nESCALATIONS (answer with: opencode-swarm say <agent> \\"reply\\")")
if not reqs:
    print("  (none)")
for r in reqs[-5:]:
    print(f"  [{r.get('id', '?')}] {r.get('agent_id', '?')}: {r.get('question', '')[:70]}")
print("\\nRECENT BROADCASTS")
if not msgs:
    print("  (none)")
for m in msgs[-15:]:
    print(f"  {m.get('timestamp', '')[11:19]}  {m.get('from', '?'):<12} {m.get('content', '')[:90]}")
`;
  fs.writeFileSync(path.resolve(SWARM_DIR, 'swarm-monitor.py'), script);
}

function writePromptFiles(config, agents) {
  fs.mkdirSync(PROMPT_DIR, { recursive: true });
  for (const agent of agents) {
    const goalPrefix = config.goal ? `ROUND GOAL from the operator — top priority:\n${config.goal}\n\n` : '';
    const prompt = `${goalPrefix}${agent.system_prompt}\n\nSwarm config: ${JSON.stringify(config, null, 2)}\n\nConnect to the MCP server and start collaborating.`;
    fs.writeFileSync(path.join(PROMPT_DIR, `${agent.id}.txt`), prompt);
  }
}

// ============================================================
// Swarm Control (operator -> swarm channels)
// ============================================================

// The MCP server URL written by `start` into the project's opencode.json.
function loadServerUrl() {
  try {
    const oc = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'opencode.json'), 'utf8'));
    const u = oc.mcp && oc.mcp.servers && oc.mcp.servers.swarm && oc.mcp.servers.swarm.url;
    if (u) return u;
  } catch (e) { /* fallthrough */ }
  return null;
}

// Minimal MCP client: stateless streamable-HTTP tools/call.
async function mcpCall(url, tool, args) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now() % 1000000,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
  const raw = await res.text();
  const line = raw.split('\n').find(l => l.startsWith('data: '));
  const payload = JSON.parse(line ? line.slice(6) : raw);
  if (payload.error) throw new Error(payload.error.message || 'MCP error');
  const content = payload.result && payload.result.content && payload.result.content[0];
  if (payload.result && payload.result.isError) throw new Error(content ? content.text : 'tool error');
  return content ? content.text : '';
}

function loadSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch (e) { return {}; }
}

function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

// Agents from the pids file whose processes are still alive.
function liveAgents() {
  const pids = loadPids();
  const alive = [];
  for (const [id, pid] of Object.entries(pids)) {
    if (id === 'mcp') continue;
    try { process.kill(pid, 0); alive.push(id); } catch (e) { /* dead */ }
  }
  return alive;
}

// Give the swarm work. Live swarm -> injected into shared state immediately;
// no live agents -> stored as the round goal for the next `start`.
async function cmdTask(args) {
  const clear = args.includes('--clear');
  const next = args.includes('--next');
  const text = args.filter(a => !a.startsWith('-')).join(' ').trim();

  if (clear) {
    const config = loadConfig();
    delete config.goal;
    const yaml = require('js-yaml');
    fs.writeFileSync(CONFIG_FILE, yaml.dump(config, { lineWidth: 120, noRefs: true }));
    console.log('Round goal cleared.');
    return;
  }

  if (next) {
    if (!text) { console.log('Usage: opencode-swarm task --next "goal for the next round"'); return; }
    const config = loadConfig();
    config.goal = text;
    const yaml = require('js-yaml');
    fs.writeFileSync(CONFIG_FILE, yaml.dump(config, { lineWidth: 120, noRefs: true }));
    console.log(`Goal stored for the next round:\n  ${text}`);
    console.log('Run "opencode-swarm start" to launch a round with this goal heading every agent\'s prompt.');
    return;
  }

  if (!text) {
    console.log('Usage:');
    console.log('  opencode-swarm task "what the swarm should do"   # live swarm: injected now');
    console.log('  opencode-swarm task --next "goal"                # no agents running: queue for next start');
    console.log('  opencode-swarm task --clear                      # remove stored goal');
    return;
  }

  const url = loadServerUrl();
  const alive = liveAgents();

  if (url && alive.length > 0) {
    try {
      const result = await mcpCall(url, 'swarm_propose_task', {
        agent_id: 'operator',
        subtask: text,
        context: 'Issued by the human operator. Any agent may claim this; coordinate with peers.',
      });
      let taskId = '(unknown)';
      try { taskId = JSON.parse(result).task_id || taskId; } catch (e) {}
      await mcpCall(url, 'swarm_broadcast', {
        agent_id: 'operator',
        finding: `Operator objective: ${text}`,
        tags: ['operator', 'goal', 'task'],
      });
      console.log(`Task ${taskId} delivered to ${alive.length} live agent(s): ${alive.join(', ')}`);
      console.log('Agents pick it up on their next swarm_read_context. Watch with: opencode-swarm logs -f');
      return;
    } catch (e) {
      console.log(`Live injection failed (${e.message.split('\n')[0]}). Falling back to next-round goal.`);
    }
  } else if (!url) {
    console.log('MCP server not reachable (no swarm running).');
  } else {
    console.log('No live agents detected (all finished their turns).');
  }

  // Fallback: queue as the goal for the next round
  const config = loadConfig();
  config.goal = text;
  const yaml = require('js-yaml');
  fs.writeFileSync(CONFIG_FILE, yaml.dump(config, { lineWidth: 120, noRefs: true }));
  console.log(`Goal stored for the next round:\n  ${text}`);
  console.log('Run "opencode-swarm start" to launch a round with this goal.');
}

// Direct-message a specific agent's session (works even after its turn ended —
// the session persists in OpenCode; this starts a new turn in it).
async function cmdSay(args) {
  const agentId = args.find(a => !a.startsWith('-'));
  if (!agentId) {
    console.log('Usage: opencode-swarm say <agent-id> "message"');
    console.log('       opencode-swarm say agent-1 "focus on the parser bug"');
    return;
  }
  const msgStart = args.indexOf(agentId) + 1;
  const message = args.slice(msgStart).join(' ').trim();
  if (!message) {
    console.log('Usage: opencode-swarm say <agent-id> "message"');
    return;
  }

  const config = loadConfig();
  const agent = config.agents.find(a => a.id === agentId);
  if (!agent) {
    console.log(`Agent ${agentId} not in roster. Current agents:`);
    config.agents.forEach(a => console.log(`  ${a.id}: ${a.model}`));
    return;
  }

  const sessions = loadSessions();
  const sid = sessions[agentId];
  if (!sid) {
    console.log(`No recorded session for ${agentId}.`);
    console.log('Sessions are recorded by "opencode-swarm start". Recorded: ' + (Object.keys(sessions).join(', ') || 'none'));
    return;
  }

  console.log(`→ ${agentId} (${agent.model}): ${message}\n`);
  const proc = spawnSync('opencode', ['run', '-m', agent.model, '--session', sid, message], {
    stdio: 'inherit',
  });
  if (proc.error) console.error(`Failed to run opencode: ${proc.error.message}`);
}

// The human-in-the-loop inbox: agents' swarm_request_human escalations.
async function cmdInbox() {
  const url = loadServerUrl();
  if (!url) {
    console.log('MCP server not reachable — no live swarm. Run "opencode-swarm start" first.');
    return;
  }
  let raw;
  try {
    raw = await mcpCall(url, 'swarm_read_context', { agent_id: 'operator' });
  } catch (e) {
    console.log(`Could not reach swarm server: ${e.message.split('\n')[0]}`);
    return;
  }
  let state;
  try { state = JSON.parse(raw); } catch (e) { console.log('Unparseable swarm state.'); return; }

  const reqs = state.human_requests || [];
  if (reqs.length === 0) {
    console.log('Inbox empty — no agent has escalated anything.');
  } else {
    console.log(`${reqs.length} request(s) from agents:\n`);
    for (const r of reqs) {
      console.log(`[${r.id}] ${r.agent_id || r.from || '?'}: ${r.question}`);
      if (r.context) console.log(`    context: ${r.context}`);
      console.log(`    answer with: opencode-swarm say ${r.agent_id || r.from || '<agent>'} "your answer"\n`);
    }
  }
  console.log(`(${(state.messages || []).length} messages, ${Object.keys(state.tasks || {}).length} tasks in shared state)`);
}

// ============================================================
// Model Discovery
// ============================================================

function getAvailableModels(providerFilter = null) {
  try {
    const result = spawnSync('opencode', ['models'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (result.status !== 0) {
      console.error('Failed to list models:', result.stderr);
      return {};
    }
    
    const lines = result.stdout.trim().split('\n').filter(l => l && !l.startsWith('DESCRIPTION') && !l.startsWith('USAGE') && !l.startsWith('ERROR'));
    const modelsByProvider = {};
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      // Parse: provider/model or provider/model:variant
      const parts = trimmed.split('/');
      if (parts.length >= 2) {
        const provider = parts[0];
        if (providerFilter && provider !== providerFilter) continue;
        
        if (!modelsByProvider[provider]) modelsByProvider[provider] = [];
        modelsByProvider[provider].push(trimmed);
      }
    }
    
    return modelsByProvider;
  } catch (e) {
    console.error('Error fetching models:', e.message);
    return {};
  }
}

function printModels(modelsByProvider) {
  console.log('\nAvailable models:\n');
  for (const [provider, models] of Object.entries(modelsByProvider)) {
    console.log(`  ${provider} (${models.length} models):`);
    for (const model of models) {
      console.log(`    ${model}`);
    }
    console.log('');
  }
}

// ============================================================
// Interactive Init
// ============================================================

async function selectModelsInteractive() {
  const modelsByProvider = getAvailableModels();
  const providers = Object.keys(modelsByProvider).sort();
  
  if (providers.length === 0) {
    console.log('No models found. Configure providers in OpenCode first.');
    return null;
  }
  
  console.log('\nAvailable providers:');
  providers.forEach((p, i) => console.log(`  ${i + 1}. ${p} (${modelsByProvider[p].length} models)`));
  
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  const question = (q) => new Promise(r => readline.question(q, r));
  
  // How many agents?
  let numAgents = 3;
  const numAns = await question('\nNumber of agents [3]: ');
  if (numAns.trim()) numAgents = parseInt(numAns) || 3;
  
  const agents = [];
  const usedModels = new Set();
  
  for (let i = 0; i < numAgents; i++) {
    console.log(`\n--- Agent ${i + 1} of ${numAgents} ---`);
    
    // Pick provider
    const provAns = await question(`Provider (${providers.join(', ')}) [${providers[0]}]: `);
    const provider = provAns.trim() || providers[0];
    if (!modelsByProvider[provider]) {
      console.log(`Unknown provider: ${provider}`);
      i--;
      continue;
    }
    
    // Show models for this provider
    const models = modelsByProvider[provider].filter(m => !usedModels.has(m));
    console.log(`Models from ${provider}:`);
    models.forEach((m, idx) => console.log(`  ${idx + 1}. ${m}`));
    
    const modelAns = await question(`Select model [1]: `);
    const modelIdx = modelAns.trim() ? parseInt(modelAns) - 1 : 0;
    const model = models[modelIdx] || models[0];
    
    if (!model) {
      console.log('No models available for this provider');
      i--;
      continue;
    }
    
    usedModels.add(model);
    
    // Agent ID (flat, no roles)
    const defaultId = `agent-${i + 1}`;
    const idAns = await question(`Agent ID [${defaultId}]: `);
    const id = idAns.trim() || defaultId;
    
    // No role — all agents are equal peers
    const role = 'Swarm agent';
    
    agents.push({ id, model, role });
  }
  
  readline.close();
  return agents;
}

function generateSystemPrompt(agent, allAgents) {
  const peerIds = allAgents.filter(a => a.id !== agent.id).map(a => a.id).join(', ');
  return `You are ${agent.id} in a ${allAgents.length}-agent swarm.
All agents are equal peers — no fixed roles, no hierarchy.
Peers: ${peerIds}.
Collaborate via swarm.* MCP tools:
- swarm_register("${agent.id}", "${agent.model}", "swarm agent") on startup
- swarm_broadcast(finding, tags?) — share findings with all peers
- swarm_read_context(since?) — see all shared state
- swarm_propose_task(subtask, assignee?, context?) — delegate work
- swarm_claim_task(task_id) — pick up a task
- swarm_complete_task(task_id, result) — mark done
- swarm_vote(proposal_id, choice, reasoning?) — collective decisions
- swarm_propose_vote(question, options?) — start a vote
- swarm_request_human(question, context?) — escalate to operator
- swarm_get_config() — read swarm config`;
}

async function cmdInit(args) {
  ensureDirs();
  const interactive = args.includes('--interactive') || args.includes('-i');
  const nonInteractive = args.includes('--non-interactive') || args.includes('-n');
  
  let agents;
  
  if (interactive || !nonInteractive) {
    // Default to interactive - require explicit configuration
    console.log('=== Swarm Configuration Required ===');
    console.log('A swarm needs at least 2 agents with different models/providers.');
    console.log('Run with --non-interactive for simplified setup.\n');
    agents = await selectModelsInteractive();
    if (!agents) return;
  } else {
    // Non-interactive: show providers and require manual selection (simplified)
    const modelsByProvider = getAvailableModels();
    const providers = Object.keys(modelsByProvider).sort();
    
    if (providers.length === 0) {
      console.log('No models found. Configure providers in OpenCode first.');
      return;
    }
    
    console.log('=== Simplified Swarm Setup ===');
    console.log('Available providers:');
    providers.forEach((p, i) => console.log(`  ${i + 1}. ${p} (${modelsByProvider[p].length} models)`));
    
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const question = (q) => new Promise(r => readline.question(q, r));
    
    let numAgents = 3;
    const numAns = await question('\nNumber of agents [3]: ');
    if (numAns.trim()) numAgents = parseInt(numAns) || 3;
    
    agents = [];
    const usedModels = new Set();
    
    for (let i = 0; i < numAgents; i++) {
      console.log(`\n--- Agent ${i + 1} of ${numAgents} ---`);
      
      const provAns = await question(`Provider (${providers.join(', ')}) [${providers[0]}]: `);
      const provider = provAns.trim() || providers[0];
      if (!modelsByProvider[provider]) {
        console.log(`Unknown provider: ${provider}`);
        i--;
        continue;
      }
      
      const models = modelsByProvider[provider].filter(m => !usedModels.has(m));
      console.log(`Models from ${provider}:`);
      models.slice(0, 10).forEach((m, idx) => console.log(`  ${idx + 1}. ${m}`));
      if (models.length > 10) console.log(`  ... and ${models.length - 10} more`);
      
      const modelAns = await question(`Select model [1]: `);
      const modelIdx = modelAns.trim() ? parseInt(modelAns) - 1 : 0;
      const model = models[modelIdx] || models[0];
      
      if (!model) {
        console.log('No models available for this provider');
        i--;
        continue;
      }
      
      usedModels.add(model);
      const defaultId = `agent-${i + 1}`;
      const idAns = await question(`Agent ID [${defaultId}]: `);
      const id = idAns.trim() || defaultId;
      const role = 'Swarm agent';
      
      agents.push({ id, model, role });
    }
    
    readline.close();
  }
  
  const config = {
    coordination_mode: 'peer_collaboration',
    context_ttl: 'session',
    agents,
    mcp: { host: 'localhost', port: 0 },
    human: {
      approve_on: ['task_completion', 'final_output'],
      notification: 'terminal'
    }
  };
  
  const yaml = require('js-yaml');
  const configYaml = yaml.dump(config, { lineWidth: 120, noRefs: true });
  
  if (fs.existsSync(CONFIG_FILE)) {
    console.log(`Config already exists at ${CONFIG_FILE}`);
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await new Promise(r => readline.question('Overwrite? (y/N): ', r));
    readline.close();
    if (answer.toLowerCase() !== 'y') {
      console.log('Aborted.');
      return;
    }
  }
  
  fs.writeFileSync(CONFIG_FILE, configYaml);
  console.log(`\nCreated ${CONFIG_FILE}`);
  console.log('\nAgents configured:');
  for (const a of agents) {
    console.log(`  ${a.id}: ${a.model} — ${a.role}`);
  }
  console.log('\nRun "opencode-swarm start" to launch the swarm.');
}

async function cmdModels(args) {
  const providerIdx = args.indexOf('--provider');
  const providerFilter = args.find(a => a.startsWith('--provider='))?.split('=')[1] 
    || (providerIdx >= 0 ? args[providerIdx + 1] : undefined);
  const freeOnly = args.includes('--free') || args.includes('-f');
  
  const modelsByProvider = getAvailableModels(providerFilter);
  
  if (Object.keys(modelsByProvider).length === 0) {
    console.log(providerFilter 
      ? `No models found for provider: ${providerFilter}`
      : 'No models found. Configure providers in OpenCode first.');
    return;
  }
  
  if (freeOnly) {
    for (const [provider, models] of Object.entries(modelsByProvider)) {
      modelsByProvider[provider] = models.filter(m => m.includes(':free'));
    }
    // Remove empty providers
    for (const provider of Object.keys(modelsByProvider)) {
      if (modelsByProvider[provider].length === 0) {
        delete modelsByProvider[provider];
      }
    }
  }
  
  printModels(modelsByProvider);
  
  // Summary
  const total = Object.values(modelsByProvider).reduce((sum, m) => sum + m.length, 0);
  console.log(`Total: ${total} models across ${Object.keys(modelsByProvider).length} provider(s)${freeOnly ? ' (free only)' : ''}`);
}

async function cmdAdd(args) {
  const config = loadConfig();
  const modelsByProvider = getAvailableModels();
  const providers = Object.keys(modelsByProvider).sort();
  
  if (providers.length === 0) {
    console.log('No models found. Configure providers in OpenCode first.');
    return;
  }
  
  // Parse args: opencode-swarm add --id agent-4 --model openrouter/nemotron-3-ultra:free
  const idIdx = args.indexOf('--id');
  const modelIdx = args.indexOf('--model');
  const roleIdx = args.indexOf('--role');
  
  const idArg = args.find(a => a.startsWith('--id='))?.split('=')[1] || (idIdx >= 0 ? args[idIdx + 1] : undefined);
  const modelArg = args.find(a => a.startsWith('--model='))?.split('=')[1] || (modelIdx >= 0 ? args[modelIdx + 1] : undefined);
  const roleArg = args.find(a => a.startsWith('--role='))?.split('=')[1] || (roleIdx >= 0 ? args[roleIdx + 1] : undefined);
  
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const question = (q) => new Promise(r => readline.question(q, r));
  
  let agentId = idArg;
  if (!idArg) {
    const defaultId = `agent-${config.agents.length + 1}`;
    const ans = await question(`Agent ID [${defaultId}]: `);
    agentId = ans.trim() || defaultId;
  }
  
  // Check if ID already exists
  if (config.agents.some(a => a.id === agentId)) {
    console.log(`Agent ${agentId} already exists.`);
    readline.close();
    return;
  }
  
  let model = modelArg;
  if (!model) {
    console.log('\nAvailable providers:');
    providers.forEach((p, i) => console.log(`  ${i + 1}. ${p} (${modelsByProvider[p].length} models)`));
    const provAns = await question('\nProvider: ');
    const provider = provAns.trim();
    if (!modelsByProvider[provider]) {
      console.log(`Unknown provider: ${provider}`);
      readline.close();
      return;
    }
    
    const models = modelsByProvider[provider];
    console.log(`Models from ${provider}:`);
    models.forEach((m, idx) => console.log(`  ${idx + 1}. ${m}`));
    
    const modelAns = await question('Select model [1]: ');
    const modelIdx = modelAns.trim() ? parseInt(modelAns) - 1 : 0;
    model = models[modelIdx] || models[0];
  }
  
  let role = roleArg || 'Swarm agent';
  
  // Generate system prompt
  const newAgent = { id: agentId, model, role };
  const allAgents = [...config.agents, newAgent];
  newAgent.system_prompt = generateSystemPrompt(newAgent, allAgents);
  
  config.agents.push(newAgent);
  
  const yaml = require('js-yaml');
  fs.writeFileSync(CONFIG_FILE, yaml.dump(config, { lineWidth: 120, noRefs: true }));
  
  console.log(`\nAdded ${agentId}: ${model} — ${role}`);
  readline.close();
}

async function cmdRemove(args) {
  const config = loadConfig();
  
  if (config.agents.length <= 1) {
    console.log('Cannot remove: swarm needs at least 1 agent.');
    return;
  }
  
  // Parse args: opencode-swarm remove agent-2
  const targetId = args.find(a => !a.startsWith('-'));
  
  let agentId = targetId;
  if (!agentId) {
    console.log('\nCurrent agents:');
    config.agents.forEach((a, i) => console.log(`  ${i + 1}. ${a.id}: ${a.model}`));
    
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const ans = await new Promise(r => readline.question('\nAgent ID to remove: ', r));
    readline.close();
    agentId = ans.trim();
  }
  
  const idx = config.agents.findIndex(a => a.id === agentId);
  if (idx === -1) {
    console.log(`Agent ${agentId} not found.`);
    return;
  }
  
  const removed = config.agents.splice(idx, 1)[0];
  
  // Regenerate system prompts for remaining agents (peer list changed)
  for (const agent of config.agents) {
    agent.system_prompt = generateSystemPrompt(agent, config.agents);
  }
  
  const yaml = require('js-yaml');
  fs.writeFileSync(CONFIG_FILE, yaml.dump(config, { lineWidth: 120, noRefs: true }));
  
  console.log(`\nRemoved ${removed.id}: ${removed.model}`);
}

async function cmdList() {
  const config = loadConfig();
  console.log('\nCurrent swarm agents:');
  for (const a of config.agents) {
    console.log(`  ${a.id}: ${a.model} — ${a.role}`);
  }
}

async function cmdStart(args = []) {
  const forceDetached = args.includes('--detached') || args.includes('-d');
  const attach = args.includes('--attach') || args.includes('-a');
  const config = loadConfig();
  const dirs = ensureDirs();
  
  // tmux is the default when available — each agent gets its own visible pane.
  const useTmux = !forceDetached && tmuxAvailable();
  if (!useTmux && !forceDetached && !tmuxAvailable()) {
    console.log('tmux not found — falling back to detached (log-file) mode.');
  }
  
  if (useTmux && attach) {
    // Just reattach to an existing swarm session.
    const name = tmuxSessionName();
    const has = spawnSync('tmux', ['has-session', '-t', name]).status === 0;
    if (!has) { console.log(`No tmux swarm session "${name}". Run "opencode-swarm start" first.`); return; }
    process.stdout.write('\n');
    spawnSync('tmux', ['attach-session', '-t', name], { stdio: 'inherit' });
    return;
  }
  
  console.log(`Starting swarm with ${config.agents.length} agents${useTmux ? ' (tmux panes)' : ' (detached)'}...`);
  
  // Clean slate: stray agents from earlier runs would otherwise answer this round's tasks.
  killStraySwarmProcesses();
  await new Promise(r => setTimeout(r, 800));
  
  // Find an available port for MCP server
  const mcpPort = await findAvailablePort(8765);
  console.log(`  MCP server port: ${mcpPort}`);
  
  // Update config with actual MCP port
  config.mcp = { host: 'localhost', port: mcpPort };
  const yaml = require('js-yaml');
  fs.writeFileSync(CONFIG_FILE, yaml.dump(config, { lineWidth: 120, noRefs: true }));
  
  // NOTE: must run server.py directly — `python -m mcp.server` resolves to the
  // installed mcp SDK's stdio server, not this skill's server.
  const pythonCmd = spawnSync('which', ['python3']).status === 0 ? 'python3' : 'python';
  const mcpDir = path.join(__dirname, '..', 'mcp');
  const serverPath = path.join(mcpDir, 'server.py');
  const mcpLogStream = fs.createWriteStream(path.join(dirs.logDir, 'mcp.log'), { flags: 'a' });
  await new Promise((resolve, reject) => {
    mcpLogStream.on('open', resolve);
    mcpLogStream.on('error', reject);
  });
  
  const mcpProc = spawn(pythonCmd, ['-u', serverPath, '--port', String(mcpPort)], {
    cwd: mcpDir,
    detached: true,
    stdio: ['ignore', mcpLogStream, mcpLogStream],
  });
  mcpProc.unref();
  mcpLogStream.end(); // child holds its own fd now; release our handle
  
  // Give MCP server a moment to start, then verify it is listening
  await new Promise(r => setTimeout(r, 2000));
  const mcpUp = await new Promise((resolve) => {
    const net = require('net');
    const sock = net.connect(mcpPort, '127.0.0.1');
    sock.on('connect', () => { sock.end(); resolve(true); });
    sock.on('error', () => resolve(false));
    setTimeout(() => { sock.destroy(); resolve(false); }, 2000);
  });
  if (!mcpUp) {
    console.error(`  WARNING: MCP server did not open port ${mcpPort} — check ${dirs.logDir}/mcp.log`);
  }
  
  // Point OpenCode at the running MCP server so agents get swarm.* tools.
  // Writes project-level opencode.json (merged), and updates the global
  // swarm entry if one exists (keeps sidebar/connection info accurate).
  const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;
  writeMcpConfig(process.cwd(), mcpUrl);
  try {
    const globalConfig = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
    if (fs.existsSync(globalConfig)) {
      const g = JSON.parse(fs.readFileSync(globalConfig, 'utf8'));
      if (g.mcp && g.mcp.servers && g.mcp.servers.swarm) {
        g.mcp.servers.swarm = { type: 'remote', url: mcpUrl };
        fs.writeFileSync(globalConfig, JSON.stringify(g, null, 2) + '\n');
      }
    }
  } catch (e) { /* global config update is best-effort */ }
  console.log(`  MCP: ${mcpUrl}`);
  
  const pids = { mcp: mcpProc.pid };
  const sessions = loadSessions();
  const agents = config.agents;
  
  // Fresh session IDs per round (stable per agent, recorded for `say`).
  const roundTs = Date.now();
  for (const agent of agents) {
    sessions[agent.id] = `ses-swarm-${agent.id}-${roundTs}`;
  }
  
  if (useTmux) {
    startTmuxSwarm(config, agents, sessions, dirs, pythonCmd, serverPath, mcpDir, mcpPort, attach);
  } else {
    for (const agent of agents) {
      const logFile = path.join(dirs.logDir, `${agent.id}.log`);
      const logStream = fs.createWriteStream(logFile, { flags: 'a' });
      
      // Ensure stream is ready
      await new Promise((resolve, reject) => {
        logStream.on('open', resolve);
        logStream.on('error', reject);
      });
      
      // Stored round goal (set via `opencode-swarm task --next "..."`) heads every prompt
      const goalPrefix = config.goal ? `ROUND GOAL from the operator — top priority:\n${config.goal}\n\n` : '';
      const prompt = `${goalPrefix}${agent.system_prompt}\n\nSwarm config: ${JSON.stringify(config, null, 2)}\n\nConnect to the MCP server and start collaborating.`;
      
      const proc = spawn('opencode', [
        'run',
        '-m', agent.model,
        '--session', sessions[agent.id],
        prompt
      ], {
        detached: true,
        stdio: ['ignore', logStream, logStream],
      });
      
      pids[agent.id] = proc.pid;
      proc.unref();
      logStream.end(); // child holds its own fd now; release our handle
      console.log(`  Started ${agent.id} (${agent.model}) -> PID ${proc.pid}, log: ${logFile}`);
    }
  }
  
  savePids(pids);
  saveSessions(sessions);
  if (config.goal) console.log(`Round goal: ${config.goal}`);
  if (useTmux) {
    console.log('\nSwarm running in tmux. Each pane = one agent (Ctrl-b n / Ctrl-b p to switch).');
    console.log('Press [Enter] in a pane to give that agent another round; Ctrl-C stops that agent.');
  } else {
    console.log('\nSwarm started. Use "opencode-swarm status" to check state.');
    console.log(`Logs in ${dirs.logDir}/`);
  }
}

// Build the tmux session: pane 0 = MCP server + live broadcast tail, one pane per agent.
function startTmuxSwarm(config, agents, sessions, dirs, pythonCmd, serverPath, mcpDir, mcpPort, attach) {
  const name = tmuxSessionName();
  const stmux = (args, opts = {}) => spawnSync('tmux', args, { encoding: 'utf8', ...opts });
  
  // Replace any existing session of the same name.
  if (stmux(['has-session', '-t', name]).status === 0) {
    stmux(['kill-session', '-t', name]);
  }
  
  writeRunnerScript();
  writePromptFiles(config, agents);
  
  const cwd = process.cwd();
  const monitorPath = path.resolve(SWARM_DIR, 'swarm-monitor.py');
  writeMonitorScript(mcpPort);
  const broadcastTail = `while true; do ${pythonCmd} ${JSON.stringify(monitorPath)}; sleep 5; done`;
  
  // Pane 0: MCP server (+ broadcast monitor), started detached from this shell.
  stmux(['new-session', '-d', '-s', name, '-c', cwd,
    `cd ${JSON.stringify(mcpDir)} && ${pythonCmd} -u server.py --port ${mcpPort}; echo '[MCP server stopped]'; exec bash`]);
  
  // Pane 0 becomes the broadcast monitor in a second window.
  stmux(['new-window', '-t', name, '-n', 'broadcast', '-c', cwd, broadcastTail]);
  
  // Layout: grid (tiled) across the agents window.
  for (const agent of agents) {
    // tmux treats ":" and "." in window names as target separators — keep names plain
    const paneName = agent.id.replace(/[^a-zA-Z0-9_-]/g, '');
    stmux(['new-window', '-t', name, '-n', paneName, '-c', cwd,
      `./${RUNNER_FILE} ${agent.id} ${JSON.stringify(agent.model)} ${sessions[agent.id]} ${JSON.stringify(path.resolve(PROMPT_DIR, agent.id + '.txt'))} ${JSON.stringify(path.resolve(dirs.logDir, agent.id + '.log'))}`]);
    console.log(`  Pane window "${agent.id}" (${agent.model})`);
  }
  
  // Start on the broadcast window so the operator sees the collaboration first.
  stmux(['select-window', '-t', `${name}:broadcast`]);
  
  if (attach) {
    process.stdout.write('\n');
    spawnSync('tmux', ['attach-session', '-t', name], { stdio: 'inherit' });
  } else {
    console.log(`\nAttach with: tmux attach -t ${name}`);
  }
}

async function cmdStop() {
  const name = tmuxSessionName();
  const hasTmux = tmuxAvailable() && spawnSync('tmux', ['has-session', '-t', name]).status === 0;
  
  if (hasTmux) {
    spawnSync('tmux', ['kill-session', '-t', name]);
    console.log(`Stopped tmux swarm session "${name}".`);
  }
  
  // Also cover detached mode / stray processes.
  killStraySwarmProcesses();
  
  if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  if (!hasTmux) {
    console.log('Swarm stopped.');
  } else {
    console.log('All agent and MCP processes for this project terminated.');
  }
}

async function cmdStatus() {
  const config = loadConfig();
  const pids = loadPids();
  const sessions = loadSessions();
  const name = tmuxSessionName();
  const hasTmux = tmuxAvailable() && spawnSync('tmux', ['has-session', '-t', name]).status === 0;
  
  console.log(`Swarm: ${config.agents.length} agents configured`);
  console.log(hasTmux
    ? `Mode: tmux session "${name}" — attach: tmux attach -t ${name}`
    : `Mode: ${liveAgents().length ? 'detached (running)' : 'not running'}`);
  if (config.goal) console.log(`Round goal: ${config.goal}`);
  console.log('');
  
  console.log('Agents:');
  for (const agent of config.agents) {
    const sid = sessions[agent.id];
    const working = agentTurnRunning(sid);
    const pid = pids[agent.id];
    const detachedAlive = pid && isProcessRunning(pid);
    const state = working || detachedAlive ? '🟢 working' : (sid ? '⚪ idle (session kept)' : '🔴 no session');
    console.log(`  ${agent.id}: ${agent.model} ${state}`);
  }
  
  const url = loadServerUrl();
  if (url) {
    try {
      const raw = await mcpCall(url, 'swarm_read_context', { agent_id: 'status' });
      const st = JSON.parse(raw);
      console.log(`\nShared state: ${(st.messages || []).length} messages, ${Object.keys(st.tasks || {}).length} tasks, ${(st.human_requests || []).length} escalations`);
    } catch (e) {
      console.log('\n(MCP server unreachable — swarm may be shutting down)');
    }
  }
  console.log('\n"opencode-swarm inbox" for escalations · "opencode-swarm logs -f" for the feed');
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cmdLogs(args) {
  const follow = args.includes('--follow') || args.includes('-f');
  const logFiles = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log'));
  
  if (logFiles.length === 0) {
    console.log('No log files found. Start the swarm first.');
    return;
  }
  
  if (follow) {
    const { spawn } = require('child_process');
    const tail = spawn('tail', ['-f', ...logFiles.map(f => path.join(LOG_DIR, f))], { stdio: 'inherit' });
    tail.on('exit', () => process.exit(0));
    process.on('SIGINT', () => tail.kill());
  } else {
    for (const file of logFiles) {
      console.log(`\n=== ${file} ===`);
      const content = fs.readFileSync(path.join(LOG_DIR, file), 'utf8');
      const lines = content.trim().split('\n').slice(-50);
      console.log(lines.join('\n'));
    }
  }
}

// Main
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'init':
    cmdInit(args.slice(1)).catch(e => { console.error(e); process.exit(1); });
    break;
  case 'models':
    cmdModels(args.slice(1)).catch(e => { console.error(e); process.exit(1); });
    break;
  case 'add':
    cmdAdd(args.slice(1)).catch(e => { console.error(e); process.exit(1); });
    break;
  case 'remove':
    cmdRemove(args.slice(1)).catch(e => { console.error(e); process.exit(1); });
    break;
  case 'list':
    cmdList().catch(e => { console.error(e); process.exit(1); });
    break;
  case 'start':
    cmdStart(args.slice(1)).catch(e => { console.error(e); process.exit(1); });
    break;
  case 'stop':
    cmdStop().catch(e => { console.error(e); process.exit(1); });
    break;
  case 'status':
    cmdStatus().catch(e => { console.error(e); process.exit(1); });
    break;
  case 'logs':
    cmdLogs(args.slice(1)).catch(e => { console.error(e); process.exit(1); });
    break;
  case 'task':
    cmdTask(args.slice(1)).catch(e => { console.error(e); process.exit(1); });
    break;
  case 'say':
    cmdSay(args.slice(1)).catch(e => { console.error(e); process.exit(1); });
    break;
  case 'inbox':
    cmdInbox().catch(e => { console.error(e); process.exit(1); });
    break;
  default:
    printUsage();
    process.exit(1);
}