// src/dashboard/public/app.js
// Vanilla JS dashboard client — no framework, no build step.

'use strict';

const API_BASE = '';
const POLL_INTERVAL = 3000;

// ─── State ───────────────────────────────────────────────────

let currentFilter = 'all';
let selectedJobId = null;
let logPollTimer = null;
let allJobsCache = [];
let allChainsCache = [];
let gpuPollTimer = null;
let currentPage = 0;
const PAGE_SIZE = 30;
const progressCache = {}; // jobId → { percent, eta, step, total }

// ─── DOM References ──────────────────────────────────────────

const statRunning    = document.getElementById('stat-running');
const statPending    = document.getElementById('stat-pending');
const statCompleted  = document.getElementById('stat-completed');
const statFailed     = document.getElementById('stat-failed');
const connectionStatus = document.getElementById('connection-status');
const chainsList     = document.getElementById('chains-list');
const jobsTbody      = document.getElementById('jobs-tbody');
const logPanel       = document.getElementById('log-panel');
const logContent     = document.getElementById('log-content');
const logJobName     = document.getElementById('log-job-name');
const logClose       = document.getElementById('log-close');
const logRefreshBtn  = document.getElementById('log-refresh-btn');
const logCopyBtn     = document.getElementById('log-copy-btn');
const logStatus      = document.getElementById('log-status');
const submitModal    = document.getElementById('submit-modal');
const yamlEditor     = document.getElementById('yaml-editor');
const submitBtn      = document.getElementById('submit-btn');
const cancelModalBtn = document.getElementById('cancel-modal-btn');
const openSubmitModal = document.getElementById('open-submit-modal');
const submitResult   = document.getElementById('submit-result');
const filterBtns     = document.querySelectorAll('.filter-btn');
const gpuGrid        = document.getElementById('gpu-grid');
const gpuRefreshBtn  = document.getElementById('gpu-refresh-btn');
const clusterGrid    = document.getElementById('cluster-grid');
const poolTbody      = document.getElementById('pool-tbody');
const pagePrev       = document.getElementById('page-prev');
const pageNext       = document.getElementById('page-next');
const pageInfo       = document.getElementById('page-info');

// ─── API Helpers ─────────────────────────────────────────────

