# Alchemy ⚗️

**ML job orchestration CLI for remote Slurm clusters.**

Alchemy manages the full lifecycle of ML training jobs on HPC clusters: submit, monitor, analyze metrics, and chain jobs into dependency graphs — all from your local machine via SSH.

## Features

- **SSH tunneling** — connects through jump hosts to private compute clusters
- **Job chains** — sequential, parallel, conditional, and hyperparameter sweep pipelines
- **Live dashboard** — web UI with job table, chain progress bars, log viewer
- **Webhook callbacks** — injected `curl` in sbatch scripts notifies on completion
- **Metric extraction** — automatic parsing of training metrics from log output
- **Discord notifications** — start/complete/fail alerts with traceback excerpts
- **Plugin architecture** — extensible executors, notifiers, analyzers, strategies

## Installation

```bash
npm install -g @bkmashiro/alchemy
# or locally:
git clone https://github.com/bkmashiro/alchemy
cd alchemy && npm install && npm run build
npm link
```

## Quick Start

### 1. Create a config file

```bash
mkdir -p ~/.alchemy
cp config/default.yaml ~/.alchemy/config.yaml
# Edit ~/.alchemy/config.yaml with your cluster details
```

Minimum required fields:

```yaml
executor:
  type: slurm_ssh
  jumpHost: shell2          # your SSH jump host alias
  computeHost: gpucluster2  # compute node reachable from jump host
  user: username
  projectRoot: /path/to/project
  logDir: /path/to/logs
  condaEnvBin: /path/to/conda/env/bin

notifiers:
  - type: discord_webhook
    url: https://discord.com/api/webhooks/XXX/YYY

webhook:
  port: 3457
  publicUrl: https://your-tunnel.ngrok.io  # ngrok or similar

registry:
  path: ~/.alchemy/registry.db
```

### 2. Start the webhook receiver

In a terminal with a tunnel (e.g., `ngrok http 3457`):

```bash
alchemy webhook --port 3457
```

### 3. Submit a job

**Quick submit (no YAML):**
```bash
alchemy run "python train.py --lr 0.001" --name train_run1 --partition a30 --time 04:00:00 --mem 32G
```

**From a YAML file:**
```bash
alchemy submit my_job.yaml
```

Example YAML (`my_job.yaml`):
```yaml
version: "1"
job:
  name: train_minigrid
  command: "python train.py --config configs/minigrid.yaml --lr 1e-4"
  resources:
    partition: a30
    time: "04:00:00"
    mem: 32G
    gpus: 1
  tags: [training, minigrid]
```

### 4. Monitor jobs

```bash
alchemy ls                    # list recent jobs
alchemy ls --running          # running jobs only
alchemy status abc123         # detailed status for a job or chain
alchemy logs abc123 --tail 50 # fetch log output
```

### 5. Open the web dashboard

```bash
alchemy dashboard --port 3456
# Open http://localhost:3456
```

## CLI Reference

### `alchemy submit <yaml-file>`

Submit a job or chain from a YAML file.

```bash
alchemy submit job.yaml
alchemy submit chain.yaml --dry-run   # validate only
alchemy submit job.yaml --watch       # poll until done
```

### `alchemy run "<command>" [options]`

Quick single-job submission without a YAML file.

| Flag | Default | Description |
|------|---------|-------------|
| `-n, --name <name>` | auto | Job name |
| `-p, --partition <part>` | `t4` | Slurm partition |
| `-t, --time <HH:MM:SS>` | `01:00:00` | Wall time limit |
| `-m, --mem <mem>` | `16G` | Memory |
| `-g, --gpus <n>` | `1` | Number of GPUs |
| `--cpus <n>` | — | CPUs per task |
| `-e, --env <K=V>` | — | Extra env var (repeatable) |
| `--tag <tag>` | — | Tag (repeatable) |
| `--dry-run` | — | Print spec without submitting |

```bash
alchemy run "python train.py" -n my_job -p a30 -t 02:00:00 -m 32G
alchemy run "python eval.py" -e CUDA_VISIBLE_DEVICES=0 --tag eval
```

### `alchemy status [id]`

Show job/chain status or overall summary.

```bash
alchemy status             # overall summary
alchemy status abc123      # specific job or chain (prefix match)
alchemy status --json      # JSON output
```

**Example output:**
```
Job: train_baseline (job#232021)
Status: ✅ completed  Elapsed: 4h 12m
Partition: a30  Node: gpunode03
Metrics: val_acc=0.7300  train_loss=1.8700
```

### `alchemy ls [options]`

List jobs or chains.

```bash
alchemy ls                    # last 20 jobs
alchemy ls --running          # running jobs
alchemy ls --failed           # failed jobs
alchemy ls --chains           # list chains
alchemy ls --tag training     # filter by tag
alchemy ls --limit 50 --all   # more results
alchemy ls --json             # JSON output
```

### `alchemy logs <job-id> [options]`

Fetch job log output from the cluster.

```bash
alchemy logs abc123            # last 50 lines
alchemy logs abc123 --tail 200 # last 200 lines
alchemy logs abc123 --follow   # poll every 2s while running
```

### `alchemy cancel <id> [options]`

Cancel a running job or all jobs in a chain.

```bash
alchemy cancel abc123          # prompts for confirmation
alchemy cancel abc123 --force  # no prompt
```

### `alchemy dashboard [options]`

Start the web dashboard server.

