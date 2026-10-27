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
  init [--interactive|-i] [--non-interactive|-n]  Create .opencode/swarm.yaml (interactive by default)
  models [--provider X]    List available models grouped by provider
  start                    Launch all agents (background processes with logs)
  stop                     Stop all running swarm agents
  status                   Show registered agents and recent activity
  logs [--follow]          Show recent broadcast messages

EXAMPLES
  opencode-swarm init                    # Interactive setup (default)
  opencode-swarm init -i                 # Interactive setup (explicit)
  opencode-swarm init -n                 # Auto-detect with confirmation
  opencode-swarm models                  # See all available models
  opencode-swarm models -p openrouter    # Filter by provider
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
    console.log('Run with --non-interactive to accept auto-detected defaults.\n');
    agents = await selectModelsInteractive();
    if (!agents) return;
  } else {
    // Non-interactive: auto-detect and confirm
    const modelsByProvider = getAvailableModels();
    const nemotronModels = {};
    
    for (const [provider, models] of Object.entries(modelsByProvider)) {
      for (const model of models) {
        if (model.toLowerCase().includes('nemotron')) {
          nemotronModels[provider] = model;
          break;
        }
      }
    }
    
    const providers = Object.keys(nemotronModels);
    if (providers.length >= 3) {
      agents = [
        { id: 'agent-1', model: nemotronModels[providers[0]], role: 'Swarm agent' },
        { id: 'agent-2', model: nemotronModels[providers[1]], role: 'Swarm agent' },
        { id: 'agent-3', model: nemotronModels[providers[2]], role: 'Swarm agent' },
      ];
    } else {
      const allModels = [];
      for (const [provider, models] of Object.entries(modelsByProvider)) {
        if (models.length > 0) allModels.push({ provider, model: models[0] });
      }
      agents = allModels.slice(0, 3).map((m, i) => ({
        id: `agent-${i + 1}`,
        model: m.model,
        role: 'Swarm agent'
      }));
    }
    
    // Show what we're about to create and require confirmation
    console.log('Auto-detected swarm configuration:');
    for (const a of agents) {
      console.log(`  ${a.id}: ${a.model}`);
    }
    
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await new Promise(r => readline.question('\nAccept this configuration? (y/N): ', r));
    readline.close();
    if (answer.toLowerCase() !== 'y') {
      console.log('Aborted. Run with --interactive to choose manually.');
      return;
    }
  }
  
  // Generate system prompts
  for (const agent of agents) {
    agent.system_prompt = generateSystemPrompt(agent, agents);
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
  const providerFilter = args.find(a => a.startsWith('--provider='))?.split('=')[1] 
    || args[args.indexOf('--provider') + 1];
  
  const modelsByProvider = getAvailableModels(providerFilter);
  
  if (Object.keys(modelsByProvider).length === 0) {
    console.log(providerFilter 
      ? `No models found for provider: ${providerFilter}`
      : 'No models found. Configure providers in OpenCode first.');
    return;
  }
  
  printModels(modelsByProvider);
  
  // Summary
  const total = Object.values(modelsByProvider).reduce((sum, m) => sum + m.length, 0);
  console.log(`Total: ${total} models across ${Object.keys(modelsByProvider).length} provider(s)`);
}

async function cmdStart() {
  const config = loadConfig();
  const dirs = ensureDirs();
  
  console.log(`Starting swarm with ${config.agents.length} agents...`);
  
  // Start MCP server (in background)
  const pythonCmd = spawnSync('which', ['python3']).status === 0 ? 'python3' : 'python';
  const mcpProc = spawn(pythonCmd, ['-m', 'mcp.server'], {
    cwd: path.join(__dirname, '..', 'mcp'),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  
  // Give MCP server a moment to start
  await new Promise(r => setTimeout(r, 1000));
  
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