async function api(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── Rendering Helpers ───────────────────────────────────────

function statusBadge(status) {
  return `<span class="status-badge status-${status}">${status}</span>`;
}

function shortId(id) {
  return id ? id.slice(0, 8) : '—';
}

function formatElapsed(seconds) {
  if (seconds == null) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffH = diffMs / 3600000;
  if (diffH < 24) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/**
 * Parse tqdm progress from log text.
 * Matches: "Training:   5%|..| 22726/500000 [33:56<13:22:01, 9.92it/s, ...]"
 */
function parseTqdmProgress(logText) {
  if (!logText) return null;
  // Get last tqdm line (may be \r separated)
  const lines = logText.replace(/\r/g, '\n').split('\n').filter(l => l.includes('%|'));
  if (lines.length === 0) return null;
  const line = lines[lines.length - 1];
  const m = line.match(/(\d+)%\|.*?\|\s*([\d,]+)\/([\d,]+)\s*\[([^\]<]+)<([^\],]+)/);
  if (!m) return null;
  const pct = parseInt(m[1]);
  const step = parseInt(m[2].replace(/,/g, ''));
  const total = parseInt(m[3].replace(/,/g, ''));
  const eta = m[5].trim();
  return { pct, step, total, eta };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Parse SLURM elapsed string "D-HH:MM:SS" or "H:MM:SS" or "MM:SS" to seconds */
function parseElapsedStr(s) {
  if (!s) return null;
  let days = 0;
  if (s.includes('-')) { const [d, rest] = s.split('-'); days = parseInt(d, 10); s = rest; }
  const parts = s.split(':').map(Number);
  if (parts.length === 3) return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return days * 86400 + parts[0] * 60 + parts[1];
  return null;
}

// ─── Summary Rendering ───────────────────────────────────────

function renderSummary(data) {
  statRunning.textContent  = data.running  ?? 0;
  statPending.textContent  = data.pending  ?? 0;
  statCompleted.textContent= data.completed ?? 0;
  statFailed.textContent   = data.failed   ?? 0;
}

// ─── Chain Rendering ─────────────────────────────────────────

function getChainProgress(chain, jobs) {
  const chainJobIds = new Set(chain.jobIds || []);
  const chainJobs = jobs.filter(j => chainJobIds.has(j.id));
  const completed = chainJobs.filter(j => j.status === 'completed').length;
  const failed    = chainJobs.filter(j => j.status === 'failed' || j.status === 'timeout').length;
  const total     = chain.jobIds ? chain.jobIds.length : chainJobs.length;
  return { completed, failed, total };
}

function chainProgressColor(status) {
  if (status === 'completed') return '#3fb950';
  if (status === 'failed')    return '#f85149';
  if (status === 'running')   return '#58a6ff';
  return '#8b949e';
}

function renderChains(chains, jobs) {
  if (chains.length === 0) {
    chainsList.innerHTML = '<div class="empty-state">No chains yet. Submit a chain YAML to get started.</div>';
    return;
  }

  chainsList.innerHTML = chains.map(chain => {
    const { completed, failed, total } = getChainProgress(chain, jobs);
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    const fillColor = chainProgressColor(chain.status);
    const strategy = chain.spec?.strategy ?? 'unknown';
    const createdAgo = chain.createdAt ? formatTime(chain.createdAt) : '—';

    return `
      <div class="chain-card">
        <div class="chain-card-header">
          <span class="chain-card-title">${escapeHtml(chain.spec?.name ?? 'Unnamed Chain')}</span>
          ${statusBadge(chain.status)}
        </div>
        <div class="chain-card-meta">
          <code>${shortId(chain.id)}</code> &middot; ${strategy} &middot; ${total} job${total !== 1 ? 's' : ''} &middot; ${createdAgo}
        </div>
        <div class="chain-progress-bar">
          <div class="chain-progress-fill" style="width:${pct}%;background:${fillColor}"></div>
        </div>
        <div class="chain-progress-label">
          <span>${completed} completed${failed > 0 ? `, ${failed} failed` : ''}</span>
          <span>${pct}%</span>
        </div>
      </div>
    `;
  }).join('');
}

// ─── Job Table Rendering ─────────────────────────────────────

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'timeout', 'cancelled']);

// Status priority: active states first, then terminal by recency
const STATUS_PRIORITY = { running: 0, submitted: 1, pending: 2, unknown: 3, failed: 4, timeout: 5, completed: 6, cancelled: 7 };

function sortJobs(jobs) {
  return jobs.slice().sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status] ?? 9;
    const pb = STATUS_PRIORITY[b.status] ?? 9;
    if (pa !== pb) return pa - pb;
    // Same priority group: newest first
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });
}

let _lastSortedJobs = [];
let _lastJobsFingerprint = '';

function renderJobs(jobs) {
  _lastSortedJobs = sortJobs(jobs);
  const totalPages = Math.max(1, Math.ceil(_lastSortedJobs.length / PAGE_SIZE));
  if (currentPage >= totalPages) currentPage = totalPages - 1;

  // Skip full DOM rebuild if nothing changed (prevents flicker)
  const fp = _lastSortedJobs.map(j => `${j.id}:${j.status}:${j.node}:${j.elapsed}`).join('|');
  if (fp === _lastJobsFingerprint) {
    // Just update pagination text
    pagePrev.disabled = currentPage === 0;
    pageNext.disabled = currentPage >= totalPages - 1;
    pageInfo.textContent = `Page ${currentPage + 1} / ${totalPages}`;
    return;
  }
  _lastJobsFingerprint = fp;
  renderJobsPage();
}