```bash
alchemy dashboard              # default port 3456
alchemy dashboard --port 8080
# Open http://localhost:3456
```

Dashboard features:
- Live job table with status badges (auto-refreshes every 3s)
- Chain cards with progress bars
- Click any job row to view logs in a side panel
- Submit Job button → YAML editor → POST /api/submit

### `alchemy webhook [options]`

Start the webhook receiver for job completion callbacks.

```bash
alchemy webhook                # default port 3457
alchemy webhook --port 3457
```

The webhook URL is injected into sbatch scripts as a `curl` call that fires on job EXIT.

## YAML Job File Format

All YAML files must have `version: "1"` and either a `job:` or `chain:` key.

### Single Job

```yaml
version: "1"
job:
  name: train_model          # [a-zA-Z0-9_-], used as --job-name
  command: "python train.py --lr 1e-4"
  resources:
    partition: a30           # Slurm partition
    time: "04:00:00"         # HH:MM:SS wall clock limit
    mem: 32G                 # Memory
    gpus: 1                  # GPU count
    cpusPerTask: 4           # Optional
    env:                     # Optional env vars
      MY_VAR: value
  workingDir: /path/on/cluster  # Optional, defaults to projectRoot
  tags: [training, lr_search]
```

### Sequential Chain

```yaml
version: "1"
chain:
  name: train_then_eval
  strategy: sequential
  failFast: true
  steps:
    - stepId: train
      job:
        name: train_mg
        command: "python train.py"
        resources: { partition: a30, time: "04:00:00", mem: 32G, gpus: 1 }

    - stepId: eval
      dependsOn: [train]
      condition: "status == 'completed'"
      job:
        name: eval_mg
        command: "python eval.py"
        resources: { partition: t4, time: "00:30:00", mem: 16G, gpus: 1 }
```

### Conditional Chain

Steps only run if their `condition` evaluates to true against the parent job's metrics:

```yaml
condition: "metrics.val_acc > 0.85"
condition: "metrics.train_loss < 0.1 && metrics.epoch >= 50"
condition: "status == 'completed'"
```

### Hyperparameter Sweep

```yaml
version: "1"
chain:
  name: lr_sweep
  strategy: sweep
  maxConcurrent: 4
  sweepGrid:
    lr: [0.001, 0.0003, 0.0001, 0.00003]
    batch_size: [32, 64]
  sweepBaseJob:
    name: "sweep_lr{{lr}}_bs{{batch_size}}"
    command: "python train.py --lr {{lr}} --batch-size {{batch_size}}"
    resources: { partition: a30, time: "02:00:00", mem: 32G, gpus: 1 }
```

## Dashboard API

The dashboard exposes a REST API on `http://localhost:3456`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/summary` | GET | Job counts by status |
| `/api/jobs` | GET | List jobs (`?status=running&limit=50`) |
| `/api/jobs/:id` | GET | Job detail + events |
| `/api/jobs/:id/logs` | GET | Log output (`?tail=50`) |
| `/api/jobs/:id/cancel` | POST | Cancel a job |
| `/api/chains` | GET | List chains |
| `/api/chains/:id` | GET | Chain detail + jobs |
| `/api/submit` | POST | Submit job/chain from YAML (`{ yaml: string }`) |

## Architecture

```
alchemy/
├── src/
│   ├── core/           # Types, registry (SQLite), config, orchestrator
│   ├── executors/      # SlurmSSH, Local
│   ├── notifiers/      # Discord webhook
│   ├── analyzers/      # Metrics extractor, auto-submit
│   ├── strategies/     # Sequential, parallel, conditional, sweep
│   ├── cli/            # Commander.js commands + formatting
│   ├── dashboard/      # Fastify server + vanilla JS SPA
│   └── webhook/        # Webhook receiver server
├── config/
│   ├── default.yaml         # Example config
│   └── example-chain.yaml   # Example chain YAML
└── README.md
```

**Key flows:**

1. `alchemy submit job.yaml` → Orchestrator → SlurmSSHExecutor → sbatch on cluster
2. Job runs → EXIT trap fires → `curl` to webhook server → Orchestrator.handleWebhookEvent
3. Orchestrator: fetch logs → analyze metrics → notify Discord → advance chain
4. Dashboard polls `/api/jobs` + `/api/chains` every 3s → re-renders table

## Configuration Reference

See `config/default.yaml` for the full annotated configuration file.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `executor.type` | `slurm_ssh` \| `local` | — | Executor backend |
| `executor.jumpHost` | string | — | SSH jump host |
| `executor.computeHost` | string | — | Compute cluster hostname |
| `executor.user` | string | — | SSH username |
| `executor.projectRoot` | string | — | Working directory on cluster |
| `executor.logDir` | string | — | Log output directory on cluster |
| `executor.condaEnvBin` | string | — | Conda/venv bin path |
| `webhook.port` | number | `3457` | Webhook server port |
| `webhook.publicUrl` | string | — | Public URL for cluster callbacks |
| `webhook.secret` | string | — | HMAC secret (optional) |
| `dashboard.port` | number | `3456` | Dashboard server port |
| `registry.path` | string | `~/.alchemy/registry.db` | SQLite database path |

## Requirements

- Node.js >= 20
- SSH access to jump host with agent forwarding or key file
- ngrok, Cloudflare Tunnel, or similar for public webhook URL
- Python 3 on the cluster (for webhook notification scripts)

## License

MIT
