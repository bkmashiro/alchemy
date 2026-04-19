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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

function renderJobs(jobs) {
  if (jobs.length === 0) {
    jobsTbody.innerHTML = `<tr><td colspan="9" class="empty-state">No jobs found.</td></tr>`;
    return;
  }

  jobsTbody.innerHTML = jobs.map(job => {
    const isSelected = job.id === selectedJobId ? ' selected' : '';
    const name   = escapeHtml(job.spec?.name ?? '—');
    const slurmId = job.slurmJobId ?? '—';
    const partition = job.spec?.resources?.partition ?? '—';
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
        <td class="no-wrap">${elapsed}</td>
        <td class="dim no-wrap">${created}</td>
        <td>${cancelCell}</td>
      </tr>
    `;
  }).join('');
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

// ─── Main Poll ───────────────────────────────────────────────

async function poll() {
  try {
    const statusParam = currentFilter !== 'all' ? `&status=${currentFilter}` : '';
    const [summaryData, jobsData, chainsData] = await Promise.all([
      api('/api/summary'),
      api(`/api/jobs?limit=100${statusParam}`),
      api('/api/chains?limit=30'),
    ]);

    allJobsCache   = jobsData.jobs   || [];
    allChainsCache = chainsData.chains || [];

    renderSummary(summaryData);
    renderJobs(allJobsCache);
    renderChains(allChainsCache, allJobsCache);

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

filterBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    filterBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
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

// ─── Init ────────────────────────────────────────────────────

poll();
setInterval(poll, POLL_INTERVAL);