function renderJobsPage() {
  const jobs = _lastSortedJobs;
  const totalPages = Math.max(1, Math.ceil(jobs.length / PAGE_SIZE));

  if (jobs.length === 0) {
    jobsTbody.innerHTML = `<tr><td colspan="10" class="empty-state">No jobs found.</td></tr>`;
    pagePrev.disabled = true;
    pageNext.disabled = true;
    pageInfo.textContent = 'Page 1 / 1';
    return;
  }

  const start = currentPage * PAGE_SIZE;
  const pageJobs = jobs.slice(start, start + PAGE_SIZE);

  pagePrev.disabled = currentPage === 0;
  pageNext.disabled = currentPage >= totalPages - 1;
  pageInfo.textContent = `Page ${currentPage + 1} / ${totalPages}`;

  jobsTbody.innerHTML = pageJobs.map(job => {
    const isSelected = job.id === selectedJobId ? ' selected' : '';
    const name   = escapeHtml(job.spec?.name ?? '—');
    const slurmId = job.slurmJobId ?? '—';
    const partition = job.executorType === 'workstation_ssh' ? 'ws' : (job.spec?.resources?.partition ?? '—');
    const node   = job.node ?? '—';
    const elapsed = formatElapsed(job.elapsed);
    const created = formatTime(job.createdAt);
    const canCancel = !TERMINAL_STATUSES.has(job.status);
    const cancelCell = canCancel
      ? `<button class="cancel-btn" onclick="cancelJob(event, '${job.id}', '${name}')">✕ Cancel</button>`
      : '';
    return `
      <tr class="${isSelected}" data-id="${job.id}" onclick="openLogs('${job.id}', '${name}', '${job.status}')">
        <td><code>${shortId(job.id)}</code></td>
        <td class="no-wrap dim">${slurmId}</td>
        <td>${name}</td>
        <td>${statusBadge(job.status)}</td>
        <td class="dim">${partition}</td>
        <td class="dim">${node}</td>
        <td class="no-wrap dim" id="prog-${job.id}">${progressCache[job.id] ? `${progressCache[job.id].percent}% ${progressCache[job.id].eta ? '(' + progressCache[job.id].eta + ')' : ''}` : '—'}</td>
        <td class="no-wrap">${elapsed}</td>
        <td class="dim no-wrap">${created}</td>
        <td>${cancelCell}</td>
      </tr>
    `;
  }).join('');
}

// Fetch and display progress for running jobs
async function updateProgress() {
  try {
    const data = await api('/api/progress');
    for (const [jobId, info] of Object.entries(data)) {
      const p = info?.progress;
      if (p) {
        progressCache[jobId] = p;
        const el = document.getElementById(`prog-${jobId}`);
        if (!el) continue;
        el.textContent = `${p.percent}% ${p.eta ? '(' + p.eta + ')' : ''}`;
        el.title = `${p.step.toLocaleString()} / ${p.total.toLocaleString()}`;
      }
    }
  } catch { /* ignore */ }
}

