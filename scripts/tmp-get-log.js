const { execSync } = require('child_process')

const raw = execSync('git credential fill', {
  input: 'protocol=https\nhost=github.com\n',
  encoding: 'utf8',
})
const token = raw
  .split('\n')
  .find((l) => l.startsWith('password='))
  ?.slice('password='.length)

const headers = {
  Authorization: 'Bearer ' + token,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'markforge-local',
}
const base = 'https://api.github.com/repos/ryansammm/MarkForge'

async function main() {
  const runs = await fetch(base + '/actions/runs?per_page=1', { headers }).then((r) => r.json())
  const run = runs.workflow_runs[0]
  console.log('run:', run.name, run.status, run.conclusion)
  const jobs = await fetch(run.jobs_url, { headers }).then((r) => r.json())
  const failed = jobs.jobs.find((j) => j.conclusion === 'failure') || jobs.jobs[0]
  console.log('job id:', failed.id)
  const res = await fetch(
    base + '/actions/jobs/' + failed.id + '/logs',
    { headers, redirect: 'follow' }
  )
  const text = await res.text()
  console.log('log length:', text.length)
  // Print everything after the last successful major milestone
  const lines = text.split(/\r?\n/)
  const startIdx = lines.findIndex((l) => l.includes('Build portable exe'))
  console.log(lines.slice(Math.max(0, lines.length - 45)).join('\n').slice(0, 4000))
}
main().catch((e) => console.error(String(e).slice(0, 300)))
