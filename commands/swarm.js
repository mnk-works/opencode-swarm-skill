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
const LOG_DIR = path.join(SWARM_DIR, 'swarm-logs');

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
  start                                           Launch all agents
  stop                                            Stop all swarm agents
  status                                          Show agent status and activity
  logs [--follow]                                 Show recent broadcasts

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
  opencode-swarm start
  opencode-swarm status
  opencode-swarm logs -f
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

async function cmdStart() {
  const config = loadConfig();
  const dirs = ensureDirs();
  
  console.log(`Starting swarm with ${config.agents.length} agents...`);
  
  // Find an available port for MCP server
  const mcpPort = await findAvailablePort(8765);
  console.log(`  MCP server port: ${mcpPort}`);
  
  // Update config with actual MCP port
  config.mcp = { host: 'localhost', port: mcpPort };
  const yaml = require('js-yaml');
  fs.writeFileSync(CONFIG_FILE, yaml.dump(config, { lineWidth: 120, noRefs: true }));
  
  // Start MCP server (SSE) on the chosen port.
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
    const os = require('os');
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
  const agents = config.agents;
  
  for (const agent of agents) {
    const logFile = path.join(dirs.logDir, `${agent.id}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    
    // Ensure stream is ready
    await new Promise((resolve, reject) => {
      logStream.on('open', resolve);
      logStream.on('error', reject);
    });
    
    const prompt = `${agent.system_prompt}\n\nSwarm config: ${JSON.stringify(config, null, 2)}\n\nConnect to the MCP server and start collaborating.`;
    
    // Generate a valid session ID (must start with "ses")
    const sessionId = `ses-swarm-${agent.id}-${Date.now()}`;
    
    const proc = spawn('opencode', [
      'run',
      '-m', agent.model,
      '--session', sessionId,
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
  
  savePids(pids);
  console.log('\nSwarm started. Use "opencode-swarm status" to check state.');
  console.log(`Logs in ${dirs.logDir}/`);
}

async function cmdStop() {
  const pids = loadPids();
  if (Object.keys(pids).length === 0) {
    console.log('No running swarm found.');
    return;
  }
  
  console.log('Stopping swarm...');
  for (const [name, pid] of Object.entries(pids)) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`  Stopped ${name} (PID ${pid})`);
    } catch (e) {
      console.log(`  Failed to stop ${name} (PID ${pid}): ${e.message}`);
    }
  }
  
  fs.unlinkSync(PID_FILE);
  console.log('Swarm stopped.');
}

async function cmdStatus() {
  const config = loadConfig();
  const pids = loadPids();
  
  console.log(`Swarm: ${config.agents.length} agents configured\n`);
  
  console.log('Agents:');
  for (const agent of config.agents) {
    const pid = pids[agent.id];
    const running = pid && isProcessRunning(pid);
    console.log(`  ${agent.id}: ${agent.model} ${running ? `🟢 PID ${pid}` : '🔴 stopped'}`);
    console.log(`    Role: ${agent.role}`);
  }
  
  console.log('\n(Use "opencode-swarm logs" to see broadcast messages)');
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
    cmdStart().catch(e => { console.error(e); process.exit(1); });
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
  default:
    printUsage();
    process.exit(1);
}