async function cancelJob(event, jobId, jobName) {
  event.stopPropagation(); // Don't open log panel
  if (!confirm(`Cancel job "${jobName}"?`)) return;
  try {
    const result = await api(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
    if (result.ok) {
      poll(); // Refresh immediately
    }
  } catch (err) {
    alert(`Cancel failed: ${err.message}`);
  }
}

// ─── Log Viewer ──────────────────────────────────────────────

async function openLogs(jobId, jobName, jobStatus) {
  // Update selection highlight
  document.querySelectorAll('#jobs-tbody tr').forEach(r => {
    r.classList.toggle('selected', r.dataset.id === jobId);
  });

  selectedJobId = jobId;
  logJobName.textContent = `${jobName} (${shortId(jobId)})`;
  logPanel.classList.remove('hidden');
  logStatus.textContent = `status: ${jobStatus}`;

  await refreshLogs();

  // Auto-poll while running
  if (logPollTimer) clearInterval(logPollTimer);
  if (jobStatus === 'running' || jobStatus === 'submitted') {
    logPollTimer = setInterval(refreshLogs, POLL_INTERVAL);
  }
}

async function refreshLogs() {
  if (!selectedJobId) return;
  try {
    const data = await api(`/api/jobs/${selectedJobId}/logs?tail=150`);
    logContent.textContent = data.logs ?? '(empty)';
    logContent.scrollTop = logContent.scrollHeight;
  } catch (err) {
    logContent.textContent = `(Failed to fetch logs: ${err.message})`;
  }
}

function closeLogs() {
  logPanel.classList.add('hidden');
  document.querySelectorAll('#jobs-tbody tr').forEach(r => r.classList.remove('selected'));
  selectedJobId = null;
  if (logPollTimer) { clearInterval(logPollTimer); logPollTimer = null; }
}

async function copyLogs() {
  const text = logContent.textContent;
  try {
    await navigator.clipboard.writeText(text);
    logCopyBtn.textContent = '✓ Copied';
    setTimeout(() => { logCopyBtn.textContent = '⎘ Copy'; }, 2000);
  } catch {
    logCopyBtn.textContent = '(failed)';
    setTimeout(() => { logCopyBtn.textContent = '⎘ Copy'; }, 2000);
  }
}

// ─── Submit Modal ────────────────────────────────────────────

async function handleSubmit() {
  const yaml = yamlEditor.value.trim();
  if (!yaml) return;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting...';
  submitResult.className = 'hidden';

  try {
    const result = await api('/api/submit', {
      method: 'POST',
      body: JSON.stringify({ yaml }),
    });
    submitResult.className = '';
    submitResult.style.background = 'rgba(63,185,80,0.1)';
    submitResult.style.border = '1px solid rgba(63,185,80,0.3)';
    submitResult.style.color = '#3fb950';
    submitResult.textContent = `✅ Submitted ${result.type}: ${shortId(result.id)} (${result.id})`;
    setTimeout(() => {
      submitModal.classList.add('hidden');
      submitResult.className = 'hidden';
      yamlEditor.value = '';
    }, 3000);
    poll(); // Refresh immediately
  } catch (err) {
    submitResult.className = '';
    submitResult.style.background = 'rgba(248,81,73,0.1)';
    submitResult.style.border = '1px solid rgba(248,81,73,0.3)';
    submitResult.style.color = '#f85149';
    submitResult.textContent = `❌ Error: ${err.message}`;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit';
  }
}

// ─── GPU Status Rendering ─────────────────────────────────────

/** Build a map of hostname → [{jobId, jobName}] from allJobsCache */
function getHostJobMap() {
  const map = {};
  for (const job of allJobsCache) {
    if (job.status !== 'running' && job.status !== 'submitted') continue;
    if (!job.slurmJobId) continue;
    // Workstation jobs: ws:<host>:<pid>
    if (job.slurmJobId.startsWith('ws:')) {
      const host = job.slurmJobId.split(':')[1];
      if (host) (map[host] = map[host] || []).push({ id: job.id, name: job.spec?.name ?? '?' });
    }
    // SLURM jobs: match by node field
    else if (job.node) {
      (map[job.node] = map[job.node] || []).push({ id: job.id, name: job.spec?.name ?? '?' });
    }
  }
  return map;
}

function scrollToJob(jobId, jobName) {
  const row = document.querySelector(`#jobs-tbody tr[data-id="${jobId}"]`);
  if (row) {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('highlight-flash');
    setTimeout(() => row.classList.remove('highlight-flash'), 1500);
    openLogs(jobId, jobName, row.querySelector('.status-badge')?.textContent ?? 'running');
  }
}

function renderGpuStatus(hosts) {
  if (!gpuGrid) return;
  if (!hosts || hosts.length === 0) {
    gpuGrid.innerHTML = '<div class="empty-state">No workstation hosts configured.</div>';
    return;
  }

  const hostJobs = getHostJobMap();

  gpuGrid.innerHTML = hosts.map(h => {
    const vramPct = h.totalVram > 0 ? Math.round((h.usedVram / h.totalVram) * 100) : 0;
    const utilPct = Math.min(h.gpuUtil, 100);
    const utilColor = utilPct > 80 ? 'var(--red)' : utilPct > 40 ? 'var(--yellow)' : 'var(--green)';
    const age = h.lastQueried ? Math.round((Date.now() - h.lastQueried) / 1000) : null;
    const stale = age !== null && age > 600; // >10min
    const cardClass = stale ? 'stale' : !h.reachable ? 'unreachable' : h.hasForeignProcess ? 'foreign' : h.available ? 'available' : 'busy';
    const statusLabel = !h.reachable ? 'unreachable' : h.hasForeignProcess ? 'foreign proc' : h.available ? 'available' : 'busy';
    const ageLabel = age === null ? '' : age < 60 ? `${age}s ago` : `${Math.round(age / 60)}m ago`;

    // Jobs running on this host
    const jobs = hostJobs[h.host] || [];
    const jobsHtml = jobs.length > 0
      ? `<div class="gpu-card-jobs">${jobs.map(j =>
          `<a class="gpu-job-link" href="#" onclick="event.preventDefault();scrollToJob('${j.id}','${escapeHtml(j.name)}')">${escapeHtml(j.name)}</a>`
        ).join('')}</div>`
      : '';

    return `
      <div class="gpu-card ${cardClass}">
        <div class="gpu-card-name">${escapeHtml(h.host)}</div>
        <div class="gpu-card-type">${escapeHtml(h.gpuType)}${ageLabel ? ' · <span class="gpu-age">' + ageLabel + '</span>' : ''}</div>
        <div class="gpu-bar-group">
          <div class="gpu-bar-label">VRAM</div>
          <div class="gpu-vram-bar"><div class="gpu-vram-fill" style="width:${vramPct}%"></div></div>
          <div class="gpu-bar-value">${h.usedVram}/${h.totalVram}G</div>
        </div>
        <div class="gpu-bar-group">
          <div class="gpu-bar-label">Util</div>
          <div class="gpu-vram-bar"><div class="gpu-vram-fill" style="width:${utilPct}%;background:${utilColor}"></div></div>
          <div class="gpu-bar-value">${h.gpuUtil}%</div>
        </div>
        ${jobsHtml}
        <div class="gpu-card-meta">
          <span>${statusLabel}</span>
        </div>
      </div>
    `;
  }).join('');
}

async function pollGpu() {
  try {
    const data = await api('/api/gpu-status');
    renderGpuStatus(data.hosts || []);
  } catch {
    if (gpuGrid) gpuGrid.innerHTML = '<div class="empty-state">GPU status unavailable</div>';
  }
  try {
    const cluster = await api('/api/cluster-status');
    renderClusterStatus(cluster);
  } catch {
    if (clusterGrid) clusterGrid.innerHTML = '<div class="empty-state">Cluster unavailable</div>';
  }
}

// ─── Cluster Rendering ──────────────────────────────────────────

function renderClusterStatus(data) {
  if (!clusterGrid) return;
  const nodes = data.nodes || [];
  const jobs = data.jobs || [];
  const gpuUsed = data.gpuUsedByNode || {};
  const otherJobs = data.otherJobsByNode || {};
  if (nodes.length === 0) {
    clusterGrid.innerHTML = '<div class="empty-state">No SLURM nodes found</div>';
    return;
  }

  // Build job map: node → [job names] (our jobs only)
  const jobMap = {};
  for (const j of jobs) {
    if (!j.node || j.node === '(None)') continue;
    for (const n of j.node.split(',')) {
      (jobMap[n] = jobMap[n] || []).push(j.name);
    }
  }

  // Deduplicate nodes — keep the entry with the most specific gpuType
  const bestNode = {};
  for (const n of nodes) {
    const prev = bestNode[n.name];
    if (!prev || (prev.gpuType === 'gpu' && n.gpuType !== 'gpu') || (prev.gpuCount === 0 && n.gpuCount > 0)) {
      bestNode[n.name] = n;
    }
  }
  const unique = Object.values(bestNode);

  // Compute free GPUs per node for sorting
  const freeGpus = (n) => Math.max(0, n.gpuCount - (gpuUsed[n.name] || 0));

  // Sort: most free GPUs first, then by state
  const stateOrder = { idle: 0, mixed: 1, allocated: 2, down: 3, drain: 4, drained: 4 };
  unique.sort((a, b) => {
    const fa = freeGpus(a), fb = freeGpus(b);
    if (fa !== fb) return fb - fa; // more free first
    return (stateOrder[a.state] ?? 3) - (stateOrder[b.state] ?? 3);
  });

  // Render summary by partition/gpuType
  const summaryEl = document.getElementById('cluster-summary');
  if (summaryEl) {
    const byType = {};
    for (const n of unique) {
      const t = n.gpuType;
      if (!byType[t]) byType[t] = { total: 0, free: 0 };
      byType[t].total += n.gpuCount;
      byType[t].free += freeGpus(n);
    }
    const parts = Object.entries(byType)
      .sort((a, b) => b[1].free - a[1].free)
      .map(([t, v]) => `${t}: <span class="${v.free > 0 ? 'gpu-free' : 'gpu-none'}">${v.free}</span>/${v.total}`)
      .join(' · ');
    summaryEl.innerHTML = `Free GPUs — ${parts}`;
  }

  clusterGrid.innerHTML = unique.map(n => {
    const stateClass = n.state.replace(/[*~#$]+/g, '').split(/[+]/)[0];
    const used = gpuUsed[n.name] || 0;
    const free = Math.max(0, n.gpuCount - used);
    const full = free === 0 && n.gpuCount > 0;
    const myJobs = jobMap[n.name];
    const jobHtml = myJobs ? `<div class="cluster-node-job">${myJobs.map(escapeHtml).join(', ')}</div>` : '';
    const othersCount = otherJobs[n.name] || 0;
    const othersHtml = othersCount > 0 ? `<div class="cluster-node-others">others ×${othersCount}</div>` : '';
    return `
      <div class="cluster-node ${stateClass}${full ? ' full' : ''}">
        <div class="cluster-node-name">${escapeHtml(n.name)}</div>
        <div class="cluster-node-meta">${escapeHtml(n.gpuType)}×${n.gpuCount} · <span class="${free > 0 ? 'gpu-free' : 'gpu-none'}">${free} free</span> · ${n.state}</div>
        ${jobHtml}
        ${othersHtml}
      </div>
    `;
  }).join('');
}

// ─── Pool Rendering ───────────────────────────────────────────

function renderPool(entries) {
  if (!poolTbody) return;
  if (!entries || entries.length === 0) {
    poolTbody.innerHTML = '<tr><td colspan="5" class="empty-state">Pool is empty</td></tr>';
    return;
  }

  poolTbody.innerHTML = entries.map(e => `
    <tr>
      <td>${e.priority}</td>
      <td>${escapeHtml(e.spec?.name ?? '—')}</td>
      <td class="dim">${escapeHtml(e.executorType)}</td>
      <td class="dim">${formatTime(e.addedAt)}</td>
      <td>
        <button class="prio-btn" onclick="bumpPriority('${e.id}', ${e.priority}, 10)">▲</button>
        <button class="prio-btn" onclick="bumpPriority('${e.id}', ${e.priority}, -10)">▼</button>
        <button class="cancel-btn" onclick="removeFromPool('${e.id}')">✕</button>
      </td>
    </tr>
  `).join('');
}

async function bumpPriority(poolId, current, delta) {
  try {
    await api(`/api/pool/${poolId}/priority`, {
      method: 'POST',
      body: JSON.stringify({ priority: current + delta }),
    });
    pollPool();
  } catch (err) {
    alert(`Failed: ${err.message}`);
  }
}

async function removeFromPool(poolId) {
  if (!confirm('Remove from pool?')) return;
  try {
    await api(`/api/pool/${poolId}`, { method: 'DELETE' });
    pollPool();
  } catch (err) {
    alert(`Failed: ${err.message}`);
  }
}

async function pollPool() {
  try {
    const data = await api('/api/pool');
    renderPool(data.entries || []);
  } catch {
    // pool not available — hide section
  }
}

// ─── Main Poll ───────────────────────────────────────────────

async function poll() {
  try {
    const statusParam = currentFilter !== 'all' ? `&status=${currentFilter}` : '';
    const [summaryData, jobsData, chainsData, clusterData] = await Promise.all([
      api('/api/summary'),
      api(`/api/jobs?limit=100${statusParam}`),
      api('/api/chains?limit=30'),
      api('/api/cluster-status').catch(() => ({ jobs: [] })),
    ]);

    allJobsCache   = jobsData.jobs   || [];
    allChainsCache = chainsData.chains || [];

    // Merge untracked SLURM jobs into the job list
    const trackedSlurmIds = new Set(allJobsCache.map(j => j.slurmJobId).filter(Boolean));
    const slurmJobs = (clusterData.jobs || [])
      .filter(sj => !trackedSlurmIds.has(sj.jobId))
      .map(sj => ({
        id: `slurm-${sj.jobId}`,
        slurmJobId: sj.jobId,
        spec: { name: sj.name, resources: { partition: sj.partition } },
        status: sj.state.toLowerCase() === 'running' ? 'running' : sj.state.toLowerCase(),
        node: sj.node,
        elapsed: parseElapsedStr(sj.elapsed),
        createdAt: null,
        _untracked: true,
      }));
    const mergedJobs = [...slurmJobs, ...allJobsCache];

    renderSummary(summaryData);
    renderJobs(mergedJobs);
    renderChains(allChainsCache, allJobsCache);
    pollPool();
    updateProgress();

    connectionStatus.textContent = '● live';
    connectionStatus.className = 'ok';
  } catch (err) {
    console.error('Poll failed:', err);
    connectionStatus.textContent = '● disconnected';
    connectionStatus.className = 'err';
  }
}

// ─── Event Listeners ─────────────────────────────────────────

logClose.addEventListener('click', closeLogs);
logRefreshBtn.addEventListener('click', refreshLogs);
logCopyBtn.addEventListener('click', copyLogs);

pagePrev.addEventListener('click', () => { if (currentPage > 0) { currentPage--; renderJobsPage(); } });
pageNext.addEventListener('click', () => { currentPage++; renderJobsPage(); });

filterBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    filterBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    currentPage = 0;
    poll();
  });
});

openSubmitModal.addEventListener('click', () => {
  submitResult.className = 'hidden';
  submitModal.classList.remove('hidden');
  yamlEditor.focus();
});
cancelModalBtn.addEventListener('click', () => submitModal.classList.add('hidden'));
submitBtn.addEventListener('click', handleSubmit);

submitModal.addEventListener('click', e => {
  if (e.target === submitModal) submitModal.classList.add('hidden');
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!submitModal.classList.contains('hidden')) {
      submitModal.classList.add('hidden');
    } else {
      closeLogs();
    }
  }
  // Ctrl/Cmd+Enter to submit in modal
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if (!submitModal.classList.contains('hidden')) {
      handleSubmit();
    }
  }
});

// ─── GPU refresh button ───────────────────────────────────────

if (gpuRefreshBtn) {
  gpuRefreshBtn.addEventListener('click', pollGpu);
}

// ─── Init ────────────────────────────────────────────────────

poll();
setInterval(poll, POLL_INTERVAL);

// GPU status — backend handles tiered caching, frontend polls every 60s
pollGpu();
gpuPollTimer = setInterval(pollGpu, 60000);
