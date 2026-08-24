import { execSync } from 'node:child_process'

/**
 * Cek status workflow release + aset GitHub Releases tanpa membuka browser.
 * Memakai kredensial git yang tersimpan (sama dengan yang dipakai push).
 *
 * Pemakaian: node scripts/release-status.mjs
 */

const raw = execSync('git credential fill', {
  input: 'protocol=https\nhost=github.com\n',
  encoding: 'utf8',
})
const token = raw
  .split('\n')
  .find((l) => l.startsWith('password='))
  ?.slice('password='.length)

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'markforge-local',
}
const base = 'https://api.github.com/repos/ryansammm/MarkForge'

async function main() {
  const runs = await fetch(`${base}/actions/runs?per_page=3`, { headers }).then((r) => r.json())
  for (const r of runs.workflow_runs) {
    console.log(`${r.name} | ${r.head_sha.slice(0, 7)} | ${r.status} | ${r.conclusion ?? '-'}`)
  }

  const latest = runs.workflow_runs[0]
  if (latest.status !== 'completed') return

  const jobs = await fetch(latest.jobs_url, { headers }).then((r) => r.json())
  for (const job of jobs.jobs) {
    console.log(`job: ${job.name} -> ${job.conclusion}`)
    if (job.conclusion === 'failure') {
      for (const step of job.steps) {
        if (step.conclusion === 'failure') console.log('  STEP GAGAL:', step.name)
      }
      const log = await fetch(base + '/actions/jobs/' + job.id + '/logs', {
        headers,
        redirect: 'follow',
      }).then((r) => r.text())
      const errLines = log.split(/\r?\n/).filter((l) => /##\[error\]|npm error|Error:/i.test(l))
      console.log(errLines.slice(-8).join('\n').slice(0, 2000))
    }
  }

  if (latest.conclusion === 'success') {
    const rel = await fetch(base + '/releases/latest', { headers }).then((r) =>
      r.status === 404 ? null : r.json()
    )
    if (!rel) return console.log('(belum ada release)')
    console.log('RELEASE:', rel.name || rel.tag_name)
    for (const a of rel.assets) {
      console.log('  asset:', a.name, Math.round(a.size / 1024 / 1024) + ' MB')
    }
  }
}

main().catch((e) => console.error(String(e).slice(0, 300)))
